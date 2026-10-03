import { describe, expect, it, vi } from "vitest";
import { contactActivity, contactStats, presentActivity } from "./activity.js";

function client(rows: unknown[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows, rowCount: rows.length };
    }),
  };
}

describe("contact activity", () => {
  it("unions segment, topic, and email events for one contact, newest first", async () => {
    const db = client([{ id: "event_1", type: "email.delivered", resource_id: "email_1", label: "Hi", email_id: "email_1", created_at: "2026-10-01" }]);
    const page = await contactActivity(db, "tenant_1", { id: "contact_1", email: "ada@example.com" }, { limit: 5 });
    const { sql, params } = db.queries[0];
    expect(sql).toContain("from segment_contacts sc");
    expect(sql).toContain("from topic_subscriptions ts");
    expect(sql).toContain("from email_events ev");
    expect(sql).toContain("lower(r.email) = lower($3)");
    expect(sql).toContain("where ev.tenant_id = $1 and exists");
    expect(sql).toContain("'event.fired'");
    expect(sql).toContain("e.name not like '@%'");
    expect(sql).toContain("r.id || ':started'");
    expect(sql).toContain("r.id || ':completed'");
    expect(sql).toContain("r.state in ('done', 'failed', 'stopped')");
    expect(sql).toContain("order by created_at desc, id desc");
    expect(params).toEqual(["tenant_1", "contact_1", "ada@example.com", 6]);
    expect(page.data.map(presentActivity)[0]).toMatchObject({ object: "contact_activity", type: "email.delivered" });
  });

  it("pages with an id cursor after the contact parameters", async () => {
    const db = client([]);
    await contactActivity(db, "tenant_1", { id: "contact_1", email: "ada@example.com" }, { after: "sub_1" });
    expect(db.queries[0].params).toEqual(["tenant_1", "contact_1", "ada@example.com", "sub_1", 21]);
    expect(db.queries[0].sql).toContain("id = $4");
  });

  it("counts all, subscribed, and unsubscribed contacts", async () => {
    const db = client([{ all: 5, subscribed: 3, unsubscribed: 2 }]);
    expect(await contactStats(db, "tenant_1")).toEqual({ object: "contact_stats", all: 5, subscribed: 3, unsubscribed: 2 });
    expect(db.queries[0].sql).toContain("deleted_at is null");
  });
});
