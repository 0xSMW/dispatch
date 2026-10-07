import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ContactRow, Db, ImportRow } from "@dispatchmail/db";
import type { Rule } from "@dispatchmail/core";
import { mapRecord, resolveColumns, runImport, startImports } from "./imports.js";

type Query = { sql: string; params: unknown[] };
type ImportState = Pick<ImportRow, "status" | "counts"> & {
  row_offset: number;
  claim_version: number;
  events: string[];
  runs: string[];
  history: number;
};

// Full contact state is returned at each phase: inserts, locked conflict reads, and updates.
function fakeDb(existing: Array<string | (ContactRow & { deleted_at?: string | null })> = [], options: {
  definitions?: Array<{ key: string; type: string }>;
  segmentRule?: Rule | null;
  deadlocks?: number;
  deadlockOffset?: number;
  afterRollback?: (current: ImportState) => void;
} = {}) {
  const queries: Query[] = [];
  const row = (email: string, overrides: Partial<ContactRow> = {}): ContactRow & { deleted_at?: string | null } => ({
    id: `contact_${email}`, email, first_name: null, last_name: null, properties: {},
    unsubscribed_at: null, created_at: "2026-10-01", updated_at: "2026-10-01", ...overrides,
  });
  const known = new Map(existing.map((value) => typeof value === "string" ? [value, row(value)] : [value.email, value]));
  const current: ImportState = { status: "in_progress", row_offset: 0, claim_version: 0, counts: job().counts, events: [], runs: [], history: 0 };
  let snapshot: { known: typeof known; current: ImportState };
  let deadlocks = options.deadlocks ?? 0;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql === "begin") snapshot = structuredClone({ known, current });
    if (sql === "rollback") {
      known.clear();
      for (const [email, contact] of snapshot.known) known.set(email, contact);
      Object.assign(current, snapshot.current);
      options.afterRollback?.(current);
    }
    if (sql.includes("from contact_properties")) return { rows: options.definitions ?? [{ key: "seats", type: "number" }], rowCount: 1 };
    if (sql === "select id, rule from segments where tenant_id = $1 and id = $2 and deleted_at is null for update") {
      const rows = params.length === 2 && params[0] === "tenant_1" && params[1] === "segment_1"
        ? [{ id: "segment_1", rule: options.segmentRule ?? null }] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("insert into contacts")) {
      const emails = params[2] as string[];
      const ids = params[0] as string[];
      const rows = emails.flatMap((email, index) => {
        if (known.has(email)) return [];
        const inserted = row(email, { id: ids[index], first_name: (params[3] as Array<string | null>)[index],
          last_name: (params[4] as Array<string | null>)[index], properties: JSON.parse((params[5] as string[])[index]),
          unsubscribed_at: (params[6] as boolean[])[index] ? "2026-10-01" : null });
        known.set(email, inserted);
        return [inserted];
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("deleted_at from contacts")) {
      const rows = (params[1] as string[]).map((email) => known.get(email)!);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("update contacts c set")) {
      const rows = (params[1] as string[]).flatMap((email, index) => {
        const before = known.get(email)!;
        if (!params[6] && !before.deleted_at) return [];
        const first_name = (params[2] as Array<string | null>)[index];
        const last_name = (params[3] as Array<string | null>)[index];
        const properties = JSON.parse((params[4] as string[])[index]);
        const updated = { ...before,
          first_name: before.deleted_at ? first_name : first_name ?? before.first_name,
          last_name: before.deleted_at ? last_name : last_name ?? before.last_name,
          properties: before.deleted_at ? properties : { ...before.properties, ...properties },
          unsubscribed_at: before.unsubscribed_at ?? ((params[5] as boolean[])[index] ? "2026-10-01" : null),
          deleted_at: null, updated_at: "2026-10-02" };
        known.set(email, updated);
        return [updated];
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("from automations")) {
      return { rows: [{ id: "automation_1", trigger: "@contact.created", trigger_type: "contact_created", reentry: "once",
        steps: [{ key: "start", type: "trigger", config: { type: "contact_created" } }], connections: [] }] };
    }
    if (sql.includes("insert into contact_changes")) current.history += 1;
    if (sql.includes("insert into custom_events")) {
      current.events.push(String(params[4]));
      return { rows: [{
        id: params[0], request_id: params[2], name: params[3], email: params[4], data: JSON.parse(params[5] as string), created_at: "2026-10-01",
      }] };
    }
    if (sql.includes("insert into automation_enrollments")) return { rows: [{ contact_id: params[2] }] };
    if (sql.includes("insert into automation_runs")) {
      current.runs.push(String(params[0]));
      return { rows: [{ id: params[0] }] };
    }
    if (sql.includes("from contact_imports") && sql.includes("skip locked")) {
      return { rows: [job()], rowCount: 1 };
    }
    if (sql.startsWith("select status, row_offset, claim_version from contact_imports")) {
      return { rows: [{ ...current }], rowCount: 1 };
    }
    if (sql.includes("update contact_imports set status = 'in_progress'")) {
      return { rows: [job()], rowCount: 1 };
    }
    if (sql.startsWith("update contact_imports set counts")) {
      if ((options.deadlockOffset === undefined || options.deadlockOffset === params[2]) && deadlocks-- > 0) {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }
      current.counts = JSON.parse(params[1] as string);
      current.row_offset = Number(params[2]);
    }
    if (sql.includes("set status = $2")) current.status = params[1] as ImportRow["status"];
    if (sql.includes("set status = 'queued'")) current.status = "queued";
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const db = { query, connect: vi.fn(async () => client) } as unknown as Db;
  return { db, queries, known, current, query, release: client.release };
}

function job(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    id: "import_1",
    tenant_id: "tenant_1",
    status: "in_progress",
    storage_key: "imports/tenant_1/import_1",
    column_map: {},
    on_conflict: "upsert",
    segments: [],
    topics: [],
    trigger_automations: false,
    counts: { total: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
    error: null,
    created_at: "2026-10-01T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function storage(csv: string) {
  return { stream: vi.fn(async () => Readable.from([csv])) };
}

const savedCounts = (queries: Query[]) =>
  queries.filter((query) => query.sql.startsWith("update contact_imports set counts")).map((query) => JSON.parse(query.params[1] as string));

describe("contact import", () => {
  it("retries only the aborted batch, committing counts, history and enrollment once without reopening the stream", async () => {
    const { db, queries, current, known, release } = fakeDb([], { deadlocks: 1, deadlockOffset: 2 });
    const source = storage("email\na@example.com\nb@example.com");
    const counts = await runImport(db, source, job({ trigger_automations: true }), { batchSize: 1 });
    expect(counts).toEqual({ total: 2, created: 2, updated: 0, skipped: 0, failed: 0 });
    expect(current).toMatchObject({ status: "completed", row_offset: 2, counts, events: ["a@example.com", "b@example.com"] });
    expect(current.runs).toHaveLength(2);
    expect(current.history).toBe(4);
    expect([...known.keys()]).toEqual(["a@example.com", "b@example.com"]);
    expect(source.stream).toHaveBeenCalledTimes(1);
    expect(queries.filter((query) => query.sql.includes("from contact_properties"))).toHaveLength(1);
    expect(queries.filter((query) => query.sql.includes("insert into contacts")).map((query) => query.params[2])).toEqual([
      ["a@example.com"], ["b@example.com"], ["b@example.com"],
    ]);
    expect(queries.filter((query) => ["begin", "rollback", "commit"].includes(query.sql)).map((query) => query.sql)).toEqual([
      "begin", "commit", "begin", "rollback", "begin", "commit", "begin", "commit",
    ]);
    expect(release).toHaveBeenCalledTimes(4);
  });

  it("leaves exhausted deadlocks in progress with only prior committed progress, then resumes without duplicate entry", async () => {
    const { db, queries, current, known, release } = fakeDb([], { deadlocks: 4, deadlockOffset: 2 });
    const source = storage("email\na@example.com\nb@example.com");
    const counts = await runImport(db, source, job({ trigger_automations: true }), { batchSize: 1 });
    expect(counts).toMatchObject({ created: 1, updated: 0, skipped: 0 });
    expect(current).toMatchObject({
      status: "in_progress", row_offset: 1, counts: { total: 1, created: 1, updated: 0, skipped: 0, failed: 0 },
      events: ["a@example.com"],
    });
    expect(current.runs).toHaveLength(1);
    expect(current.history).toBe(2);
    expect([...known.keys()]).toEqual(["a@example.com"]);
    expect(source.stream).toHaveBeenCalledTimes(1);
    expect(queries.filter((query) => query.sql === "rollback")).toHaveLength(4);
    expect(queries.some((query) => query.sql.includes("set status = $2") || query.sql.includes("set status = 'queued'"))).toBe(false);
    expect(release).toHaveBeenCalledTimes(5);

    const resumed = await runImport(db, source, job({ trigger_automations: true, row_offset: current.row_offset, counts: current.counts }), { batchSize: 1 });
    expect(resumed).toEqual({ total: 2, created: 2, updated: 0, skipped: 0, failed: 0 });
    expect(current.status).toBe("completed");
    expect(current.events).toEqual(["a@example.com", "b@example.com"]);
    expect(current.runs).toHaveLength(2);
  });

  it.each([
    ["cancelled", 1], ["cancelled", 4], ["failed", 1], ["completed", 1], ["queued", 1],
  ] as const)("does not revive or fail a concurrently %s import after %s deadlocks", async (status, deadlocks) => {
    let rolledBack = 0;
    const { db, queries, current, known } = fakeDb([], {
      deadlocks,
      afterRollback: (current) => {
        if (++rolledBack === deadlocks) current.status = status;
      },
    });
    await runImport(db, storage("email\na@example.com"), job({ trigger_automations: true }), { batchSize: 1, maxRows: 1 });
    expect(current.status).toBe(status);
    expect(known.size).toBe(0);
    expect(current.events).toEqual([]);
    expect(current.runs).toEqual([]);
    expect(queries.some((query) => query.sql.includes("set status = $2") || query.sql.includes("set status = 'queued'"))).toBe(false);
  });

  it("rechecks claim ownership before retrying an aborted batch", async () => {
    const { db, queries, current, known } = fakeDb([], {
      deadlocks: 1, afterRollback: (current) => { current.claim_version = 1; },
    });
    await runImport(db, storage("email\na@example.com"), job({ claim_version: 0, trigger_automations: true }));
    expect(current).toMatchObject({ status: "in_progress", claim_version: 1, row_offset: 0 });
    expect(known.size).toBe(0);
    expect(queries.filter((query) => query.sql.includes("insert into contacts"))).toHaveLength(1);
    expect(queries.some((query) => query.sql.includes("set status = $2"))).toBe(false);
  });

  it("does not replay a batch whose offset was committed by another worker during rollback", async () => {
    const { db, queries, current, known } = fakeDb([], {
      deadlocks: 1, afterRollback: (current) => { current.row_offset = 1; },
    });
    await runImport(db, storage("email\na@example.com"), job({ trigger_automations: true }), { batchSize: 1 });
    expect(current).toMatchObject({ status: "in_progress", row_offset: 1 });
    expect(known.size).toBe(0);
    expect(queries.filter((query) => query.sql.includes("insert into contacts"))).toHaveLength(1);
    expect(queries.some((query) => query.sql.includes("set status = $2"))).toBe(false);
  });

  it("does not retry completion or mark a committed batch failed when completion deadlocks", async () => {
    const { db, query, queries, current, known } = fakeDb();
    const execute = query.getMockImplementation()!;
    query.mockImplementation(async (sql, params = []) => {
      if (sql.includes("set status = $2")) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return execute(sql, params);
    });
    const source = storage("email\na@example.com");
    await runImport(db, source, job());
    expect(query.mock.calls.filter(([sql]) => sql.includes("set status = $2"))).toHaveLength(1);
    expect(current).toMatchObject({ status: "in_progress", row_offset: 1, counts: { created: 1 } });
    expect([...known.keys()]).toEqual(["a@example.com"]);
    expect(queries.filter((query) => query.sql.includes("insert into contacts"))).toHaveLength(1);
    expect(source.stream).toHaveBeenCalledTimes(1);
  });

  it("keeps genuine database errors terminal without replaying the batch", async () => {
    const { db, query, queries, current, known } = fakeDb();
    const execute = query.getMockImplementation()!;
    query.mockImplementation(async (sql, params = []) => {
      if (sql.startsWith("update contact_imports set counts")) throw Object.assign(new Error("constraint failed"), { code: "23514" });
      return execute(sql, params);
    });
    await runImport(db, storage("email\na@example.com"), job());
    expect(current.status).toBe("failed");
    expect(known.size).toBe(0);
    expect(queries.filter((query) => query.sql.includes("insert into contacts"))).toHaveLength(1);
    expect(queries.find((query) => query.sql.includes("set status = $2"))?.params.slice(1, 4)).toEqual([
      "failed", JSON.stringify({ total: 1, created: 0, updated: 0, skipped: 0, failed: 0 }), "constraint failed",
    ]);
  });

  it("imports typed booleans and dates and counts invalid nonempty cells as row errors", async () => {
    const { db, queries } = fakeDb([], { definitions: [{ key: "activated", type: "boolean" }, { key: "last_active_at", type: "date" }] });
    const csv = [
      "email,activated,last_active_at",
      "a@example.com,TRUE,2026-10-03",
      "b@example.com,No,2026-10-03T09:30:00+02:00",
      "c@example.com,maybe,2026-10-03",
      "d@example.com,false,2026-02-30",
      "e@example.com,,",
    ].join("\n");
    const counts = await runImport(db, storage(csv), job({ column_map: { properties: {
      activated: { column: "activated", type: "string" },
      last_active_at: { column: "last_active_at", type: "string" },
    } } }));
    expect(counts).toEqual({ total: 5, created: 3, updated: 0, skipped: 0, failed: 2 });
    const insert = queries.find((query) => query.sql.includes("insert into contacts"))!;
    expect(insert.params[2]).toEqual(["a@example.com", "b@example.com", "e@example.com"]);
    expect(insert.params[5]).toEqual([
      JSON.stringify({ activated: true, last_active_at: "2026-10-03" }),
      JSON.stringify({ activated: false, last_active_at: "2026-10-03T09:30:00+02:00" }),
      "{}",
    ]);
    expect(queries.find((query) => query.sql.includes("set status = $2"))?.params[1]).toBe("completed");
  });
  it("upserts in batches and writes counts using inserted and locked conflicting rows", async () => {
    const { db, queries } = fakeDb(["b@example.com"]);
    const csv = ["Email,First Name,seats", "a@example.com,Ada,3", "b@example.com,Bo,", "c@example.com,Cy,4", "not-an-email,Dee,1", "d@example.com,,2"].join("\n");
    const counts = await runImport(db, storage(csv), job({ column_map: { properties: { seats: { column: "seats" } } } }), { batchSize: 2 });

    expect(counts).toEqual({ total: 5, created: 3, updated: 1, skipped: 0, failed: 1 });
    const inserts = queries.filter((query) => query.sql.includes("insert into contacts"));
    expect(inserts.map((query) => query.params[2])).toEqual([["a@example.com", "b@example.com"], ["c@example.com", "d@example.com"]]);
    expect(inserts[0].sql).toContain("on conflict do nothing");
    expect(queries.find((query) => query.sql.includes("deleted_at from contacts"))?.params).toEqual(["tenant_1", ["b@example.com"]]);
    expect(inserts[0].params[5]).toEqual([JSON.stringify({ seats: 3 }), JSON.stringify({})]);
    expect(savedCounts(queries)).toEqual([
      { total: 2, created: 1, updated: 1, skipped: 0, failed: 0 },
      { total: 5, created: 3, updated: 1, skipped: 0, failed: 1 },
    ]);
    const finish = queries.find((query) => query.sql.includes("set status = $2"));
    expect(finish?.params.slice(0, 2)).toEqual(["import_1", "completed"]);
    expect(queries.some((query) => query.sql.includes("email_events") || query.sql.includes("webhook_attempts"))).toBe(false);
  });

  it("picks up after a worker that stopped, without writing or recounting the rows it had committed", async () => {
    // The first worker committed two rows (one created, one updated), then stopped.
    const { db, queries } = fakeDb();
    const csv = ["email", "a@example.com", "b@example.com", "not-an-email", "c@example.com", "d@example.com"].join("\n");
    const resumed = job({ row_offset: 2, counts: { total: 2, created: 1, updated: 1, skipped: 0, failed: 0 } });
    const counts = await runImport(db, storage(csv), resumed, { batchSize: 2 });

    const inserts = queries.filter((query) => query.sql.includes("insert into contacts"));
    expect(inserts.map((query) => query.params[2])).toEqual([["c@example.com", "d@example.com"]]);
    // Total and failed cover the whole file. Created and updated carry on from what was saved.
    expect(counts).toEqual({ total: 5, created: 3, updated: 1, skipped: 0, failed: 1 });
    const saved = queries.filter((query) => query.sql.startsWith("update contact_imports set counts"));
    expect(saved.at(-1)?.params[2]).toBe(5);
  });

  it("dedupes a batch by email so the last row wins and the earlier row counts as skipped", async () => {
    const { db, queries } = fakeDb();
    const csv = ["email,first_name", "a@example.com,First", "a@example.com,Second"].join("\n");
    const counts = await runImport(db, storage(csv), job());
    const insert = queries.find((query) => query.sql.includes("insert into contacts"))!;
    expect(insert.params[2]).toEqual(["a@example.com"]);
    expect(insert.params[3]).toEqual(["Second"]);
    expect(counts).toEqual({ total: 2, created: 1, updated: 0, skipped: 1, failed: 0 });
  });

  it("honors skip by leaving a live contact alone and counting the missing rows as skipped", async () => {
    const { db, queries } = fakeDb(["a@example.com"]);
    const csv = ["email", "a@example.com", "b@example.com"].join("\n");
    const counts = await runImport(db, storage(csv), job({ on_conflict: "skip" }));
    // Only a deleted contact is written over. A live one is left as it is.
    const update = queries.find((query) => query.sql.includes("update contacts c set"))!;
    expect(update.sql).toContain("($7::boolean or c.deleted_at is not null)");
    expect(update.params[6]).toBe(false);
    expect(counts).toEqual({ total: 2, created: 1, updated: 0, skipped: 1, failed: 0 });
  });

  it("adds imported contacts to segments and topics", async () => {
    const { db, queries, current } = fakeDb();
    const csv = ["email", "a@example.com"].join("\n");
    const counts = await runImport(db, storage(csv), job({ segments: [{ id: "segment_1" }], topics: [{ id: "topic_1", subscription: "opt_out" }] }));
    expect(counts).toEqual({ total: 1, created: 1, updated: 0, skipped: 0, failed: 0 });
    expect(current.status).toBe("completed");
    const lock = queries.findIndex((query) => query.sql === "select id, rule from segments where tenant_id = $1 and id = $2 and deleted_at is null for update");
    expect(lock).toBeGreaterThan(-1);
    expect(queries[lock].params).toEqual(["tenant_1", "segment_1"]);
    expect(lock).toBeLessThan(queries.findIndex((query) => query.sql.includes("insert into contacts")));
    const segment = queries.find((query) => query.sql.includes("insert into segment_contacts"))!;
    expect(segment.params[2]).toEqual(["segment_1"]);
    const topic = queries.find((query) => query.sql.includes("insert into topic_subscriptions"))!;
    expect(topic.params[4]).toEqual(["unsubscribed"]);
    // An existing opt-out is never turned back into an opt-in by an import.
    expect(topic.sql).toContain("where not (topic_subscriptions.status = 'unsubscribed' and excluded.status = 'subscribed')");
  });

  it.each([
    { tenantId: "tenant_1", segmentId: "missing", rule: null, error: "Segment not found" },
    { tenantId: "other_tenant", segmentId: "segment_1", rule: null, error: "Segment not found" },
    { tenantId: "tenant_1", segmentId: "segment_1", rule: { type: "rule", field: "contact.email", operator: "eq", value: "a@example.com" } as Rule,
      error: "Dynamic segments do not accept membership writes" },
  ])("fails an import with an invalid segment target $tenantId/$segmentId ($error) before audience writes", async ({ tenantId, segmentId, rule, error }) => {
    const { db, queries, current, known } = fakeDb([], { segmentRule: rule });
    await runImport(db, storage("email\na@example.com"), job({
      tenant_id: tenantId, segments: [{ id: segmentId }], topics: [{ id: "topic_1", subscription: "opt_in" }], trigger_automations: true,
    }));
    expect(current.status).toBe("failed");
    const finish = queries.find((query) => query.sql.includes("set status = $2"))!;
    expect(finish.params[3]).toBe(error);
    expect(known.size).toBe(0);
    expect(queries.filter((query) => /^\s*(insert|update|delete)\b/i.test(query.sql) && !query.sql.includes("contact_imports"))).toEqual([]);
    expect(savedCounts(queries)).toEqual([]);
  });

  it.each([false, true])("records imported contact history and gates bulk entry using the persisted flag %s", async (trigger_automations) => {
    const { db, queries } = fakeDb();
    const counts = await runImport(db, storage("email,first_name\na@example.com,Ada"), job({ trigger_automations }));
    expect(counts).toEqual({ total: 1, created: 1, updated: 0, skipped: 0, failed: 0 });
    const history = queries.filter((query) => query.sql.includes("insert into contact_changes"));
    expect(history.map((query) => query.params[3])).toContain("first_name");
    expect(history.every((query) => query.params[6] === "import_1")).toBe(true);
    const events = queries.filter((query) => query.sql.includes("insert into custom_events"));
    expect(events.map((query) => query.params[3])).toEqual(trigger_automations ? ["@contact.created"] : []);
    const runs = queries.filter((query) => query.sql.includes("insert into automation_runs"));
    expect(runs.map((query) => query.params[4])).toEqual(trigger_automations ? ["bulk"] : []);
    const commit = queries.findIndex((query) => query.sql === "commit");
    const saved = queries.findIndex((query) => query.sql.startsWith("update contact_imports set counts"));
    expect(saved).toBeLessThan(commit);
    for (const run of runs) expect(queries.indexOf(run)).toBeLessThan(saved);
  });

  it.each(["upsert", "skip"] as const)("revives a deleted contact as created in %s mode without restoring old data or consent", async (on_conflict) => {
    const deleted = { id: "contact_deleted", email: "a@example.com", first_name: "Old", last_name: "Name",
      properties: { old: true }, deleted_at: "2026-09-01", unsubscribed_at: "2026-08-01",
      created_at: "2026-07-01", updated_at: "2026-09-01" };
    const { db, queries, known } = fakeDb([deleted]);
    const counts = await runImport(db, storage("email,first_name,seats\na@example.com,New,3"), job({
      on_conflict, trigger_automations: true, column_map: { properties: { seats: { column: "seats" } } },
    }));
    expect(counts).toEqual({ total: 1, created: 1, updated: 0, skipped: 0, failed: 0 });
    expect(known.get(deleted.email)).toMatchObject({ id: deleted.id, first_name: "New", last_name: null,
      properties: { seats: 3 }, unsubscribed_at: deleted.unsubscribed_at, deleted_at: null });
    expect(queries.filter((query) => query.sql.includes("insert into custom_events")).map((query) => query.params[3])).toEqual(["@contact.created"]);
  });

  it("does not re-enroll committed contacts when resuming an import with entry enabled", async () => {
    const { db, queries } = fakeDb(["a@example.com"]);
    const counts = await runImport(db, storage("email\na@example.com\nb@example.com"), job({
      trigger_automations: true, row_offset: 1, counts: { total: 1, created: 1, updated: 0, skipped: 0, failed: 0 },
    }));
    expect(counts).toEqual({ total: 2, created: 2, updated: 0, skipped: 0, failed: 0 });
    expect(queries.filter((query) => query.sql.includes("insert into custom_events")).map((query) => query.params[4])).toEqual(["b@example.com"]);
  });

  it("fails an import whose file has an unclosed quote or two columns of one name", async () => {
    const quoted = fakeDb();
    await runImport(quoted.db, storage(["email", "a@example.com", '"b@example.com', "c@example.com", "d@example.com"].join("\n")), job());
    const finish = quoted.queries.find((query) => query.sql.includes("set status = $2"))!;
    expect(finish.params[1]).toBe("failed");
    expect(String(finish.params[3])).toContain("quote that is never closed");

    const doubled = fakeDb();
    await runImport(doubled.db, storage("email,Email\na@example.com,b@example.com"), job());
    const refused = doubled.queries.find((query) => query.sql.includes("set status = $2"))!;
    expect(refused.params[1]).toBe("failed");
    expect(refused.params[3]).toBe('The CSV has two columns named "Email"');
  });

  it("lowercases addresses, so one mailbox in two cases is one contact", async () => {
    const { db, queries } = fakeDb();
    const counts = await runImport(db, storage(["email", "Bob@X.com", "bob@x.com"].join("\n")), job());
    const insert = queries.find((query) => query.sql.includes("insert into contacts"))!;
    expect(insert.params[2]).toEqual(["bob@x.com"]);
    expect(counts).toMatchObject({ total: 2, created: 1, skipped: 1 });
  });

  it("fails the import when the header has no email column", async () => {
    const { db, queries } = fakeDb();
    await runImport(db, storage("name\nAda"), job());
    const finish = queries.find((query) => query.sql.includes("set status = $2"))!;
    expect(finish.params[1]).toBe("failed");
    expect(finish.params[3]).toBe("The CSV has no email column");
  });

  it("claims queued imports with skip locked and starts them in the background", async () => {
    const { db, queries } = fakeDb();
    const state = { count: 0 };
    const started = await startImports(db, storage("email\na@example.com"), state, 1);
    expect(started).toBe(1);
    expect(queries.find((query) => query.sql.includes("for update skip locked"))?.params).toEqual([1]);
    expect(queries.some((query) => query.sql.includes("status = 'in_progress'"))).toBe(true);
    expect(await startImports(db, storage(""), state, 1)).toBe(0);
    await vi.waitFor(() => expect(state.count).toBe(0));
  });
});

describe("column mapping", () => {
  it.each([["true", true], ["TRUE", true], ["Yes", true], ["1", true], ["false", false], ["FALSE", false], ["No", false], ["0", false]])("reads boolean property token %s as %s", (raw, value) => {
    const columns = { email: "email", properties: [{ key: "activated", column: "flag", type: "boolean" as const }] };
    expect(mapRecord({ email: "a@example.com", flag: ` ${raw} ` }, columns)?.properties).toEqual({ activated: value });
  });

  it.each(["y", "n", "unsubscribed", "on", "off", "maybe", "2"])("rejects nonempty boolean property token %s", (raw) => {
    expect(mapRecord({ email: "a@example.com", flag: raw }, { email: "email", properties: [{ key: "flag", column: "flag", type: "boolean" }] })).toBeNull();
  });

  it("keeps valid ISO strings, skips empty cells, and accepts date mappings without a definition", () => {
    const columns = resolveColumns(["email", "when", "flag"], { properties: { when: { column: "when", type: "date" }, flag: { column: "flag", type: "boolean" } } }, []);
    for (const when of ["2024-02-29", "2026-10-03T09:30:00.123Z", "2026-10-03T09:30:00-05:00"]) {
      expect(mapRecord({ email: "a@example.com", when, flag: "" }, columns)?.properties).toEqual({ when });
    }
    expect(mapRecord({ email: "a@example.com", when: "", flag: "" }, columns)?.properties).toEqual({});
    for (const when of ["2025-02-29", "October 3, 2026", "2026-10-03T09:30:00", "123"]) {
      expect(mapRecord({ email: "a@example.com", when }, columns)).toBeNull();
    }
    // The consent flag keeps its established permissive parsing.
    expect(mapRecord({ email: "a@example.com", unsub: "unsubscribed" }, { email: "email", unsubscribed: "unsub", properties: [] })?.unsubscribed).toBe(true);
  });
  it("maps by header name case-insensitively and lets the definition type win", () => {
    const columns = resolveColumns(["EMAIL", "Plan"], { properties: { plan: { column: "plan", type: "string" } } }, [{ key: "plan", type: "number" }]);
    expect(columns.email).toBe("EMAIL");
    expect(columns.properties).toEqual([{ key: "plan", column: "Plan", type: "number" }]);
    expect(() => resolveColumns(["email"], { first_name: { column: "given" } }, [])).toThrow('Column "given"');
    // A field left out is found by its usual header. A field set to null is not imported.
    const header = ["email", "first_name", "last_name", "unsubscribed"];
    expect(resolveColumns(header, {}, [])).toMatchObject({ first_name: "first_name", last_name: "last_name", unsubscribed: "unsubscribed" });
    expect(resolveColumns(header, { first_name: null, unsubscribed: null }, [])).toMatchObject({
      first_name: undefined,
      last_name: "last_name",
      unsubscribed: undefined,
    });
  });

  it("fails a row with a bad number and reads unsubscribed as a flag", () => {
    const columns = { email: "email", unsubscribed: "unsub", properties: [{ key: "seats", column: "seats", type: "number" as const }] };
    expect(mapRecord({ email: "a@example.com", seats: "many" }, columns)).toBeNull();
    expect(mapRecord({ email: "a@example.com", seats: "2", unsub: "Yes" }, columns)).toMatchObject({ properties: { seats: 2 }, unsubscribed: true, first_name: null });
  });
});
