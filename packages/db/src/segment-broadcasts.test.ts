import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "./index.js";
import { broadcastAudience, snapshotBroadcast } from "./broadcasts.js";

describe("dynamic broadcast SQL wiring", () => {
  it("uses bound predicates with receipt eligibility and mailbox deduplication in one INSERT", async () => {
    const query = vi.fn(async (sql: string, _params: unknown[]) => {
      if (sql.startsWith("select topic_id")) return { rows: [{ topic_id: "topic", segment_id: "filter" }] };
      if (sql.startsWith("select rule from")) return { rows: [{ rule: { type: "rule", field: "contact.score", operator: "gte", value: 3 } }] };
      if (sql.includes("from contact_properties")) return { rows: [{ key: "score", type: "number" }] };
      return { rows: [], rowCount: 1 };
    });
    const db = { query } as unknown as Queryable;
    expect(await snapshotBroadcast(db, "tenant", "broadcast")).toBe(1);
    const inserts = query.mock.calls.filter(([sql]) => sql.startsWith("insert into broadcast_recipients"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toEqual(["tenant", "filter", "topic", "broadcast", "score", 3]);
    expect(inserts[0]![0]).toContain("c.properties -> $5::text");
    expect(inserts[0]![0]).toContain("distinct on (lower(c.email))");
    expect(inserts[0]![0]).toContain("c.unsubscribed_at is null");
    expect(inserts[0]![0]).toContain("from suppressions");
    expect(inserts[0]![0]).toContain("s.status = 'subscribed'");
    await broadcastAudience(db, "tenant", { segmentId: "filter", topicId: "topic" });
    const counts = query.mock.calls.find(([sql]) => sql.startsWith("select\n"))!;
    expect(counts[1]).toEqual(["tenant", "filter", "topic", "score", 3]);
    expect(counts[0]).toContain("c.properties -> $4::text");
    expect(counts[0]).toContain("distinct on (mailbox)");
  });
});
