import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@dispatchmail/db";
import { registerGoals } from "./goals.js";

const row = { id: "goal_1", tenant_id: "tenant_1", name: "Upgrade", target: { event: "upgraded" }, eligibility: null,
  window_days: 30, created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z", deleted_at: null };
describe("goal route contracts (mocked database)", () => {
  it("lists only live tenant goals across forward and backward page boundaries with public shapes", async () => {
    const id = (n: number) => `goal_${String(n).padStart(2, "0")}`;
    const rows = [1, 2, 4, 5, 6, 7, 8, 9].map(n => ({
      ...row, id: id(n), tenant_id: n === 5 ? "tenant_other" : "tenant_1",
      created_at: n >= 5 ? "2026-10-05T00:00:00Z" : "2026-10-04T00:00:00Z",
      deleted_at: [2, 7, 9].includes(n) ? "2026-10-06T00:00:00Z" : null,
    }));
    const compare = (a: typeof rows[number], b: typeof rows[number]) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
    // Model only this list query; pagination SQL and presentation are the real route's implementations.
    const query = vi.fn(async (raw: string, params: unknown[]) => {
      const sql = raw.replace(/\s+/g, " ");
      expect(sql).toContain(" from goals where tenant_id = $1 and deleted_at is null");
      const backward = sql.includes("order by created_at asc, id asc");
      const direction = backward ? "asc" : "desc";
      expect(sql).toContain(`order by created_at ${direction}, id ${direction} limit $${params.length}`);
      let matches = rows.filter(entry => entry.tenant_id === params[0] && entry.deleted_at === null);
      if (params.length === 3) {
        expect(sql).toContain(`(created_at, id) ${backward ? ">" : "<"} ( select created_at, id from goals where tenant_id = $1 and id = $2 limit 1 )`);
        const cursor = rows.find(entry => entry.tenant_id === params[0] && entry.id === params[1]);
        matches = cursor ? matches.filter(entry => backward ? compare(entry, cursor) > 0 : compare(entry, cursor) < 0) : [];
      }
      return { rows: matches.sort((a, b) => (backward ? 1 : -1) * compare(a, b)).slice(0, Number(params.at(-1))) };
    });
    const app = Fastify();
    app.addHook("preHandler", async request => { request.auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" }; });
    registerGoals(app, { db: { query } as unknown as Db, paging: request => {
      const { limit, after, before } = request.query as { limit?: string; after?: string; before?: string };
      return { limit: Number(limit ?? 20), after, before };
    } });
    try {
      for (const { search, ids, has_more } of [
        { search: "limit=2", ids: [8, 6], has_more: true },
        { search: `limit=2&after=${id(6)}`, ids: [4, 1], has_more: false },
        { search: `limit=2&before=${id(1)}`, ids: [6, 4], has_more: true },
        { search: `limit=2&before=${id(4)}`, ids: [8, 6], has_more: false },
        { search: `limit=1&after=${id(8)}`, ids: [6], has_more: true },
        { search: `limit=2&after=${id(1)}`, ids: [], has_more: false },
        { search: `limit=2&after=${id(5)}`, ids: [], has_more: false },
        { search: `limit=2&after=${id(7)}`, ids: [6, 4], has_more: true },
      ]) {
        const response = await app.inject(`/goals?${search}`);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ object: "list", has_more, data: ids.map(n => {
          const entry = rows.find(entry => entry.id === id(n))!;
          return { object: "goal", id: entry.id, name: entry.name, target: entry.target, eligibility: entry.eligibility,
            window_days: entry.window_days, created_at: new Date(entry.created_at).toISOString(), updated_at: new Date(entry.updated_at).toISOString() };
        }) });
        const params = new URLSearchParams(search);
        const cursor = params.get("after") ?? params.get("before");
        expect(query).toHaveBeenLastCalledWith(expect.any(String), ["tenant_1", ...(cursor ? [cursor] : []), Number(params.get("limit")) + 1]);
      }
      const calls = query.mock.calls.length;
      for (const search of ["limit=0", "limit=101", `limit=2&after=${id(8)}&before=${id(4)}`])
        expect((await app.inject(`/goals?${search}`)).statusCode).toBe(400);
      expect(query.mock.calls).toHaveLength(calls);
    } finally { await app.close(); }
  });

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
