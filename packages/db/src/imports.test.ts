import { describe, expect, it, vi } from "vitest";
import type { ContactRow } from "./audience.js";
import type { Queryable } from "./index.js";
import { assertImportRefs, createImport, dedupeByEmail, importBatch, importKey, presentImport } from "./imports.js";

function client(handler: (sql: string, params: unknown[]) => unknown[] = () => []) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const rows = handler(sql, params);
      return { rows, rowCount: rows.length };
    }) as unknown as Queryable["query"],
  };
}

const contact = (email: string, first_name: string | null = null) => ({ email, first_name, last_name: null, properties: {}, unsubscribed: false });
const stored = (email: string, overrides: Partial<ContactRow> & { deleted_at?: string | null } = {}): ContactRow & { deleted_at: string | null } => ({
  id: `contact_${email.split("@")[0]}`, email, first_name: null, last_name: null, properties: {},
  unsubscribed_at: null, created_at: "2026-10-01", updated_at: "2026-10-01", deleted_at: null, ...overrides,
});
const job = { id: "import_1", tenant_id: "tenant_1", on_conflict: "upsert" as const, segments: [], topics: [] };

function batchClient(options: {
  inserted?: ContactRow[]; prior?: ContactRow[]; updated?: ContactRow[];
  segments?: Array<{ contact_id: string; segment_id: string }>;
  receiving?: Array<{ contact_id: string; topic_id: string; receiving: boolean; eligible: boolean }>;
  topics?: Array<{ contact_id: string; topic_id: string; status: string }>;
  automations?: boolean;
} = {}) {
  return client((sql, params) => {
    if (sql.includes("insert into contacts (")) return options.inserted ?? [];
    if (sql.includes("deleted_at from contacts")) return options.prior ?? [];
    if (sql.includes("update contacts c set")) return options.updated ?? [];
    if (sql.includes("insert into segment_contacts")) return options.segments ?? [];
    if (sql.includes("c.id as contact_id, t.id as topic_id")) return options.receiving ?? [];
    if (sql.includes("insert into topic_subscriptions")) return options.topics ?? [];
    if (sql.includes("from automations") && options.automations) {
      const type = String(params[1]);
      const key = String(params[2]);
      const config = type === "topic_subscribed" ? { type, topic_id: key.split(":")[1] }
        : type === "segment_added" ? { type, segment_id: key.split(":")[1] } : { type };
      return [{ id: `automation_${type}`, trigger: key, trigger_type: type, reentry: "every_time",
        steps: [{ key: "start", type: "trigger", config }], connections: [] }];
    }
    if (sql.includes("select id from topics")) return [{ id: params[1] }];
    if (sql.includes("as type from segments")) return [{ type: "static" }];
    if (sql.includes("insert into custom_events")) return [{
      id: params[0], request_id: params[2], name: params[3], email: params[4], data: JSON.parse(params[5] as string), created_at: "2026-10-01",
    }];
    if (sql.includes("insert into automation_runs")) return [{ id: params[0] }];
    return [];
  });
}

