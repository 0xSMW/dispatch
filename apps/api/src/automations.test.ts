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
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const db = { query, connect } as unknown as Db;
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    (request as unknown as { auth: { tenant_id: string } }).auth = { tenant_id: "tenant_1" };
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    reply.status(error.name === "ZodError" ? 400 : (error.statusCode ?? 500)).send({ name: error.name, message: error.message });
  });
  registerAutomations(app, { db, paging: () => ({}) });
  return { app, query, connect, release };
}

describe("automation presenters", () => {
  it("saves keyed contact graphs without treating their stored internal key as public event input", () => {
    const current: AutomationRow = { ...legacy, trigger: "@contact.updated", trigger_type: "contact_updated",
      steps: [{ key: "start", type: "trigger", config: { type: "contact_updated", field: "active", from: false, to: true } }] };
    expect(mergeGraph(current, { steps: current.steps, connections: [] })).toMatchObject({
      trigger: "@contact.updated", trigger_type: "contact_updated", trigger_config: { type: "contact_updated", field: "active", from: false, to: true }
    });
    expect(mergeGraph(current, { trigger: "profile.updated" })).toMatchObject({ trigger_type: "event", trigger: "profile.updated" });
  });
  it("presents a stored linear automation as a graph with a status", () => {
    const presented = presentAutomation(legacy);
    expect(presented).toMatchObject({
      object: "automation", status: "enabled", trigger: "user.created",
      trigger_config: { type: "event", event_name: "user.created" }, reentry: "every_time",
    });
    expect(presented.steps.map((step) => step.key)).toEqual(["trigger", "step_1", "step_2"]);
    expect(presented.steps[1]).toEqual({ key: "step_1", type: "delay", config: { duration: "60 seconds" } });
    expect(presented.connections).toHaveLength(2);
    expect(presentAutomationRow({ ...legacy, enabled: false, run_count: 4 })).toEqual({
      id: "automation_1",
      name: "Welcome",
      status: "disabled",
      version: 0,
      trigger: "user.created",
      trigger_config: { type: "event", event_name: "user.created" },
      reentry: "every_time",
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
    expect(graph?.steps[0]?.config).toEqual({ type: "event", event_name: "user.invited" });
  });

  it("presents a contact trigger without exposing its internal key as an event", () => {
    const row: AutomationRow = {
      ...legacy, trigger: "@contact.updated", trigger_type: "contact_updated", reentry: "once",
      steps: [{ key: "start", type: "trigger", config: { type: "contact_updated", field: "first_name", to: "Ada" } }],
      connections: [],
    };
    const contract = { trigger: null, trigger_config: { type: "contact_updated", field: "first_name", to: "Ada" }, reentry: "once" };
    expect(presentAutomation(row)).toMatchObject(contract);
    expect(presentAutomationRow(row)).toMatchObject(contract);
  });
});

describe("automation routes", () => {
  const stored = (row: Partial<AutomationRow> = {}) => ({ ...legacy, ...row });
  function contended(deadlocks: number) {
    const state = { automation: stored(), deleted: false, run: "waiting", step: "waiting", receipt: true, events: [] as string[] };
    let snapshot: typeof state;
    const result = harness((sql, params) => {
      const text = sql.trim();
      if (text === "begin") snapshot = structuredClone(state);
      if (text === "rollback") Object.assign(state, snapshot);
      if (text.includes("from automations")) return { rows: state.deleted ? [] : [structuredClone(state.automation)] };
      if (text.startsWith("update automations")) {
        if (text.includes("set deleted_at")) state.deleted = true;
        else state.automation.enabled = false;
        return { rows: [structuredClone(state.automation)] };
      }
      if (text.startsWith("update automation_runs")) {
        if (!(params[2] as string[]).includes(state.run)) return { rows: [] };
        state.run = "stopped";
        return { rows: [{ id: "run_1" }] };
      }
      if (text.startsWith("delete from automation_enrollments")) state.receipt = false;
      if (text.startsWith("update automation_steps")) state.step = "failed";
      if (text.includes("from automation_runs r")) return { rows: [{
        ...run, state: state.run, request_id: "req_1", contact_id: "contact_1", exit_reason: "stopped",
      }] };
      if (text.startsWith("insert into email_events")) {
        if (deadlocks-- > 0) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        state.events.push(String(params[5]));
      }
      return { rows: [] };
    });
    return { ...result, state };
  }

  it.each([
    ["PATCH", "/automations/automation_1", { status: "disabled" }],
    ["POST", "/automations/automation_1/stop", { reset_reentry: true }],
    ["DELETE", "/automations/automation_1", undefined],
  ] as const)("retries the whole aborted %s %s operation including cancellation and fanout", async (method, url, payload) => {
    const { app, state, query, connect, release } = contended(1);
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode).toBe(200);
    expect(state).toMatchObject({
      run: "stopped", step: "failed", receipt: method !== "POST", events: ["automation.run.completed"],
    });
    expect(state.deleted).toBe(method === "DELETE");
    if (method !== "DELETE") expect(state.automation.enabled).toBe(false);
    expect(query.mock.calls.filter(([sql]) => ["begin", "rollback", "commit"].includes(sql)).map(([sql]) => sql)).toEqual(["begin", "rollback", "begin", "commit"]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it.each([
    ["PATCH", "/automations/automation_1", { status: "disabled" }],
    ["POST", "/automations/automation_1/stop", { reset_reentry: true }],
    ["DELETE", "/automations/automation_1", undefined],
  ] as const)("keeps %s %s nonterminal when all four transaction attempts abort", async (method, url, payload) => {
    const { app, state, query, connect, release } = contended(4);
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode).toBe(500);
    expect(state).toMatchObject({ deleted: false, automation: { enabled: true }, run: "waiting", step: "waiting", receipt: true, events: [] });
    expect(query.mock.calls.filter(([sql]) => sql === "rollback")).toHaveLength(4);
    expect(query.mock.calls.some(([sql]) => sql === "commit")).toBe(false);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledTimes(4);
    await app.close();
  });

  it("recomputes graph edits from the current status, name and version on retry", async () => {
    let current = stored({ paused_at: "2026-10-04T00:00:00Z", version: 1 });
    let deadlocks = 1;
    const { app, query, release } = harness((sql, params) => {
      if (sql === "rollback") current = stored({ enabled: false, name: "Concurrent", version: 7 });
      if (sql.includes("from automations")) return { rows: [structuredClone(current)] };
      if (sql.startsWith("update automations")) {
        if (deadlocks-- > 0) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        current = stored({
          name: String(params[2]), trigger: String(params[3]), steps: JSON.parse(params[4] as string),
          enabled: params[6] as boolean, version: current.version! + Number(params[10]),
        });
        return { rows: [current] };
      }
      return { rows: [] };
    });
    const response = await app.inject({ method: "PATCH", url: "/automations/automation_1", payload: {
      steps: [{ key: "start", type: "trigger", config: { event_name: "user.invited" } }], connections: [],
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "Concurrent", status: "disabled", version: 8, trigger: "user.invited" });
    expect(query.mock.calls.filter(([sql]) => sql.includes("order by id for update"))).toHaveLength(2);
    expect(query.mock.calls.filter(([sql]) => sql.includes("from automations"))).toHaveLength(2);
    expect(release).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("does not apply a paused graph edit after a concurrent Start wins during rollback", async () => {
    let paused = true;
    const { app, query } = harness((sql) => {
      if (sql === "rollback") paused = false;
      if (sql.includes("from automations")) return { rows: [stored({ paused_at: paused ? "2026-10-04T00:00:00Z" : null })] };
      if (sql.startsWith("update automations")) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return { rows: [] };
    });
    const response = await app.inject({ method: "PATCH", url: "/automations/automation_1", payload: {
      steps: [{ key: "start", type: "trigger", config: { event_name: "user.invited" } }], connections: [],
    } });
    expect(response.statusCode).toBe(409);
    expect(query.mock.calls.filter(([sql]) => sql.startsWith("update automations"))).toHaveLength(1);
    expect(query.mock.calls.some(([sql]) => sql === "commit")).toBe(false);
    await app.close();
  });

  it("rechecks deletion before a retried Stop and does not cancel runs for a missing automation", async () => {
    let deleted = false;
    const { app, query } = harness((sql) => {
      if (sql === "rollback") deleted = true;
      if (sql.startsWith("update automations")) {
        expect(sql).toContain("and deleted_at is null");
        if (!deleted) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }
      return { rows: [] };
    });
    const response = await app.inject({ method: "POST", url: "/automations/automation_1/stop" });
    expect(response.statusCode).toBe(404);
    expect(query.mock.calls.filter(([sql]) => sql.startsWith("update automations"))).toHaveLength(2);
    expect(query.mock.calls.some(([sql]) => sql.startsWith("update automation_runs"))).toBe(false);
    await app.close();
  });

  it.each([
    [true, null, "paused", 200], [true, "2026-10-04T00:00:00Z", "enabled", 200],
    [true, "2026-10-04T00:00:00Z", "disabled", 200], [false, null, "enabled", 200],
    [false, null, "paused", 409],
  ])("transitions enabled=%s paused=%s to %s with response %s", async (enabled, pausedAt, status, code) => {
    const { app, query } = harness((sql, params) => {
      if (sql.includes("from automations")) return { rows: [stored({ enabled, paused_at: pausedAt, version: 3 })] };
      if (sql.startsWith("update automations")) return { rows: [stored({
        enabled: params[6] as boolean, paused_at: params[9] === "paused" ? "2026-10-04T00:00:00Z" : null, version: 3,
      })] };
      return { rows: [] };
    });
    const response = await app.inject({ method: "PATCH", url: "/automations/automation_1", payload: { status } });
    expect(response.statusCode).toBe(code);
    if (code === 200) expect(response.json()).toMatchObject({ status, version: 3 });
    if (status !== "disabled") expect(query.mock.calls.some(([sql]) => sql.includes("state = 'stopped'"))).toBe(false);
  });

  it("creates a disabled automation by default from a flat body", async () => {
    const { app, query } = harness((sql, params) =>
      sql.includes("insert into automations")
        ? { rows: [stored({
          enabled: params[6] as boolean, steps: JSON.parse(params[4] as string), connections: JSON.parse(params[5] as string),
          trigger_type: params[7] as AutomationRow["trigger_type"], reentry: params[8] as AutomationRow["reentry"],
        })] }
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
    expect(response.json()).toMatchObject({
      object: "automation", status: "disabled", trigger_config: { type: "event", event_name: "user.created" },
      reentry: "every_time", connections: [{ from: "start", to: "hi", type: "default" }],
    });
    const insert = query.mock.calls.find(([sql]) => sql.includes("insert into automations"))!;
    expect(insert[1]![3]).toBe("user.created");
    expect(insert[1]!.slice(7, 9)).toEqual(["event", "every_time"]);
    expect(JSON.parse(insert[1]![9] as string)).toEqual({ start: "trigger", hi: "send_email" });
    expect(query.mock.calls.map(([sql]) => sql)).toContain("commit");
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

  it("creates, patches, and duplicates a typed trigger without losing its reentry policy", async () => {
    let current: AutomationRow = stored({ enabled: false });
    const { app, query } = harness((sql, params) => {
      if (sql.includes("from contact_properties")) return { rows: [{ key: "activated", type: "boolean" }] };
      if (sql.includes("from automations")) return { rows: [current] };
      if (sql.includes("insert into automations") || sql.startsWith("update automations")) {
        const insert = sql.includes("insert into automations");
        current = stored({
          id: insert ? String(params[0]) : String(params[1]), name: String(params[2]), trigger: String(params[3]),
          steps: JSON.parse(params[4] as string), connections: JSON.parse(params[5] as string), enabled: params[6] as boolean,
          trigger_type: params[7] as AutomationRow["trigger_type"], reentry: params[8] as AutomationRow["reentry"],
        });
        return { rows: [current] };
      }
      return { rows: [] };
    });
    const config = { type: "contact_updated", field: "activated", from: false, to: true };
    const created = await app.inject({
      method: "POST", url: "/automations",
      payload: { name: "Activated", reentry: "once", steps: [{ key: "start", type: "trigger", config }] },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ trigger: null, trigger_config: config, reentry: "once", status: "disabled" });
    const insert = query.mock.calls.find(([sql]) => sql.includes("insert into automations"))!;
    expect(insert[1]![3]).toBe("@contact.updated");
    expect(insert[1]!.slice(7, 9)).toEqual(["contact_updated", "once"]);
    const automationId = created.json().id;
    const patched = await app.inject({ method: "PATCH", url: `/automations/${automationId}`, payload: { name: "Renamed" } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Renamed", trigger: null, trigger_config: config, reentry: "once" });
    const copy = await app.inject({ method: "POST", url: `/automations/${automationId}/duplicate` });
    expect(copy.statusCode).toBe(200);
    expect(copy.json()).toMatchObject({ name: "Renamed (copy)", trigger: null, trigger_config: config, reentry: "once", status: "disabled" });
    expect(query.mock.calls.filter(([sql]) => sql.includes("insert into automations")).at(-1)![1]!.slice(7, 9)).toEqual(["contact_updated", "once"]);
  });

  it.each([
    [{ type: "contact_updated", field: "activated", to: "true" }, "to for activated must be a boolean"],
    [{ type: "contact_updated", field: "missing" }, "Contact field missing must be built-in or declared"],
    [{ type: "topic_subscribed", topic_id: "topic_missing" }, "Its topic was deleted or does not exist"],
    [{ type: "segment_added", segment_id: "segment_missing" }, "Its segment was deleted or does not exist"],
  ])("validates a typed trigger against tenant resources before inserting", async (config, message) => {
    const { app, query } = harness((sql) => ({ rows: sql.includes("from contact_properties") ? [{ key: "activated", type: "boolean" }] : [] }));
    const response = await app.inject({ method: "POST", url: "/automations", payload: { name: "Invalid", steps: [{ key: "start", type: "trigger", config }] } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ name: "validation_error", message });
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into automations"))).toBe(false);
    expect(query.mock.calls.at(-1)![0]).toBe("rollback");
  });

  it("refuses to change steps while enabled, and allows it while disabling", async () => {
    const { app, query } = harness((sql) => {
      if (sql.includes("from automations")) return { rows: [stored()] };
      if (sql.startsWith("update automations")) return { rows: [stored({ enabled: false })] };
      return { rows: [] };
    });
    const steps = [
      { key: "trigger", type: "trigger", config: { event_name: "user.created" } },
      { key: "new_send", type: "send_email", config: { from: "hello@acme.com", template: "other" } },
    ];
    const blocked = await app.inject({ method: "PATCH", url: "/automations/automation_1", payload: { steps, connections: [] } });
    expect(blocked.statusCode).toBe(409);
    expect(query.mock.calls.some((call) => String(call[0]).startsWith("update"))).toBe(false);

    const renamed = await app.inject({ method: "PATCH", url: "/automations/automation_1", payload: { name: "Renamed" } });
    expect(renamed.statusCode).toBe(200);

    const allowed = await app.inject({ method: "PATCH", url: "/automations/automation_1", payload: { status: "disabled", steps, connections: [] } });
    expect(allowed.statusCode).toBe(200);
    const update = query.mock.calls.filter((call) => String(call[0]).includes("update automations")).at(-1)!;
    expect(JSON.parse(update[1]![4] as string)[1]).toMatchObject({ key: "new_send", type: "send_email" });
    expect(update[1]![6]).toBe(false);
  });

  it("lists automations with a run count and filters by status", async () => {
    const { app, query } = harness(() => ({ rows: [{ ...stored(), run_count: 3 }] }));
    const response = await app.inject({ method: "GET", url: "/automations?status=enabled" });
    expect(response.json().data[0]).toMatchObject({ status: "enabled", run_count: 3 });
    expect(query.mock.calls[0]![0]).toContain("as run_count");
    expect(query.mock.calls[0]![0]).toContain("enabled and paused_at is null");
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

  it.each([undefined, {}, { reset_reentry: false }, { reset_reentry: true }])(
    "cancels only active runs and resets only their enrollment references for stop body %j",
    async (payload) => {
      const runs = [
        { id: "run_ready", state: "ready", automation_id: legacy.id, tenant_id: "tenant_1" },
        { id: "run_running", state: "running", automation_id: legacy.id, tenant_id: "tenant_1" },
        { id: "run_waiting", state: "waiting", automation_id: legacy.id, tenant_id: "tenant_1" },
        { id: "run_done", state: "done", automation_id: legacy.id, tenant_id: "tenant_1" },
        { id: "run_failed", state: "failed", automation_id: legacy.id, tenant_id: "tenant_1" },
        { id: "run_stopped", state: "stopped", automation_id: legacy.id, tenant_id: "tenant_1" },
        { id: "run_other_tenant", state: "ready", automation_id: legacy.id, tenant_id: "tenant_other" },
        { id: "run_other_automation", state: "ready", automation_id: "automation_other", tenant_id: "tenant_1" },
      ];
      const { app, query } = harness((sql, params) => {
        if (sql.includes("from automations")) return { rows: [stored({ reentry: "once" })] };
        if (sql.startsWith("update automations")) return { rows: [stored({ enabled: false, reentry: "once" })] };
        if (sql.startsWith("update automation_runs")) {
          const cancelled = runs.filter((row) => row.tenant_id === params[0] && row.automation_id === params[1] && (params[2] as string[]).includes(row.state));
          for (const row of cancelled) row.state = "stopped";
          return { rows: cancelled.map((row) => ({ id: row.id })) };
        }
        return { rows: [] };
      });
      const response = await app.inject({ method: "POST", url: "/automations/automation_1/stop", ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "disabled", reentry: "once" });
      const cancelled = ["run_ready", "run_running", "run_waiting"];
      const update = query.mock.calls.find(([sql]) => sql.startsWith("update automation_runs"))!;
      expect(update[0].replace(/\s+/g, " ")).toContain("where tenant_id = $1 and automation_id = $2 and state = any($3) returning id");
      expect(update[1]).toEqual(["tenant_1", legacy.id, ["ready", "running", "waiting"]]);
      expect(runs.slice(3).map((row) => row.state)).toEqual(["done", "failed", "stopped", "ready", "ready"]);
      const reset = query.mock.calls.filter(([sql]) => sql.startsWith("delete from automation_enrollments"));
      expect(reset).toHaveLength(payload?.reset_reentry ? 1 : 0);
      if (reset.length) {
        expect(reset[0]![1]).toEqual(["tenant_1", legacy.id, cancelled]);
        const sql = reset[0]![0];
        expect(sql).toContain("n.tenant_id = $1 and n.automation_id = $2 and r.tenant_id = $1");
        expect(sql).toContain("r.id = any($3::text[]) and n.contact_id = coalesce(r.contact_id, c.id)");
        expect(sql).toContain("e.tenant_id = r.tenant_id and e.id = r.event_id");
        expect(sql).toContain("c.tenant_id = r.tenant_id and lower(c.email) = lower(e.email)");
        expect(query.mock.calls.indexOf(update)).toBeLessThan(query.mock.calls.indexOf(reset[0]!));
      }
      const steps = query.mock.calls.find(([sql]) => sql.startsWith("update automation_steps"))!;
      expect(steps[1]).toEqual(["tenant_1", cancelled]);
      expect(steps[0]).toContain("state = 'waiting'");
      expect(query.mock.calls.at(-1)![0]).toBe("commit");
    },
  );

  it("does not reset completed enrollments when there are no active runs to cancel", async () => {
    const { app, query } = harness((sql) => {
      if (sql.includes("from automations")) return { rows: [stored({ reentry: "once" })] };
      if (sql.startsWith("update automations")) return { rows: [stored({ enabled: false, reentry: "once" })] };
      return { rows: [] };
    });
    const response = await app.inject({ method: "POST", url: "/automations/automation_1/stop", payload: { reset_reentry: true } });
    expect(response.statusCode).toBe(200);
    expect(query.mock.calls.some(([sql]) => sql.includes("delete from automation_enrollments"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.startsWith("update automation_steps"))).toBe(false);
    expect(query.mock.calls.at(-1)![0]).toBe("commit");
  });

  it.each([
    { reset_reentry: "true" }, { reset_reentry: "false" }, { reset_reentry: 1 }, { reset_reentry: 0 },
    { reset_reentry: null }, { reset_reentry: [] }, { unknown: true },
    { reset_reentry: true, unknown: true },
  ])("rejects invalid stop input %j before querying or changing anything", async (payload) => {
    const { app, query } = harness(() => ({ rows: [] }));
    const response = await app.inject({ method: "POST", url: "/automations/automation_1/stop", payload });
    expect(response.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
