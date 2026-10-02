import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AutomationRow, Db } from "@dispatchmail/db";
import {
  mergeGraph,
  presentAutomation,
  presentAutomationRow,
  presentRun,
  presentRunDetail,
  presentRunMetrics,
  presentStep,
  registerAutomations,
  runStates,
} from "./automations.js";

const legacy: AutomationRow = {
  id: "automation_1",
  name: "Welcome",
  trigger: "user.created",
  steps: [
    { type: "delay", seconds: 60 },
    { type: "send_email", from: "hello@acme.com", template: "welcome" },
  ],
  connections: [],
  enabled: true,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

const run = {
  id: "run_1",
  automation_id: "automation_1",
  event_id: "ce_1",
  event_name: "user.created",
  email: "ada@example.com",
  state: "waiting",
  error: null,
  created_at: legacy.created_at,
  updated_at: legacy.updated_at,
};

function harness(handler: (sql: string, params: unknown[]) => { rows: unknown[] }) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => handler(sql.replace(/\s+/g, " "), params));
  const db = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Db;
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    (request as unknown as { auth: { tenant_id: string } }).auth = { tenant_id: "tenant_1" };
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    reply.status(error.name === "ZodError" ? 400 : (error.statusCode ?? 500)).send({ name: error.name, message: error.message });
  });
  registerAutomations(app, { db, paging: () => ({}) });
  return { app, query };
}

describe("automation presenters", () => {
  it("presents a stored linear automation as a graph with a status", () => {
    const presented = presentAutomation(legacy);
    expect(presented).toMatchObject({ object: "automation", status: "enabled", trigger: "user.created" });
    expect(presented.steps.map((step) => step.key)).toEqual(["trigger", "step_1", "step_2"]);
    expect(presented.steps[1]).toEqual({ key: "step_1", type: "delay", config: { duration: "60 seconds" } });
    expect(presented.connections).toHaveLength(2);
    expect(presentAutomationRow({ ...legacy, enabled: false, run_count: 4 })).toEqual({
      id: "automation_1",
      name: "Welcome",
      status: "disabled",
      trigger: "user.created",
      run_count: 4,
      created_at: legacy.created_at,
      updated_at: legacy.updated_at,
    });
  });

  it.each([
    ["ready", "running"],
    ["running", "running"],
    ["waiting", "running"],
    ["done", "completed"],
    ["failed", "failed"],
    ["stopped", "cancelled"],
  ])("maps run state %s to %s", (state, status) => {
    expect(presentRun({ ...run, state }).status).toBe(status);
  });

  it("presents run steps with key, status, timing, and output", () => {
    const step = {
      id: "step_1",
      step_key: "wait",
      step_index: 1,
      type: "wait_for_event",
      state: "waiting",
      data: { event_name: "user.activated" },
      error: null,
      started_at: "2026-10-01T00:00:01.000Z",
      completed_at: null,
      created_at: "2026-10-01T00:00:01.000Z",
    };
    expect(presentStep(step)).toEqual({
      key: "wait",
      type: "wait_for_event",
      status: "running",
      started_at: "2026-10-01T00:00:01.000Z",
      completed_at: null,
      output: { event_name: "user.activated" },
      error: null,
    });
    // A row from before steps had keys: index 1 in the old list is step_2 now that the trigger comes first.
    expect(presentStep({ ...step, step_key: null, state: "done" })).toMatchObject({ key: "step_2", status: "completed" });
    const detail = presentRunDetail({ ...run, event_data: { plan: "pro" } }, [step]);
    expect(detail).toMatchObject({ object: "automation_run", status: "running", event: { name: "user.created", payload: { plan: "pro" } } });
    expect(detail.steps).toHaveLength(1);
  });

  it("expands a comma-separated status filter and rejects unknown values", () => {
    expect(runStates(undefined)).toBeNull();
    expect(runStates("running,cancelled")).toEqual(["ready", "running", "waiting", "stopped"]);
    expect(runStates("completed")).toEqual(["done"]);
    expect(() => runStates("done")).toThrow(/status must be/);
  });

  it("rewrites the trigger step when only the trigger changes", () => {
    expect(mergeGraph(legacy, {})).toBeNull();
    const graph = mergeGraph(legacy, { trigger: "user.invited" });
    expect(graph?.trigger).toBe("user.invited");
    expect(graph?.steps[0]?.config).toEqual({ event_name: "user.invited" });
  });
});

