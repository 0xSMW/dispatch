import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Db, ImportRow } from "@dispatchmail/db";
import { mapRecord, resolveColumns, runImport, startImports } from "./imports.js";

type Query = { sql: string; params: unknown[] };

// A fake pool: contacts that already exist come back with created = false, like xmax <> 0.
function fakeDb(existing: string[] = [], options: { skip?: boolean; definitions?: Array<{ key: string; type: string }> } = {}) {
  const queries: Query[] = [];
  const known = new Set(existing);
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes("from contact_properties")) return { rows: options.definitions ?? [{ key: "seats", type: "number" }], rowCount: 1 };
    if (sql.includes("insert into contacts")) {
      const emails = params[2] as string[];
      const ids = params[0] as string[];
      const rows = emails.flatMap((email, index) => {
        const created = !known.has(email);
        known.add(email);
        if (!created && options.skip) return [];
        return [{ id: ids[index], created }];
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("from contact_imports") && sql.includes("skip locked")) {
      return { rows: [job()], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const db = { query, connect: vi.fn(async () => client) } as unknown as Db;
  return { db, queries };
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
  it("upserts in batches, writes counts after each batch, and counts created and updated from xmax", async () => {
    const { db, queries } = fakeDb(["b@example.com"]);
    const csv = ["Email,First Name,seats", "a@example.com,Ada,3", "b@example.com,Bo,", "c@example.com,Cy,4", "not-an-email,Dee,1", "d@example.com,,2"].join("\n");
    const counts = await runImport(db, storage(csv), job({ column_map: { properties: { seats: { column: "seats" } } } }), { batchSize: 2 });

    expect(counts).toEqual({ total: 5, created: 3, updated: 1, skipped: 0, failed: 1 });
    const inserts = queries.filter((query) => query.sql.includes("insert into contacts"));
    expect(inserts.map((query) => query.params[2])).toEqual([["a@example.com", "b@example.com"], ["c@example.com", "d@example.com"]]);
    expect(inserts[0].sql).toContain("returning id, (xmax = 0) as created");
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
    const { db, queries } = fakeDb(["a@example.com"], { skip: true });
    const csv = ["email", "a@example.com", "b@example.com"].join("\n");
    const counts = await runImport(db, storage(csv), job({ on_conflict: "skip" }));
    const insert = queries.find((query) => query.sql.includes("insert into contacts"))!;
    // Only a deleted contact is written over. A live one is left as it is.
    expect(insert.sql).toContain("where contacts.deleted_at is not null");
    expect(counts).toEqual({ total: 2, created: 1, updated: 0, skipped: 1, failed: 0 });
  });

  it("adds imported contacts to segments and topics", async () => {
    const { db, queries } = fakeDb();
    const csv = ["email", "a@example.com"].join("\n");
    await runImport(db, storage(csv), job({ segments: [{ id: "segment_1" }], topics: [{ id: "topic_1", subscription: "opt_out" }] }));
    const segment = queries.find((query) => query.sql.includes("insert into segment_contacts"))!;
    expect(segment.params[2]).toEqual(["segment_1"]);
    const topic = queries.find((query) => query.sql.includes("insert into topic_subscriptions"))!;
    expect(topic.params[4]).toEqual(["unsubscribed"]);
    // An existing opt-out is never turned back into an opt-in by an import.
    expect(topic.sql).toContain("where not (topic_subscriptions.status = 'unsubscribed' and excluded.status = 'subscribed')");
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