describe("contact import queries", () => {
  it("presents counts with every key and builds the storage key", () => {
    expect(presentImport({ id: "import_1", status: "queued", counts: { total: 1 } as never, error: null, created_at: "2026-10-01", completed_at: null })).toEqual({
      object: "contact_import",
      id: "import_1",
      status: "queued",
      trigger_automations: false,
      counts: { total: 1, created: 0, updated: 0, skipped: 0, failed: 0 },
      error: null,
      created_at: "2026-10-01",
      completed_at: null,
    });
    expect(importKey("tenant_1", "import_1")).toBe("imports/tenant_1/import_1");
  });

  it("keeps the last row for each email", () => {
    const { rows, dropped } = dedupeByEmail([contact("a@x.com", "One"), contact("b@x.com"), contact("a@x.com", "Two")]);
    expect(rows.map((row) => [row.email, row.first_name])).toEqual([["b@x.com", null], ["a@x.com", "Two"]]);
    expect(dropped).toBe(1);
  });

  it("returns full rows and distinguishes inserts from updates using a locked prior row", async () => {
    const added = stored("a@x.com");
    const before = stored("b@x.com", { properties: { old: true }, unsubscribed_at: "2026-09-01" });
    const after = { ...before, first_name: "Bo", properties: { old: true, plan: "pro" } };
    const db = batchClient({ inserted: [added], prior: [before], updated: [after] });
    const result = await importBatch(db, job, [contact("a@x.com"), { ...contact("b@x.com", "Bo"), properties: { plan: "pro" } }]);
    expect(result).toEqual({
      created: 1, updated: 1, skipped: 0, ids: [added.id, after.id],
      rows: [
        { id: added.id, contact: added, created: true, segments_added: [], topics_subscribed: [] },
        { id: after.id, contact: after, created: false, segments_added: [], topics_subscribed: [] },
      ],
    });
    expect(db.queries[0].sql).toContain("on conflict do nothing");
    expect(db.queries[1].sql).toContain("order by email for update");
    expect(db.queries[1].params).toEqual(["tenant_1", ["b@x.com"]]);
    expect(db.queries[2].params).toEqual(["tenant_1", ["b@x.com"], ["Bo"], [null], ['{"plan":"pro"}'], [false], true]);
    expect(db.queries[2].sql).toContain("else c.properties || t.properties end");
    expect(db.queries[2].sql).toContain("coalesce(c.unsubscribed_at, case when t.unsubscribed then now() end)");
    expect(db.queries.some((query) => query.sql.includes("from automations"))).toBe(false);
    expect(db.queries.filter((query) => query.sql.includes("insert into contact_changes")).map((query) => query.params.slice(2, 7))).toContainEqual(
      [after.id, "plan", "null", '"pro"', "import_1"],
    );
  });

  it.each(["upsert", "skip"] as const)("counts a revival as created in %s mode and preserves its global opt-out", async (on_conflict) => {
    const before = stored("a@x.com", { first_name: "Old", properties: { stale: true }, deleted_at: "2026-09-01", unsubscribed_at: "2026-08-01" });
    const after = { ...before, first_name: null, properties: { plan: "new" }, deleted_at: null };
    const db = batchClient({ prior: [before], updated: [after], automations: true });
    const result = await importBatch(db, { ...job, on_conflict, trigger_automations: true }, [{ ...contact(before.email), properties: { plan: "new" } }]);
    expect(result).toMatchObject({ created: 1, updated: 0, skipped: 0, rows: [{ created: true, contact: after }] });
    expect(result.rows[0].contact.unsubscribed_at).toBe("2026-08-01");
    expect(db.queries[2].params[6]).toBe(on_conflict === "upsert");
    expect(db.queries[2].sql).toContain("when c.deleted_at is not null then t.properties");
    expect(db.queries[2].sql).toContain("($7::boolean or c.deleted_at is not null)");
    expect(db.queries.filter((query) => query.sql.includes("insert into custom_events")).map((query) => query.params[3])).toEqual(["@contact.created"]);
  });

  it("counts a conflicting live contact as skipped without changing history or memberships", async () => {
    const before = stored("a@x.com");
    const db = batchClient({ prior: [before] });
    expect(await importBatch(db, { ...job, on_conflict: "skip", trigger_automations: true,
      segments: [{ id: "segment_1" }], topics: [{ id: "topic_1", subscription: "opt_in" }] }, [contact(before.email, "Ignored")])).toEqual({
      created: 0, updated: 0, skipped: 1, ids: [], rows: [],
    });
    expect(db.queries[2].params[6]).toBe(false);
    expect(db.queries).toHaveLength(3);
  });

  it("does not query or trigger anything for an empty batch", async () => {
    const db = batchClient();
    expect(await importBatch(db, job, [])).toEqual({ created: 0, updated: 0, skipped: 0, ids: [], rows: [] });
    expect(db.queries).toEqual([]);
  });

  it("records neither history nor triggers for a no-op update even with automation entry enabled", async () => {
    const before = stored("a@x.com");
    const db = batchClient({ prior: [before], updated: [{ ...before, updated_at: "later" }], automations: true });
    const result = await importBatch(db, { ...job, trigger_automations: true }, [contact(before.email)]);
    expect(result).toMatchObject({ created: 0, updated: 1, rows: [{ created: false, segments_added: [], topics_subscribed: [] }] });
    expect(db.queries).toHaveLength(3);
  });

  it.each([undefined, false, true])("records update history but never fires contact_updated when import entry is %s", async (trigger_automations) => {
    const before = stored("a@x.com", { first_name: "Before" });
    const db = batchClient({ prior: [before], updated: [{ ...before, first_name: "After" }], automations: true });
    await importBatch(db, { ...job, trigger_automations }, [contact(before.email, "After")]);
    const history = db.queries.filter((query) => query.sql.includes("insert into contact_changes"));
    expect(history.map((query) => query.params.slice(2, 7))).toEqual([[before.id, "first_name", '"Before"', '"After"', "import_1"]]);
    expect(db.queries.some((query) => query.sql.includes("from automations"))).toBe(false);
  });

  it.each([false, true])("returns only actual segment and receiving-topic additions and gates bulk entry with %s", async (trigger_automations) => {
    const added = stored("a@x.com");
    const db = batchClient({
      inserted: [added],
      segments: [{ contact_id: added.id, segment_id: "segment_new" }],
      receiving: [
        { contact_id: added.id, topic_id: "topic_new", receiving: false, eligible: true },
        { contact_id: added.id, topic_id: "topic_default", receiving: true, eligible: true },
      ],
      topics: [
        { contact_id: added.id, topic_id: "topic_new", status: "subscribed" },
        { contact_id: added.id, topic_id: "topic_default", status: "subscribed" },
      ],
      automations: true,
    });
    const result = await importBatch(db, { ...job, trigger_automations,
      segments: [{ id: "segment_new" }, { id: "segment_existing" }, { id: "segment_new" }],
      topics: [{ id: "topic_new", subscription: "opt_in" }, { id: "topic_default", subscription: "opt_in" }] }, [contact(added.email)]);
    expect(result.rows).toEqual([{ id: added.id, contact: added, created: true,
      segments_added: ["segment_new"], topics_subscribed: ["topic_new"] }]);
    const history = db.queries.filter((query) => query.sql.includes("insert into contact_changes"));
    expect(history.map((query) => query.params[3])).toContain("segments.segment_new");
    expect(history.map((query) => query.params[3])).toContain("topics.topic_new");
    expect(history.map((query) => query.params[3])).not.toContain("topics.topic_default");
    const events = db.queries.filter((query) => query.sql.includes("insert into custom_events"));
    expect(events.map((query) => query.params[3])).toEqual(trigger_automations
      ? ["@contact.created", "@topic.subscribed:topic_new", "@segment.added:segment_new"] : []);
    const runs = db.queries.filter((query) => query.sql.includes("insert into automation_runs"));
    expect(runs).toHaveLength(trigger_automations ? 3 : 0);
    for (const run of runs) expect(run.params[4]).toBe("bulk");
    expect(db.queries.find((query) => query.sql.includes("insert into segment_contacts"))?.params[2]).toEqual(["segment_new", "segment_existing"]);
  });

  it("does not treat default receiving, preserved topic opt-outs, requested opt-outs, or global opt-outs as subscriptions", async () => {
    const before = stored("a@x.com");
    const globallyOut = stored("b@x.com", { unsubscribed_at: "2026-09-01" });
    const db = batchClient({
      prior: [before, globallyOut], updated: [before, globallyOut], automations: true,
      receiving: [
        { contact_id: before.id, topic_id: "default", receiving: true, eligible: true },
        { contact_id: before.id, topic_id: "preserved", receiving: false, eligible: true },
        { contact_id: before.id, topic_id: "opt_out", receiving: false, eligible: true },
        { contact_id: globallyOut.id, topic_id: "default", receiving: false, eligible: false },
      ],
      topics: [
        { contact_id: before.id, topic_id: "default", status: "subscribed" },
        { contact_id: before.id, topic_id: "opt_out", status: "unsubscribed" },
        { contact_id: globallyOut.id, topic_id: "default", status: "subscribed" },
      ],
    });
    const result = await importBatch(db, { ...job, trigger_automations: true,
      topics: [{ id: "default", subscription: "opt_in" }, { id: "preserved", subscription: "opt_in" }, { id: "opt_out", subscription: "opt_out" }] },
    [contact(before.email), contact(globallyOut.email)]);
    expect(result.rows.map((row) => row.topics_subscribed)).toEqual([[], []]);
    expect(db.queries.some((query) => query.sql.includes("from automations"))).toBe(false);
    expect(db.queries.find((query) => query.sql.includes("insert into topic_subscriptions"))?.sql).toContain(
      "where not (topic_subscriptions.status = 'unsubscribed' and excluded.status = 'subscribed')",
    );
  });

  it.each([
    [{}, undefined, false],
    [{ import_trigger_automations: true }, undefined, true],
    [{ import_trigger_automations: false }, undefined, false],
    [{ import_trigger_automations: true }, false, false],
    [{ import_trigger_automations: false }, true, true],
  ])("resolves and persists the import entry policy from %j with override %s", async (settings, triggerAutomations, expected) => {
    const db = client((sql, params) => sql.includes("select settings") ? [{ settings }]
      : sql.includes("insert into contact_imports") ? [{ id: params[0], trigger_automations: params[7] }] : []);
    const row = await createImport(db, { id: job.id, tenantId: job.tenant_id, storageKey: "key", columnMap: {},
      onConflict: "upsert", segments: [], topics: [], triggerAutomations });
    expect(row.trigger_automations).toBe(expected);
    const insert = db.queries.find((query) => query.sql.includes("insert into contact_imports"))!;
    expect(insert.params[7]).toBe(expected);
    expect(db.queries.filter((query) => query.sql.includes("select settings"))).toHaveLength(triggerAutomations === undefined ? 1 : 0);
    expect(presentImport({ ...row, status: "queued", counts: {} as never, error: null, created_at: "now", completed_at: null }).trigger_automations).toBe(expected);
  });

  it("rejects segments and topics that are not the tenant's", async () => {
    const db = client(() => [{ segments: 1, topics: 0 }]);
    await expect(assertImportRefs(db, "tenant_1", [{ id: "segment_1" }], [{ id: "topic_1" }])).rejects.toMatchObject({ statusCode: 404 });
    const none = client();
    await assertImportRefs(none, "tenant_1", [], []);
    expect(none.queries).toHaveLength(0);
  });
});