describe("automation routes", () => {
  const stored = (row: Partial<AutomationRow> = {}) => ({ ...legacy, ...row });

  it("creates a disabled automation by default from a flat body", async () => {
    const { app, query } = harness((sql, params) =>
      sql.includes("insert into automations")
        ? { rows: [stored({ enabled: params[6] as boolean, steps: JSON.parse(params[4] as string), connections: JSON.parse(params[5] as string) })] }
        : { rows: [] },
    );
    const response = await app.inject({
      method: "POST",
      url: "/automations",
      payload: {
        name: "Welcome",
        steps: [
          { key: "start", type: "trigger", config: { event_name: "user.created" } },
          { key: "hi", type: "send_email", config: { from: "hello@acme.com", template: { id: "welcome" } } },
        ],
        connections: [{ from: "start", to: "hi" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ object: "automation", status: "disabled", connections: [{ from: "start", to: "hi", type: "default" }] });
    expect(query.mock.calls[0]![1]![3]).toBe("user.created");
  });

  it("rejects a graph with a dangling connection", async () => {
    const { app } = harness(() => ({ rows: [] }));
    const response = await app.inject({
      method: "POST",
      url: "/automations",
      payload: { name: "Bad", steps: [{ key: "start", type: "trigger", config: { event_name: "e" } }], connections: [{ from: "start", to: "gone" }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses to change steps while enabled, and allows it while disabling", async () => {
    const { app, query } = harness((sql) => {
      if (sql.startsWith("select")) return { rows: [stored()] };
      if (sql.startsWith("update automations")) return { rows: [stored({ enabled: false })] };
      return { rows: [] };
    });
    const steps = [{ type: "send_email", from: "hello@acme.com", template: "other" }];
    const blocked = await app.inject({ method: "PATCH", url: "/automations/automation_1", payload: { steps } });
    expect(blocked.statusCode).toBe(409);
    expect(query.mock.calls.some((call) => String(call[0]).startsWith("update"))).toBe(false);

    const renamed = await app.inject({ method: "PATCH", url: "/automations/automation_1", payload: { name: "Renamed" } });
    expect(renamed.statusCode).toBe(200);

    const allowed = await app.inject({ method: "PATCH", url: "/automations/automation_1", payload: { status: "disabled", steps } });
    expect(allowed.statusCode).toBe(200);
    const update = query.mock.calls.filter((call) => String(call[0]).includes("update automations")).at(-1)!;
    expect(JSON.parse(update[1]![4] as string)[1]).toMatchObject({ key: "step_1", type: "send_email" });
    expect(update[1]![6]).toBe(false);
  });

  it("lists automations with a run count and filters by status", async () => {
    const { app, query } = harness(() => ({ rows: [{ ...stored(), run_count: 3 }] }));
    const response = await app.inject({ method: "GET", url: "/automations?status=enabled" });
    expect(response.json().data[0]).toMatchObject({ status: "enabled", run_count: 3 });
    expect(query.mock.calls[0]![0]).toContain("as run_count");
    expect(query.mock.calls[0]![1]![1]).toBe(true);
  });

  it("lists runs with a status filter and reads one run on the nested path", async () => {
    const { app, query } = harness((sql) => {
      if (sql.includes("from automations")) return { rows: [stored()] };
      if (sql.includes("from automation_steps")) return { rows: [] };
      return { rows: [run] };
    });
    const listed = await app.inject({ method: "GET", url: "/automations/automation_1/runs?status=running,failed" });
    expect(listed.json().data[0]).toMatchObject({ id: "run_1", status: "running" });
    const page = query.mock.calls[1]!;
    expect(page[0]).toContain("r.state = any($3)");
    expect(page[1]!.slice(1, 3)).toEqual(["automation_1", ["ready", "running", "waiting", "failed"]]);

    const detail = await app.inject({ method: "GET", url: "/automations/automation_1/runs/run_1" });
    expect(detail.json()).toMatchObject({ object: "automation_run", id: "run_1", steps: [] });
    expect(query.mock.calls.at(-2)![1]).toEqual(["tenant_1", "automation_1", "run_1"]);
  });

  it("totals runs by status and by day", async () => {
    expect(
      presentRunMetrics("automation_1", [
        { day: "2026-10-01", state: "done", count: 3 },
        { day: "2026-10-01", state: "waiting", count: 1 },
        { day: "2026-10-01", state: "running", count: 1 },
        { day: "2026-10-02", state: "failed", count: 2 },
        { day: "2026-10-02", state: "stopped", count: 1 },
      ]),
    ).toEqual({
      object: "automation_run_metrics",
      automation_id: "automation_1",
      total: 8,
      totals: { running: 2, completed: 3, failed: 2, cancelled: 1 },
      data: [
        { date: "2026-10-01", running: 2, completed: 3, failed: 0, cancelled: 0 },
        { date: "2026-10-02", running: 0, completed: 0, failed: 2, cancelled: 1 },
      ],
    });

    const { app, query } = harness((sql) => {
      if (sql.includes("date_trunc")) return { rows: [{ day: "2026-10-01", state: "done", count: 1 }] };
      if (sql.startsWith("select")) return { rows: [stored()] };
      return { rows: [] };
    });
    const response = await app.inject({ method: "GET", url: "/automations/automation_1/runs/metrics?start_date=2026-10-01" });
    expect(response.json()).toMatchObject({ object: "automation_run_metrics", total: 1, totals: { completed: 1 } });
    const metrics = query.mock.calls.find((call) => String(call[0]).includes("date_trunc"));
    expect(String(metrics?.[0])).toContain("r.automation_id = $2 and r.created_at >= $3");
    expect((metrics?.[1] as unknown[]).slice(1)).toEqual(["automation_1", "2026-10-01T00:00:00.000Z"]);
  });

  it("duplicates into a disabled copy and stops runs on stop", async () => {
    const { app, query } = harness((sql, params) => {
      if (sql.startsWith("select")) return { rows: [stored()] };
      if (sql.includes("insert into automations")) return { rows: [stored({ id: "automation_2", name: params[2] as string, enabled: params[6] as boolean })] };
      if (sql.includes("update automations")) return { rows: [stored({ enabled: false })] };
      return { rows: [] };
    });
    const copy = await app.inject({ method: "POST", url: "/automations/automation_1/duplicate" });
    expect(copy.json()).toMatchObject({ id: "automation_2", name: "Welcome (copy)", status: "disabled" });

    const stopped = await app.inject({ method: "POST", url: "/automations/automation_1/stop" });
    expect(stopped.json()).toMatchObject({ status: "disabled" });
    expect(query.mock.calls.some((call) => String(call[0]).includes("set state = 'stopped'"))).toBe(true);

    const deleted = await app.inject({ method: "DELETE", url: "/automations/automation_1" });
    expect(deleted.json()).toEqual({ object: "automation", id: "automation_1", deleted: true });
  });
});
