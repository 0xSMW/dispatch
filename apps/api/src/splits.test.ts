import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import type { Db, AutomationRow } from "@dispatchmail/db";
import { registerAutomations } from "./automations.js";

const current: AutomationRow = {
  id: "a", name: "Split", trigger: "start", enabled: true, paused_at: "2026-09-01T00:00:00Z", version: 0,
  steps: [{ key: "t", type: "trigger", config: { event_name: "start" } },
    { key: "s", type: "split", config: { variants: [{ key: "a", label: "A", weight: 50 }, { key: "b", label: "B", weight: 50 }] } },
    { key: "x", type: "exit", config: {} }],
  connections: [{ from: "t", to: "s", type: "default" }, { from: "s", to: "x", type: "variant", path: "a" }, { from: "s", to: "x", type: "variant", path: "b" }],
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};
function harness(row: AutomationRow) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("select") && sql.includes("from automations")) return { rows: [row] };
    if (sql.startsWith("update automations set steps")) return { rows: [{ ...row, steps: JSON.parse(params[2] as string), version: 1 }] };
    return { rows: [] };
  });
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Db;
  const app = Fastify();
  app.addHook("preHandler", async (request) => { request.auth = { tenant_id: "tenant" } as typeof request.auth; });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => { void reply.status(error.statusCode ?? 500).send({ name: error.name, message: error.message }); });
  registerAutomations(app, { db, paging: () => ({}) });
  return { app, query };
}
it("changes only weights under the paused version lock without auto-resume or Stop", async () => {
  const { app, query } = harness(current);
  try {
    const result = await app.inject({ method: "POST", url: "/automations/a/steps/s/winner", payload: { variant: "b", version: 0 } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ status: "paused", version: 1, connections: current.connections });
    expect(result.json().steps[1].config.variants).toEqual([{ key: "a", label: "A", weight: 0 }, { key: "b", label: "B", weight: 100 }]);
    const update = query.mock.calls.find(([sql]) => sql.startsWith("update automations set steps"))!;
    expect(update[1]?.slice(0, 2)).toEqual(["tenant", "a"]);
    expect(query.mock.calls.some(([sql]) => sql.includes("enabled = false") || sql.includes("paused_at = null"))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  } finally { await app.close(); }
});
it("refuses unpaused or stale versions before any updates and rolls back", async () => {
  for (const row of [{ ...current, paused_at: null }, { ...current, version: 2 }]) {
    const { app, query } = harness(row);
    try {
      expect((await app.inject({ method: "POST", url: "/automations/a/steps/s/winner", payload: { variant: "b", version: 0 } })).statusCode).toBe(409);
      expect(query.mock.calls.some(([sql]) => sql.startsWith("update"))).toBe(false);
      expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    } finally { await app.close(); }
  }
});
it("refuses an unknown variant before updates", async () => {
  const { app, query } = harness(current);
  try {
    expect((await app.inject({ method: "POST", url: "/automations/a/steps/s/winner", payload: { variant: "missing", version: 0 } })).statusCode).toBe(422);
    expect(query.mock.calls.some(([sql]) => sql.startsWith("update"))).toBe(false);
  } finally { await app.close(); }
});
