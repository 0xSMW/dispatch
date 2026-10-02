import { describe, expect, it, vi } from "vitest";
import { assertImportRefs, dedupeByEmail, importBatch, importKey, presentImport } from "./imports.js";

function client(handler: (sql: string, params: unknown[]) => unknown[] = () => []) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const rows = handler(sql, params);
      return { rows, rowCount: rows.length };
    }),
  };
}

const contact = (email: string, first_name: string | null = null) => ({ email, first_name, last_name: null, properties: {}, unsubscribed: false });

describe("contact import queries", () => {
  it("presents counts with every key and builds the storage key", () => {
    expect(presentImport({ id: "import_1", status: "queued", counts: { total: 1 } as never, error: null, created_at: "2026-10-01", completed_at: null })).toEqual({
      object: "contact_import",
      id: "import_1",
      status: "queued",
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

  it("splits created and updated from one upsert and keeps unsubscribes", async () => {
    const db = client((sql) => (sql.includes("insert into contacts") ? [{ id: "c1", created: true }, { id: "c2", created: false }] : []));
    const result = await importBatch(db, { tenant_id: "tenant_1", on_conflict: "upsert", segments: [], topics: [] }, [contact("a@x.com"), contact("b@x.com")]);
    expect(result).toMatchObject({ created: 1, updated: 1, skipped: 0 });
    expect(db.queries[0].sql).toContain("else contacts.properties || excluded.properties end");
    // A deleted contact comes back with the file's values only.
    expect(db.queries[0].sql).toContain("when contacts.deleted_at is not null then excluded.properties");
    expect(db.queries[0].sql).toContain("coalesce(contacts.unsubscribed_at, excluded.unsubscribed_at)");
    expect(db.queries[0].sql).toContain("unnest($1::text[]");
    expect(db.queries).toHaveLength(1);
  });

  it("rejects segments and topics that are not the tenant's", async () => {
    const db = client(() => [{ segments: 1, topics: 0 }]);
    await expect(assertImportRefs(db, "tenant_1", [{ id: "segment_1" }], [{ id: "topic_1" }])).rejects.toMatchObject({ statusCode: 404 });
    const none = client();
    await assertImportRefs(none, "tenant_1", [], []);
    expect(none.queries).toHaveLength(0);
  });
});
