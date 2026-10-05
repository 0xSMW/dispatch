import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@dispatchmail/db";
import { registerGoals } from "./goals.js";

const row = { id: "goal_1", tenant_id: "tenant_1", name: "Upgrade", target: { event: "upgraded" }, eligibility: null,
  window_days: 30, created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z", deleted_at: null };
describe("goal route contracts (mocked database)", () => {
  it("reads tenant-scoped public shapes and rejects bad scope query before metrics IO", async () => {
    const query = vi.fn(async () => ({ rows: [row] }));
    const app = Fastify();
    app.addHook("preHandler", async (request) => { request.auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" }; });
    registerGoals(app, { db: { query } as unknown as Db, paging: () => ({ limit: 20 }) });
    try {
      const response = await app.inject({ method: "GET", url: "/goals/goal_1" });
      expect(response.json()).toMatchObject({ object: "goal", id: "goal_1", target: { event: "upgraded" } });
      expect(response.json()).not.toHaveProperty("tenant_id");
      expect(query.mock.calls[0]).toEqual([expect.stringContaining("tenant_id = $1"), ["tenant_1", "goal_1"]]);
      const previous = query.mock.calls.length;
      const invalid = await app.inject({ method: "GET", url: "/goals/goal_1/metrics?automation_id=a&broadcast_id=b" });
      expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
      expect(query.mock.calls).toHaveLength(previous);
    } finally { await app.close(); }
  });
});
