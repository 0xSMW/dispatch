import Fastify from "fastify";
import type { Db } from "@dispatchmail/db";
import { describe, expect, it, vi } from "vitest";
import { registerAudience } from "./audience.js";

describe("contacts topic discovery", () => {
  it("batches effective preferences and keeps global unsubscribe separate", async () => {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from contacts c join topics t")) return { rows: [
        { contact_id: "c1", id: "t1", name: "Default", status: "subscribed" },
        { contact_id: "c1", id: "t2", name: "Declined", status: "unsubscribed" },
        { contact_id: "c1", id: "t3", name: "Unconfirmed", status: "pending" },
      ] };
      if (sql.includes("from contacts c") && !sql.includes("join segments")) return { rows: [{ id: "c1", email: "a@example.com", first_name: null, last_name: null, properties: {}, unsubscribed_at: "2026-10-01", created_at: "2026-10-01", updated_at: "2026-10-01" }] };
      return { rows: [] };
    });
    const app = Fastify();
    app.addHook("preHandler", async request => { request.auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" }; });
    registerAudience(app, { db: { query } as unknown as Db, paging: () => ({}), emitChange: vi.fn(), slug: name => name });
    try {
      const response = await app.inject({ method: "GET", url: "/contacts?q=ada&topic_id=t1" });
      expect(response.statusCode).toBe(200);
      expect(response.json().data[0]).toMatchObject({ unsubscribed: true, topics: [
        { id: "t1", name: "Default", subscription: "opt_in" },
        { id: "t2", name: "Declined", subscription: "opt_out" },
        { id: "t3", name: "Unconfirmed", subscription: "pending" },
      ] });
      const preference = query.mock.calls.find(([sql]) => sql.includes("from contacts c join topics t"))!;
      expect(preference[1]).toEqual(["tenant_1", ["c1"]]);
      expect(preference[0]).toContain("coalesce(s.status, t.default_status)");
      expect(preference[0]).toContain("s.tenant_id = t.tenant_id");
      expect(preference[0]).toContain("t.deleted_at is null");
      const page = query.mock.calls.find(([sql]) => sql.includes("exists (") && sql.includes("t.id = $3"))!;
      expect(page[0]).toContain("coalesce(s.status, t.default_status) = 'subscribed'");
      expect(page[0]).toContain("t.tenant_id = c.tenant_id");
      expect(page[1]?.slice(0, 3)).toEqual(["tenant_1", "%ada%", "t1"]);
    } finally { await app.close(); }
  });
});
