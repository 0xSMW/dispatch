import "@dispatchmail/core/env";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  id,
  keyHash,
  makeKey,
  ProviderError,
  renderTemplate,
  sign,
  verify,
  type Provider,
  type ProviderEmail,
} from "@dispatchmail/core";
import { appendEvent, connect, executeAutomationRun, fireEvent, reconcileBroadcastSent, tx, unsubscribeToken, type Db } from "@dispatchmail/db";
import type { Storage } from "@dispatchmail/storage";
import { schema } from "../../../packages/db/src/schema.js";
import { contactContext } from "../../../packages/db/src/automations.js";
import { createImport, claimImports, importBatch } from "../../../packages/db/src/imports.js";
import { runImport } from "../../worker/src/imports.js";
import { Readable } from "node:stream";
import { deliverJob, type Job } from "../../worker/src/deliver.js";
import { applySesEvent } from "../../worker/src/events.js";
import type { FastifyInstance } from "fastify";

// Live tests against a real Postgres and Redis, named in the environment or the local .env:
// TEST_DATABASE_URL (a database these tests may empty), TEST_REDIS_URL, and optionally
// TEST_ADMIN_DATABASE_URL, a database on the same server used to create the test one when it is
// missing. Without the first two, every test here is skipped.
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
const redisUrl = process.env.TEST_REDIS_URL ?? "";
const live = Boolean(databaseUrl && redisUrl);
if (process.env.REQUIRE_INTEGRATION_TESTS === "true" && !live) {
  throw new Error(
    "TEST_DATABASE_URL and TEST_REDIS_URL are required for integration tests",
  );
}
const databaseName = live ? new URL(databaseUrl).pathname.slice(1) : "";
const adminUrl =
  process.env.TEST_ADMIN_DATABASE_URL ??
  (live
    ? Object.assign(new URL(databaseUrl), { pathname: "/postgres" }).toString()
    : "");

let db: Db;
let app: FastifyInstance;
let tick: () => Promise<{ jobs: number; runs: number; attempts: number }>;
let closeApi: () => Promise<void>;
let closeWorker: () => Promise<void>;
let fullKey = "";
let turn = Promise.resolve();
let releaseTurn = () => {};

function takeTurn() {
  let release = () => {};
  const previous = turn;
  turn = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return previous.then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  });
}

beforeAll(async () => {
  if (!live) return;
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.RATE_LIMIT_PER_SECOND = "1000";
  // The per-address limit on sign-in would refuse a burst before the per-email lockout sees it.
  process.env.AUTH_RATE_LIMIT_PER_SECOND = "1000";
  process.env.TELEMETRY_FLUSH_MS = "600000";
  process.env.FAKE_PROVIDER_TERMINAL_DELAY_MS = "0";
  process.env.FAKE_PROVIDER_DELAYED_DELAY_MS = "0";
  await ensureDatabase();
  db = connect(databaseUrl);
  await db.query(schema);
  const api = await import("./server.js");
  const worker = await import("../../worker/src/worker.js");
  app = api.app;
  closeApi = api.close;
  tick = worker.tick;
  closeWorker = worker.close;
});

beforeEach(async () => {
  const release = await takeTurn();
  releaseTurn = release;
  try {
    await truncate();
    fullKey = await seedTenant();
  } catch (error) {
    release();
    throw error;
  }
});

afterEach(() => {
  releaseTurn();
});

afterAll(async () => {
  if (closeApi) await closeApi();
  if (closeWorker) await closeWorker();
  if (db) await db.end();
});

describe.skipIf(!live)("accept", () => {
  describe("flow control", () => {
    const start = { key: "start", type: "trigger", config: { event_name: "flow.start" } };
    const activated = { type: "rule", field: "contact.activated", operator: "eq", value: false };
    const exit = { key: "end", type: "exit", config: {} };
    async function fixture(scope = "following", rule: unknown = activated) {
      await post(fullKey, "/contact-properties", { key: "activated", type: "boolean" });
      const contact = await post(fullKey, "/contacts", { email: "flow@dispatch-fixture.net", properties: { activated: false } });
      const template = await post(fullKey, "/templates", { name: "Flow", subject: "Flow", text: "Fresh", publish: true });
      const flow = await post(fullKey, "/automations", { name: "Flow", enabled: true, steps: [
        start, { key: "eligible", type: "filter", config: { rule, scope } },
        { key: "wait", type: "delay", config: { duration: "1 hour" } },
        { key: "send", type: "send_email", config: { from: "hello@dispatch-fixture.net", template: template.json.id } },
      ], connections: [{ from: "start", to: "eligible" }, { from: "eligible", to: "wait" }, { from: "wait", to: "send" }] });
      expect(flow.status, JSON.stringify(flow.json)).toBe(200);
      await post(fullKey, "/events/send", { event: "flow.start", email: "flow@dispatch-fixture.net", payload: { received_at: "2099-01-01" } });
      const run = (await db.query<{ id: string; tenant_id: string }>("select id,tenant_id from automation_runs")).rows[0]!;
      return { flow: flow.json, contact: contact.json, run };
    }
    const row = async (runId: string) => (await db.query("select state,exit_reason,guards from automation_runs where id=$1", [runId])).rows[0];
    it("persists following guards, checks PATCH activation before the next send and emits one atomic filter completion", async () => {
      const { flow, run, contact } = await fixture();
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect(await row(run.id)).toMatchObject({ state: "waiting", exit_reason: null, guards: [{ filter: "eligible", rule: activated }] });
      expect((await call(fullKey, "PATCH", `/contacts/${contact.id}`, { properties: { activated: true } })).status).toBe(200);
      await executeAutomationRun(db, run.tenant_id, run.id);
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect(await row(run.id)).toMatchObject({ state: "done", exit_reason: "filter" });
      expect((await db.query("select id from emails")).rows).toHaveLength(0);
      expect((await db.query("select id from send_jobs")).rows).toHaveLength(0);
      const detail = (await call(fullKey, "GET", `/automations/${flow.id}/runs/${run.id}`)).json;
      expect(detail).toMatchObject({ exit_reason: "filter", guards: [{ filter: "eligible", rule: activated }] });
      expect(detail.steps.at(-1)).toMatchObject({ key: "send", output: { exited: "filter", filter: "eligible" } });
      const events = (await db.query("select type,data from email_events where data->>'run_id'=$1 order by created_at", [run.id])).rows;
      expect(events).toEqual([
        { type: "automation.run.started", data: expect.objectContaining({ exit_reason: null }) },
        { type: "automation.run.completed", data: expect.objectContaining({ exit_reason: "filter", state: "done" }) },
      ]);
    });
    it("keeps saved freshness guards across paused edits and refuses stale sends after resume", async () => {
      const freshRule = { type: "rule", field: "event.received_at", operator: "within", value: "1 day" };
      const { flow, run } = await fixture("following", freshRule);
      await executeAutomationRun(db, run.tenant_id, run.id);
      await call(fullKey, "PATCH", `/automations/${flow.id}`, { status: "paused" });
      await db.query("update custom_events set created_at=now()-interval '2 days' where id=(select event_id from automation_runs where id=$1)", [run.id]);
      // Changing the graph's filter cannot loosen a guard the run already passed.
      flow.steps.find((step: any) => step.key === "eligible").config.rule.value = "30 days";
      expect((await call(fullKey, "PATCH", `/automations/${flow.id}`, { steps: flow.steps, connections: flow.connections })).status).toBe(200);
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect((await row(run.id)).state).toBe("waiting");
      await call(fullKey, "PATCH", `/automations/${flow.id}`, { status: "enabled" });
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect(await row(run.id)).toMatchObject({ state: "done", exit_reason: "filter", guards: [{ filter: "eligible", rule: freshRule }] });
      expect((await db.query("select id from emails")).rows).toHaveLength(0);
    });
    it("tests next filters only once, never persists them, and completes a real queued send", async () => {
      const { run, contact } = await fixture("next");
      await executeAutomationRun(db, run.tenant_id, run.id);
      await call(fullKey, "PATCH", `/contacts/${contact.id}`, { properties: { activated: true } });
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect(await row(run.id)).toEqual({ state: "done", exit_reason: "completed", guards: [] });
      expect((await db.query("select id from emails")).rows).toHaveLength(1);
      expect((await db.query("select id from send_jobs")).rows).toHaveLength(1);
    });
    it.each(["next", "following"])("failed %s filters never follow a default edge", async (scope) => {
      const { run, contact } = await fixture(scope);
      await call(fullKey, "PATCH", `/contacts/${contact.id}`, { properties: { activated: true } });
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect(await row(run.id)).toEqual({ state: "done", exit_reason: "filter", guards: [] });
      expect((await db.query("select step_key,data from automation_steps")).rows).toEqual([{ step_key: "eligible", data: { result: false, exited: "filter", filter: "eligible" } }]);
      expect((await db.query("select id from emails")).rows).toHaveLength(0);
    });
    it.each(["first", "second", "otherwise"])("takes ordered branch path %s through an explicit Exit and rejects incomplete graphs", async (expected) => {
      const choose = { key: "choose", type: "branch", config: { paths: [
        { key: "first", label: "First", rule: { type: "rule", field: "event.first", operator: "eq", value: true } },
        { key: "second", label: "Second", rule: { type: "rule", field: "event.second", operator: "eq", value: true } },
      ] } };
      const connections = [{ from: "start", to: "choose", type: "default" },
        ...["first", "second", "otherwise"].map((path) => ({ from: "choose", to: "end", type: "branch", path }))];
      const body = { name: "Branch", enabled: true, steps: [start, choose, exit], connections };
      for (const edges of [connections.slice(0, -1), [...connections, connections[1]], [...connections, { from: "end", to: "choose", type: "default" }]]) {
        expect((await post(fullKey, "/automations", { ...body, connections: edges })).status).toBe(400);
      }
      const flow = await post(fullKey, "/automations", body);
      expect(flow.status, JSON.stringify(flow.json)).toBe(200);
      expect(flow.json.connections).toEqual(connections);
      await post(fullKey, "/events/send", { event: "flow.start", email: "flow@dispatch-fixture.net", payload: { first: expected === "first", second: expected !== "otherwise" } });
      const run = (await db.query("select id,tenant_id from automation_runs")).rows[0];
      await executeAutomationRun(db, run.tenant_id, run.id);
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect(await row(run.id)).toMatchObject({ state: "done", exit_reason: "exit" });
      expect((await db.query("select step_key,data from automation_steps order by started_at")).rows).toEqual([
        { step_key: "choose", data: { path: expected } }, { step_key: "end", data: { exited: "exit" } },
      ]);
      const viewer = await teammate("Viewer");
      const session = await signInAs(viewer.email, viewer.password);
      expect((await call(session.token, "GET", `/automations/${flow.json.id}/runs/${run.id}`)).json.exit_reason).toBe("exit");
      expect((await call(session.token, "PATCH", `/automations/${flow.json.id}`, { status: "paused" })).status).toBe(403);
      const foreign = await seedTenant();
      expect((await call(foreign, "GET", `/automations/${flow.json.id}/runs/${run.id}`)).status).toBe(404);
    });
    it("backfills legacy terminal reasons twice without changing explicit reasons or guards", async () => {
      const { flow, run } = await fixture();
      await executeAutomationRun(db, run.tenant_id, run.id);
      await call(fullKey, "PATCH", `/automations/${flow.id}`, { status: "paused" });
      await call(fullKey, "PATCH", `/automations/${flow.id}`, { steps: [start, exit], connections: [{ from: "start", to: "end" }] });
      expect((await row(run.id)).exit_reason).toBe("stranded");
      await db.query("update automation_runs set exit_reason=null where id=$1", [run.id]);
      await db.query(schema);
      await db.query(schema);
      expect(await row(run.id)).toMatchObject({ state: "stopped", exit_reason: "stranded", guards: [{ filter: "eligible", rule: activated }] });
      await db.query("update automation_runs set state='done',error=null,exit_reason=null where id=$1", [run.id]);
      await db.query(schema);
      expect((await row(run.id)).exit_reason).toBe("completed");
      await db.query("update automation_runs set state='stopped',exit_reason=null where id=$1", [run.id]);
      await db.query(schema);
      expect((await row(run.id)).exit_reason).toBe("stopped");
    });
  });
  describe("paused editing", () => {
    const wait = { key: "wait", type: "wait_for_event", config: {
      event_name: "edit.wake", timeout: "1 day",
      filter_rule: { type: "rule", field: "event.plan", operator: "eq", value: "pro" },
    } };
    const start = { key: "start", type: "trigger", config: { event_name: "edit.start" } };
    const after = { key: "after", type: "contact_update", config: { last_name: "Kept" } };
    const connections = [{ from: "start", to: "wait" }, { from: "wait", to: "after", type: "event_received" }];
    async function fixture(step: unknown = wait, edges: unknown[] = connections) {
      const flow = await post(fullKey, "/automations", { name: "Editing", enabled: true, steps: [start, step, after], connections: edges });
      expect(flow.status, JSON.stringify(flow.json)).toBe(200);
      await post(fullKey, "/events/send", { event: "edit.start", email: "edit@dispatch-fixture.net" });
      const run = (await db.query<{ id: string; tenant_id: string }>("select id,tenant_id from automation_runs")).rows[0]!;
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect((await call(fullKey, "PATCH", `/automations/${flow.json.id}`, { status: "paused" })).status).toBe(200);
      return { flow: flow.json, run };
    }
    const patch = (flowId: string, body: unknown, preview = false) =>
      call(fullKey, "PATCH", `/automations/${flowId}${preview ? "?dry_run=true" : ""}`, body);
    const removed = { steps: [start, after], connections: [{ from: "start", to: "after" }] };

    it("previews exact stranded counts without changing graph, runs, waits, keys or fanout, and enforces roles and tenants", async () => {
      const { flow, run } = await fixture();
      const snapshot = async () => (await db.query(`select
        (select to_jsonb(a) from automations a where id=$1) as graph,
        (select to_jsonb(r) from automation_runs r where id=$2) as run,
        (select jsonb_agg(to_jsonb(s)) from automation_steps s where run_id=$2) as steps,
        (select count(*) from email_events) as events`, [flow.id, run.id])).rows[0];
      const before = await snapshot();
      expect((await patch(flow.id, { ...removed, name: "Preview only", status: "enabled" }, true)).json)
        .toMatchObject({ stranded_runs: 1, by_step: { wait: 1 } });
      expect(await snapshot()).toEqual(before);
      expect((await patch(flow.id, { steps: [start, wait, after], connections }, true)).json).toMatchObject({ stranded_runs: 0, by_step: {} });
      const viewer = await teammate("Viewer");
      const session = await signInAs(viewer.email, viewer.password);
      expect((await call(session.token, "PATCH", `/automations/${flow.id}?dry_run=true`, removed)).status).toBe(403);
      const foreign = await seedTenant();
      expect((await call(foreign, "PATCH", `/automations/${flow.id}?dry_run=true`, removed)).status).toBe(404);
      expect((await call(fullKey, "PATCH", `/automations/${flow.id}?dry_run=yes`, removed)).status).toBe(422);
    });

    it("atomically strands removed keys, closes waits, emits once and shows the exact visible reason", async () => {
      const { flow, run } = await fixture();
      const saved = await patch(flow.id, removed);
      expect(saved.json).toMatchObject({ status: "paused", version: 1 });
      const error = "Its next step was removed or changed while the automation was paused";
      expect((await db.query("select state,error,resume_at,wait_event from automation_runs where id=$1", [run.id])).rows[0])
        .toEqual({ state: "stopped", error, resume_at: null, wait_event: null });
      expect((await db.query("select state,error,completed_at from automation_steps where run_id=$1", [run.id])).rows[0])
        .toMatchObject({ state: "failed", error: "cancelled", completed_at: expect.any(Date) });
      expect((await call(fullKey, "GET", `/automations/${flow.id}/runs/${run.id}`)).json)
        .toMatchObject({ status: "cancelled", error });
      await patch(flow.id, removed);
      expect((await db.query("select id from email_events where data->>'run_id'=$1 and type='automation.run.completed'", [run.id])).rows).toHaveLength(1);
    });

    it("preserves stored event rules, names and deadlines, then lets new arrivals use changed config", async () => {
      const { flow, run } = await fixture();
      const original = (await db.query("select resume_at,wait_event from automation_runs where id=$1", [run.id])).rows[0];
      const edited = { ...wait, config: { event_name: "new.wake", timeout: "1 hour",
        filter_rule: { type: "rule", field: "event.plan", operator: "eq", value: "free" } } };
      expect((await patch(flow.id, { steps: [start, edited, { ...after, config: { last_name: "New config" } }], connections })).status).toBe(200);
      expect((await db.query("select resume_at,wait_event from automation_runs where id=$1", [run.id])).rows[0]).toEqual(original);
      await post(fullKey, "/events/send", { event: "edit.wake", email: "edit@dispatch-fixture.net", payload: { plan: "free" } });
      expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("waiting");
      await post(fullKey, "/events/send", { event: "edit.wake", email: "edit@dispatch-fixture.net", payload: { plan: "pro" } });
      expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("ready");
      await patch(flow.id, { status: "enabled" });
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("done");
      expect((await db.query("select last_name from contacts where email='edit@dispatch-fixture.net'")).rows[0].last_name).toBe("New config");
      await post(fullKey, "/events/send", { event: "edit.start", email: "new@dispatch-fixture.net" });
      const next = (await db.query("select id from automation_runs where id<>$1", [run.id])).rows[0].id;
      await executeAutomationRun(db, run.tenant_id, next);
      expect((await db.query("select wait_event,resume_at from automation_runs where id=$1", [next])).rows[0])
        .toMatchObject({ wait_event: "new.wake", resume_at: expect.any(Date) });
      await post(fullKey, "/events/send", { event: "new.wake", email: "new@dispatch-fixture.net", payload: { plan: "free" } });
      expect((await db.query("select state from automation_runs where id=$1", [next])).rows[0].state).toBe("ready");
    });

    it("keeps a changed delay's original due time and follows the reordered kept key", async () => {
      const { flow, run } = await fixture({ key: "wait", type: "delay", config: { duration: "1 hour" } },
        [{ from: "start", to: "wait" }, { from: "wait", to: "after" }]);
      const before = (await db.query("select resume_at from automation_runs where id=$1", [run.id])).rows[0].resume_at;
      const edited = { steps: [start, after, { key: "wait", type: "delay", config: { duration: "2 days" } }],
        connections: [{ from: "start", to: "wait" }, { from: "wait", to: "after" }] };
      expect((await patch(flow.id, edited)).status).toBe(200);
      expect((await db.query("select resume_at from automation_runs where id=$1", [run.id])).rows[0].resume_at).toEqual(before);
      await db.query("update automation_runs set resume_at=now()-interval '1 second' where id=$1", [run.id]);
      await patch(flow.id, { status: "enabled" });
      const { claimAutomationRuns } = await import("../../../packages/db/src/claims.js");
      expect((await claimAutomationRuns(db, 20)).map((r) => r.id)).toEqual([run.id]);
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("done");
    });

    it("permanently reserves key types after removal, across API and direct installer writes and repeated migrations", async () => {
      const { flow } = await fixture();
      const changed = { steps: [start, { key: "wait", type: "contact_delete", config: {} }, after],
        connections: [{ from: "start", to: "wait" }, { from: "wait", to: "after" }] };
      for (const preview of [true, false]) expect((await patch(flow.id, changed, preview)).status).toBe(409);
      await patch(flow.id, removed);
      await db.query(schema);
      await db.query(schema);
      expect((await patch(flow.id, changed)).json.message).toContain("Step key wait was already used for wait_for_event");
      await expect(db.query("update automations set steps=$2,used_keys='{}' where id=$1", [flow.id, JSON.stringify(changed.steps)]))
        .rejects.toMatchObject({ code: "23514" });
      expect((await db.query("select used_keys from automations where id=$1", [flow.id])).rows[0].used_keys.wait).toBe("wait_for_event");
      expect((await patch(flow.id, { ...changed, steps: [start, { ...changed.steps[1], key: "new_delete" }, after],
        connections: [{ from: "start", to: "new_delete" }] })).status).toBe(200);
    });

    it("maps legacy waiting and nonwaiting indices against the old graph before reordering", async () => {
      const created = await post(fullKey, "/automations", { name: "Legacy editing", enabled: true, trigger: "edit.start",
        steps: [{ type: "delay", seconds: 60 }, { type: "contact_update", last_name: "Legacy kept" }] });
      const flow = created.json;
      // Simulate an installation predating explicit keys; reserve canonical legacy keys.
      await db.query("update automations set steps=$2,connections='[]' where id=$1",
        [flow.id, JSON.stringify([{ type: "delay", seconds: 60 }, { type: "contact_update", last_name: "Legacy kept" }])]);
      for (const email of ["wait@dispatch-fixture.net", "ready@dispatch-fixture.net"])
        await post(fullKey, "/events/send", { event: "edit.start", email });
      const runs = (await db.query("select id,tenant_id from automation_runs order by id")).rows;
      await db.query("update automation_runs set state='waiting',next_step_index=1,next_step_key=null,resume_at=now()-interval '1 hour' where id=$1", [runs[0].id]);
      await db.query("insert into automation_steps(id,tenant_id,run_id,step_index,type,state,data) values($1,$2,$3,0,'delay','waiting','{}')",
        [id("step"), runs[0].tenant_id, runs[0].id]);
      await db.query("update automation_runs set next_step_index=1,next_step_key=null where id=$1", [runs[1].id]);
      await patch(flow.id, { status: "paused" });
      const steps = flow.steps.slice().reverse();
      expect((await patch(flow.id, { steps, connections: flow.connections }, true)).json.stranded_runs).toBe(0);
      expect((await db.query("select step_key from automation_steps where run_id=$1", [runs[0].id])).rows[0].step_key).toBeNull();
      expect((await patch(flow.id, { steps, connections: flow.connections })).status).toBe(200);
      expect((await db.query("select next_step_key from automation_runs where id=$1", [runs[0].id])).rows[0].next_step_key).toBe("step_1");
      expect((await db.query("select next_step_key from automation_runs where id=$1", [runs[1].id])).rows[0].next_step_key).toBe("step_2");
      expect((await db.query("select step_key from automation_steps where run_id=$1", [runs[0].id])).rows[0].step_key).toBe("step_1");
      await patch(flow.id, { status: "enabled" });
      const { claimAutomationRuns } = await import("../../../packages/db/src/claims.js");
      await claimAutomationRuns(db, 20);
      for (const run of runs) await executeAutomationRun(db, run.tenant_id, run.id);
      expect((await db.query("select state from automation_runs")).rows).toEqual([{ state: "done" }, { state: "done" }]);
    });

    it("rolls back graph, version, legacy mapping, cancellations and events when a later graph write fails", async () => {
      const { flow, run } = await fixture();
      expect((await post(fullKey, "/automations", { name: "Name conflict",
        steps: [{ key: "start", type: "trigger", config: { event_name: "other" } }], connections: [] })).status).toBe(200);
      const before = (await db.query("select version,steps,used_keys from automations where id=$1", [flow.id])).rows[0];
      expect((await patch(flow.id, { ...removed, name: "Name conflict" })).status).toBe(409);
      expect((await db.query("select version,steps,used_keys from automations where id=$1", [flow.id])).rows[0]).toEqual(before);
      expect((await db.query("select state,error from automation_runs where id=$1", [run.id])).rows[0]).toEqual({ state: "waiting", error: null });
      expect((await db.query("select state from automation_steps where run_id=$1", [run.id])).rows[0].state).toBe("waiting");
      expect((await db.query("select id from email_events where data->>'run_id'=$1 and type='automation.run.completed'", [run.id])).rows).toHaveLength(0);
    });

    it("locks active runs before saving and does not miss a wake event arriving during the save", async () => {
      const { flow, run } = await fixture();
      const locker = await db.connect();
      let pending: ReturnType<typeof post> | undefined;
      try {
        await locker.query("begin");
        await locker.query("select id from automations where id=$1 for update", [flow.id]);
        await locker.query("select id from automation_runs where id=$1 for update", [run.id]);
        pending = post(fullKey, "/events/send", { event: "edit.wake", email: "edit@dispatch-fixture.net", payload: { plan: "pro" } });
        let waiting = false;
        for (let n = 0; n < 100 && !waiting; n++) {
          waiting = (await db.query("select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%as wait_config%'")).rows.length > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await locker.query("commit");
        expect((await pending).status).toBe(202);
        expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("ready");
        expect((await patch(flow.id, { steps: [start, wait, after], connections })).json.version).toBe(1);
      } finally {
        await locker.query("rollback");
        locker.release();
        await pending;
      }
    });
    it("cannot expose a new graph or version until it obtains every active run lock", async () => {
      const { flow, run } = await fixture();
      const locker = await db.connect();
      let pending: ReturnType<typeof patch> | undefined;
      try {
        await locker.query("begin");
        await locker.query("select id from automation_runs where id=$1 for update", [run.id]);
        pending = patch(flow.id, removed);
        let waiting = false;
        for (let n = 0; n < 100 && !waiting; n++) {
          waiting = (await db.query(`select 1 from pg_stat_activity where wait_event_type='Lock'
            and query like 'select id, next_step_key, next_step_index%'`)).rows.length > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        expect((await db.query("select version from automations where id=$1", [flow.id])).rows[0].version).toBe(0);
        expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("waiting");
        await locker.query("commit");
        expect((await pending).json.version).toBe(1);
        expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("stopped");
      } finally {
        await locker.query("rollback");
        locker.release();
        await pending;
      }
    });
    it("cancels every active run when disabling and saving a graph together", async () => {
      const flow = await post(fullKey, "/automations", { name: "No work yet", enabled: true, steps: [start], connections: [] });
      await post(fullKey, "/events/send", { event: "edit.start", email: "empty@dispatch-fixture.net" });
      const run = (await db.query("select id from automation_runs")).rows[0];
      expect((await patch(flow.json.id, { status: "disabled", connections: [] })).status).toBe(200);
      expect((await db.query("select state,error from automation_runs where id=$1", [run.id])).rows[0])
        .toEqual({ state: "stopped", error: null });
    });
    it("backfills an already keyed legacy wait's stored rule once across repeated migrations", async () => {
      const legacySteps = [{ type: "wait", event: "edit.wake", timeout_seconds: 3600, filter_rule: wait.config.filter_rule }];
      const flow = await post(fullKey, "/automations", { name: "Old wait", enabled: true, trigger: "edit.start", steps: legacySteps });
      expect(flow.status).toBe(200);
      await db.query("update automations set steps=$2,connections='[]' where id=$1", [flow.json.id, JSON.stringify(legacySteps)]);
      await post(fullKey, "/events/send", { event: "edit.start", email: "legacy-wait@dispatch-fixture.net" });
      const run = (await db.query("select id,tenant_id from automation_runs")).rows[0];
      await executeAutomationRun(db, run.tenant_id, run.id);
      await db.query("update automation_steps set data=data-'wait_config' where run_id=$1", [run.id]);
      await db.query(schema);
      await db.query(schema);
      expect((await db.query("select data->'wait_config' as config from automation_steps where run_id=$1", [run.id])).rows[0].config)
        .toMatchObject({ filter_rule: wait.config.filter_rule });
      await patch(flow.json.id, { status: "paused" });
      const graph = flow.json.steps;
      graph[1].config.filter_rule.value = "free";
      expect((await patch(flow.json.id, { steps: graph, connections: flow.json.connections })).status).toBe(200);
      await post(fullKey, "/events/send", { event: "edit.wake", email: "legacy-wait@dispatch-fixture.net", payload: { plan: "free" } });
      expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("waiting");
      await post(fullKey, "/events/send", { event: "edit.wake", email: "legacy-wait@dispatch-fixture.net", payload: { plan: "pro" } });
      expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("ready");
    });
  });
  describe("pause execution", () => {
    async function flow(steps: unknown[] = [], connections: unknown[] = [], config: unknown = { event_name: "pause.start" }) {
      const response = await post(fullKey, "/automations", {
        name: "Pause fixture", status: "enabled", reentry: "every_time",
        steps: [{ key: "start", type: "trigger", config }, ...steps], connections,
      });
      expect(response.status, JSON.stringify(response.json)).toBe(200);
      return response.json;
    }
    async function patch(flowId: string, body: unknown) {
      return call(fullKey, "PATCH", `/automations/${flowId}`, body);
    }
    async function started() {
      expect((await post(fullKey, "/events/send", { event: "pause.start", email: "pause@dispatch-fixture.net" })).status).toBe(202);
      return (await db.query<{ id: string; tenant_id: string }>("select id,tenant_id from automation_runs")).rows[0]!;
    }
    async function claims() {
      const { claimAutomationRuns } = await import("../../../packages/db/src/claims.js");
      return claimAutomationRuns(db, 20);
    }
    it("maps status transitions, legacy booleans, versions, filters and duplicates with role and tenant protection", async () => {
      const item = await flow();
      expect(item).toMatchObject({ status: "enabled", version: 0 });
      const run = await started();
      expect((await patch(item.id, { status: "paused" })).json.status).toBe("paused");
      const pausedAt = (await db.query("select paused_at from automations where id=$1", [item.id])).rows[0].paused_at;
      await patch(item.id, { status: "paused" });
      expect((await db.query("select paused_at from automations where id=$1", [item.id])).rows[0].paused_at).toEqual(pausedAt);
      expect((await call(fullKey, "GET", "/automations?status=paused")).json.data.map((row: any) => row.id)).toEqual([item.id]);
      expect((await call(fullKey, "GET", "/automations?status=enabled")).json.data).toEqual([]);
      const copy = await post(fullKey, `/automations/${item.id}/duplicate`, {});
      expect(copy.json).toMatchObject({ status: "disabled", version: 0, reentry: "every_time", trigger_config: item.trigger_config });
      expect((await patch(copy.json.id, { status: "paused" })).status).toBe(409);
      const viewer = await teammate("Viewer");
      const session = await signInAs(viewer.email, viewer.password);
      expect((await call(session.token, "PATCH", `/automations/${item.id}`, { status: "enabled" })).status).toBe(403);
      const foreign = await seedTenant();
      expect((await call(foreign, "PATCH", `/automations/${item.id}`, { status: "paused" })).status).toBe(404);
      expect((await patch(item.id, { enabled: true })).json.status).toBe("enabled");
      expect((await patch(item.id, { enabled: false })).json.status).toBe("disabled");
      expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("stopped");
      expect((await patch(item.id, { status: "paused" })).status).toBe(409);
      const saved = await patch(item.id, { connections: [] });
      expect(saved.json.version).toBe(1);
      expect((await patch(item.id, { name: "Renamed pause" })).json.version).toBe(1);
      await db.query(schema);
      await db.query(schema);
      expect((await call(fullKey, "GET", `/automations/${item.id}`)).json).toMatchObject({ status: "disabled", version: 1 });
      await patch(item.id, { status: "enabled" });
      await patch(item.id, { status: "paused" });
      expect((await post(fullKey, `/automations/${item.id}/stop`, {})).json.status).toBe("disabled");
      expect((await db.query("select paused_at from automations where id=$1", [item.id])).rows[0].paused_at).toBeNull();
    });

    it("records paused events and current contact writes without enrolling or replaying missed triggers", async () => {
      expect((await post(fullKey, "/contact-properties", { key: "plan", type: "string" })).status).toBe(200);
      const item = await flow([], [], { type: "contact_updated", field: "plan" });
      const contact = await post(fullKey, "/contacts", { email: "pause@dispatch-fixture.net", properties: { plan: "free" } });
      await patch(item.id, { status: "paused" });
      expect((await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { properties: { plan: "pro" } })).status).toBe(200);
      expect((await post(fullKey, "/events/send", { event: "pause.start", email: "pause@dispatch-fixture.net" })).status).toBe(202);
      expect((await db.query("select properties from contacts where id=$1", [contact.json.id])).rows[0].properties).toEqual({ plan: "pro" });
      expect((await db.query("select to_value from contact_changes where contact_id=$1 and field='plan' order by created_at", [contact.json.id])).rows.map((r) => r.to_value)).toEqual(["free", "pro"]);
      expect((await db.query("select id from custom_events where name='pause.start'")).rows).toHaveLength(1);
      expect((await db.query("select id from automation_runs")).rows).toHaveLength(0);
      await patch(item.id, { status: "enabled" });
      expect(await claims()).toEqual([]);
      expect((await db.query("select id from automation_runs")).rows).toHaveLength(0);
      await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { properties: { plan: "paid" } });
      expect((await db.query("select id from automation_runs")).rows).toHaveLength(1);
    });
    it("can pause a flow after its trigger resource is deleted but refuses to resume it", async () => {
      const topic = await post(fullKey, "/topics", { name: "Pause resource" });
      const item = await flow([], [], { type: "topic_subscribed", topic_id: topic.json.id });
      expect((await call(fullKey, "DELETE", `/topics/${topic.json.id}`)).status).toBe(200);
      expect((await patch(item.id, { status: "paused" })).json.status).toBe("paused");
      expect((await patch(item.id, { status: "enabled" })).status).toBe(422);
      expect((await call(fullKey, "GET", `/automations/${item.id}`)).json.status).toBe("paused");
    });
    it("serializes a concurrent event with pause without queueing a missed trigger", async () => {
      const item = await flow();
      const locker = await db.connect();
      let pending: ReturnType<typeof post> | undefined;
      try {
        await locker.query("begin");
        await locker.query("update automations set paused_at=now() where id=$1", [item.id]);
        pending = post(fullKey, "/events/send", { event: "pause.start", email: "race@dispatch-fixture.net" });
        let waiting = false;
        for (let n = 0; n < 100 && !waiting; n++) {
          waiting = (await db.query(`select 1 from pg_stat_activity where wait_event_type='Lock'
            and query like '%trigger_type = $2%' and query like '%for share%'`)).rows.length > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await locker.query("commit");
        expect((await pending).status).toBe(202);
        expect((await db.query("select id from automation_runs")).rows).toHaveLength(0);
        expect((await db.query("select id from custom_events where name='pause.start'")).rows).toHaveLength(1);
        await patch(item.id, { status: "enabled" });
        expect(await claims()).toEqual([]);
      } finally {
        await locker.query("rollback");
        locker.release();
        await pending;
      }
    });
    it("holds an existing enrollment job and lets other jobs progress until resume", async () => {
      const item = await flow([], [], { type: "contact_updated", field: "first_name" });
      await post(fullKey, "/contacts", { email: "enroll@dispatch-fixture.net", first_name: "Current" });
      const job = await post(fullKey, `/automations/${item.id}/enroll`, { all: true });
      expect(job.status).toBe(202);
      await patch(item.id, { status: "paused" });
      const { processEnrollmentBatch, processEnrollmentJobs } = await import("../../../packages/db/src/enrollment-jobs.js");
      const tenant = (await db.query("select tenant_id from automations where id=$1", [item.id])).rows[0].tenant_id;
      expect((await processEnrollmentBatch(db, tenant, item.id, job.json.id))?.status).toBe("queued");
      expect(await processEnrollmentJobs(db)).toBe(0);
      expect((await db.query("select id from automation_runs")).rows).toHaveLength(0);
      await patch(item.id, { status: "enabled" });
      expect((await processEnrollmentBatch(db, tenant, item.id, job.json.id))?.counts).toMatchObject({ enrolled: 1 });
      expect((await db.query("select id from automation_runs")).rows).toHaveLength(1);
    });

    it.each(["delay", "event", "timeout"])("holds %s waits, preserves due times, and resumes once", async (mode) => {
      const item = await flow([
        { key: "wait", type: mode === "delay" ? "delay" : "wait_for_event",
          config: mode === "delay" ? { duration: "1 hour" } : { event_name: "pause.wake", timeout: "1 hour" } },
        { key: "after", type: "contact_update", config: { last_name: "Resumed" } },
      ], [{ from: "start", to: "wait" }, { from: "wait", to: "after", type: mode === "event" ? "event_received" : mode === "timeout" ? "timeout" : "default" }]);
      const run = await started();
      await executeAutomationRun(db, run.tenant_id, run.id);
      await patch(item.id, { status: "paused" });
      if (mode !== "event") await db.query("update automation_runs set resume_at=now()-interval '1 hour' where id=$1", [run.id]);
      const before = (await db.query("select state,resume_at,wait_event,next_step_key from automation_runs where id=$1", [run.id])).rows[0];
      expect(await claims()).toEqual([]);
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect((await db.query("select state,resume_at,wait_event,next_step_key from automation_runs where id=$1", [run.id])).rows[0]).toEqual(before);
      if (mode === "event") {
        await post(fullKey, "/events/send", { event: "pause.wake", email: "PAUSE@dispatch-fixture.net" });
        expect((await db.query("select state,resume_data from automation_runs where id=$1", [run.id])).rows[0]).toMatchObject({ state: "ready", resume_data: { event_id: expect.any(String) } });
        await executeAutomationRun(db, run.tenant_id, run.id);
        expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("ready");
      }
      await patch(item.id, { status: "enabled" });
      expect((await claims()).map((r) => r.id)).toEqual([run.id]);
      await executeAutomationRun(db, run.tenant_id, run.id);
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("done");
      expect((await db.query("select state from automation_steps where run_id=$1", [run.id])).rows).toEqual([{ state: "done" }, { state: "done" }]);
    });

    it("excludes ready, due waiting and stuck running paused runs while claiming ordinary flows", async () => {
      const item = await flow();
      const run = await started();
      await patch(item.id, { status: "paused" });
      for (const state of ["ready", "waiting", "running"]) {
        await db.query("update automation_runs set state=$2,resume_at=now()-interval '1 day',updated_at=now()-interval '1 day' where id=$1", [run.id, state]);
        expect(await claims()).toEqual([]);
        expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe(state);
      }
      await post(fullKey, "/automations", { name: "Ordinary", enabled: true, trigger: "ordinary", steps: [{ type: "delay", seconds: 60 }] });
      await post(fullKey, "/events/send", { event: "ordinary", email: "normal@dispatch-fixture.net" });
      expect(await claims()).toHaveLength(1);
    });
    it("reads a fresh version after waiting for a graph save's run lock", async () => {
      const item = await flow([{ key: "edit", type: "contact_update", config: { last_name: "Guarded" } }], [{ from: "start", to: "edit" }]);
      const run = await started();
      const locker = await db.connect();
      let contended = false;
      const wrapped = {
        query: db.query.bind(db),
        connect: async () => {
          const client = await db.connect();
          return {
            release: () => client.release(),
            query: async (sql: string, params?: unknown[]) => {
              if (!contended && sql.startsWith("select r.id, r.automation_id")) {
                contended = true;
                await locker.query("begin");
                await locker.query("select id from automations where id=$1 for update", [item.id]);
                await locker.query("select id from automation_runs where id=$1 for update", [run.id]);
                const pending = client.query(sql, params);
                let waiting = false;
                for (let n = 0; n < 100 && !waiting; n++) {
                  waiting = (await db.query(`select 1 from pg_stat_activity where wait_event_type='Lock'
                    and query like 'select r.id, r.automation_id%'`)).rows.length > 0;
                  if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
                }
                await locker.query("update automations set version=version+1 where id=$1", [item.id]);
                await locker.query("commit");
                const result = await pending;
                expect(waiting).toBe(true);
                return result;
              }
              return client.query(sql, params);
            },
          };
        },
      } as unknown as Db;
      try {
        await executeAutomationRun(wrapped, run.tenant_id, run.id);
        expect(contended).toBe(true);
        expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("ready");
        expect((await db.query("select id from automation_steps where run_id=$1", [run.id])).rows).toHaveLength(0);
        await executeAutomationRun(db, run.tenant_id, run.id);
        expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("done");
      } finally {
        await locker.query("rollback");
        locker.release();
      }
    });

    it.each(["pause", "version"])("holds before the next non-wait step after a committed %s, then loads fresh graph and contact state", async (change) => {
      const item = await flow([
        { key: "first", type: "contact_update", config: { first_name: "First" } },
        { key: "check", type: "condition", config: { type: "rule", field: "contact.plan", operator: "eq", value: "pro" } },
        { key: "last", type: "contact_update", config: { last_name: "Original" } },
      ], [{ from: "start", to: "first" }, { from: "first", to: "check" }, { from: "check", to: "last", type: "condition_met" }]);
      const run = await started();
      let interrupted = false;
      const wrapped = {
        query: db.query.bind(db),
        connect: async () => {
          const client = await db.connect();
          return {
            release: () => client.release(),
            query: async (sql: string, params?: unknown[]) => {
              const result = await client.query(sql, params);
              if (sql === "commit" && !interrupted && (await db.query("select id from automation_steps where run_id=$1 and step_key='first'", [run.id])).rows.length) {
                interrupted = true;
                if (change === "pause") await patch(item.id, { status: "paused" });
                else await db.query("update automations set version=version+1 where id=$1", [item.id]);
              }
              return result;
            },
          };
        },
      } as unknown as Db;
      await executeAutomationRun(wrapped, run.tenant_id, run.id);
      expect(interrupted).toBe(true);
      expect((await db.query("select state,next_step_key from automation_runs where id=$1", [run.id])).rows[0]).toEqual({ state: "ready", next_step_key: "check" });
      expect((await db.query("select step_key from automation_steps where run_id=$1", [run.id])).rows).toEqual([{ step_key: "first" }]);
      // Fixture-only graph mutation exercises reload; safe paused editing belongs to the next leaf.
      const graph = structuredClone(item.steps);
      graph.find((s: any) => s.key === "last").config.last_name = "New graph";
      await db.query("update automations set steps=$2::jsonb,version=version+1 where id=$1", [item.id, JSON.stringify(graph)]);
      const contact = (await db.query("select id from contacts where email='pause@dispatch-fixture.net'")).rows[0];
      await call(fullKey, "PATCH", `/contacts/${contact.id}`, { properties: { plan: "pro" } });
      await patch(item.id, { status: "enabled" });
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("done");
      expect((await db.query("select last_name from contacts where id=$1", [contact.id])).rows[0].last_name).toBe("New graph");
      expect((await db.query("select data from automation_steps where run_id=$1 and step_key='check'", [run.id])).rows[0].data).toEqual({ result: true });
    });
  });
  describe("bulk enrollment", () => {
    // These modules are loaded only inside live tests, so the acceptance fixtures can land
    // independently of the worker implementation.
    async function enrollmentProcessor() {
      const module = "../../../packages/db/src/enrollment-jobs.js";
      return (await import(module)).processEnrollmentBatch as (
        db: Db, tenantId: string, automationId: string, jobId: string,
      ) => Promise<any>;
    }

    async function runClaimer() {
      const module = "../../../packages/db/src/claims.js";
      return (await import(module)).claimAutomationRuns as (
        db: Db, limit: number, state?: { normal: string; bulk: string },
      ) => Promise<Array<{ id: string; tenant_id: string; automation_id: string; priority: string; wait_event: string | null }>>;
    }

    async function tenantFor(automationId: string) {
      return (await db.query<{ tenant_id: string }>(
        "select tenant_id from automations where id=$1", [automationId],
      )).rows[0]!.tenant_id;
    }

    async function contactsFor(tenantId: string, count: number) {
      const prefix = id("contact");
      return (await db.query<{ id: string; email: string }>(
        `insert into contacts (id,tenant_id,email,first_name,properties,created_at)
         select $1 || lpad(n::text,6,'0'),$2,$1 || n || '@example.com','Unchanged',
                '{"plan":"free"}'::jsonb,now()-interval '1 day'
         from generate_series(1,$3::int) n returning id,email`, [prefix, tenantId, count],
      )).rows;
    }

    async function queueEnrollment(automationId: string, body: unknown = { all: true }) {
      const response = await post(fullKey, `/automations/${automationId}/enroll`, body);
      expect(response.status, JSON.stringify(response.json)).toBe(202);
      expect(response.json).toMatchObject({
        status: "queued", counts: { processed: 0, enrolled: 0, skipped: 0, failed: 0 },
      });
      return response.json;
    }

    async function enrollmentJob(automationId: string, jobId: string) {
      const response = await call(fullKey, "GET", `/automations/${automationId}/enroll-jobs/${jobId}`);
      expect(response.status).toBe(200);
      return response.json;
    }

    async function backlog(automationId: string, count: number, priority: "normal" | "bulk" = "bulk") {
      const tenant = await tenantFor(automationId);
      const event = id("event");
      await db.query(
        "insert into custom_events (id,tenant_id,request_id,name) values ($1,$2,$3,'fixture.backlog')",
        [event, tenant, id("request")],
      );
      const prefix = id("run");
      return (await db.query<{ id: string }>(
        `insert into automation_runs (id,tenant_id,automation_id,event_id,priority,created_at)
         select $1 || lpad(n::text,6,'0'),$2,$3,$4,$5,now()-interval '1 day'
         from generate_series(1,$6::int) n returning id`,
        [prefix, tenant, automationId, event, priority, count],
      )).rows;
    }

    it("enrollment pages a current tenant snapshot in batches of 500 without changing contacts or applying from and to", async () => {
      await post(fullKey, "/contact-properties", { key: "plan", type: "string" });
      const flow = await contactFlow({ type: "contact_updated", field: "plan", from: "paid", to: "cancelled" });
      const tenant = await tenantFor(flow);
      const contacts = await contactsFor(tenant, 1002);
      await call(fullKey, "DELETE", `/contacts/${contacts[0]!.id}`);
      const otherKey = await seedTenant();
      const foreign = await post(otherKey, "/contacts", { email: "foreign-enrollment@example.com" });
      const before = (await db.query(
        "select id,email,first_name,last_name,properties,unsubscribed_at,updated_at,deleted_at from contacts where tenant_id=$1 order by id", [tenant],
      )).rows;
      const job = await queueEnrollment(flow);
      // Even an ID beyond the page cursor must not admit a contact created after the job.
      const future = await post(fullKey, "/contacts", { email: "future-enrollment@example.com" });
      await db.query("update contacts set created_at=now()+interval '1 day' where id=$1", [future.json.id]);
      const history = (await db.query("select count(*)::int as count from contact_changes")).rows[0].count;
      const process = await enrollmentProcessor();
      await process(db, tenant, flow, job.id);
      expect(await enrollmentJob(flow, job.id)).toMatchObject({
        status: "in_progress", counts: { total: 1001, processed: 500, enrolled: 500, skipped: 0, failed: 0 },
      });
      // Competing retries serialize on the job; neither can replay its preceding page.
      await Promise.all([process(db, tenant, flow, job.id), process(db, tenant, flow, job.id)]);
      await process(db, tenant, flow, job.id);
      const finished = await enrollmentJob(flow, job.id);
      expect(finished).toMatchObject({
        status: "completed", counts: { total: 1001, processed: 1001, enrolled: 1001, skipped: 0, failed: 0 },
      });
      await process(db, tenant, flow, job.id);
      const repeated = await enrollmentJob(flow, job.id);
      delete repeated.request_id;
      delete finished.request_id;
      expect(repeated).toEqual(finished);
      expect((await db.query(
        `select count(*)::int as runs,count(distinct contact_id)::int as contacts,
                bool_and(priority='bulk') as bulk from automation_runs where automation_id=$1`, [flow],
      )).rows[0]).toEqual({ runs: 1001, contacts: 1001, bulk: true });
      expect((await db.query(
        "select id from automation_runs where contact_id=any($1::text[])",
        [[contacts[0]!.id, foreign.json.id, future.json.id]],
      )).rows).toHaveLength(0);
      expect((await db.query(
        "select id,email,first_name,last_name,properties,unsubscribed_at,updated_at,deleted_at from contacts where tenant_id=$1 and id<>$2 order by id",
        [tenant, future.json.id],
      )).rows).toEqual(before);
      expect((await db.query("select count(*)::int as count from contact_changes")).rows[0].count).toBe(history);
    }, 30_000);

    it("enrollment rolls back a failed page atomically and retries without duplicate events runs or counts", async () => {
      const flow = await contactFlow({ type: "contact_updated", field: "first_name" });
      expect((await call(fullKey, "PATCH", `/automations/${flow}`, { reentry: "once" })).status).toBe(200);
      const tenant = await tenantFor(flow);
      await contactsFor(tenant, 501);
      const job = await queueEnrollment(flow);
      const process = await enrollmentProcessor();
      const events = (await db.query("select count(*)::int as count from custom_events")).rows[0].count;
      // Fail midway through a real SQL page, not before any work has been attempted.
      await db.query(`create or replace function reject_enrollment_run() returns trigger language plpgsql as $$
        begin
          if (select count(*) from automation_runs where automation_id=new.automation_id) >= 10
          then raise exception 'synthetic enrollment failure'; end if;
          return new;
        end $$;
        create trigger reject_enrollment_run before insert on automation_runs
        for each row execute function reject_enrollment_run()`);
      try {
        let failure: unknown;
        try { await process(db, tenant, flow, job.id); } catch (error) { failure = error; }
        const failed = await enrollmentJob(flow, job.id);
        expect(Boolean(failure) || failed.status === "failed").toBe(true);
        expect(failed.counts).toMatchObject({ processed: 0, enrolled: 0, skipped: 0 });
        expect(await flowRuns(flow)).toHaveLength(0);
        expect((await db.query("select count(*)::int as count from custom_events")).rows[0].count).toBe(events);
        expect((await db.query("select contact_id from automation_enrollments where automation_id=$1", [flow])).rows).toHaveLength(0);
      } finally {
        await db.query("drop trigger reject_enrollment_run on automation_runs; drop function reject_enrollment_run()");
      }
      // Model a worker retry after the fault is repaired, retaining the original job identity.
      await db.query("update automation_enrollment_jobs set status='queued' where id=$1", [job.id]);
      await process(db, tenant, flow, job.id);
      await process(db, tenant, flow, job.id);
      await process(db, tenant, flow, job.id);
      expect(await enrollmentJob(flow, job.id)).toMatchObject({
        status: "completed", counts: { total: 501, processed: 501, enrolled: 501, skipped: 0, failed: 0 },
      });
      expect((await db.query(
        "select count(*)::int as runs,count(distinct contact_id)::int as contacts from automation_runs where automation_id=$1", [flow],
      )).rows[0]).toEqual({ runs: 501, contacts: 501 });
    }, 30_000);

    it("enrollment cancellation stops future pages and preserves already queued runs", async () => {
      const flow = await contactFlow({ type: "contact_updated", field: "first_name" });
      const tenant = await tenantFor(flow);
      await contactsFor(tenant, 501);
      const process = await enrollmentProcessor();
      const job = await queueEnrollment(flow);
      await process(db, tenant, flow, job.id);
      const before = (await db.query(
        "select id,state,updated_at from automation_runs where automation_id=$1 order by id", [flow],
      )).rows;
      expect(before).toHaveLength(500);
      const viewer = await teammate("Viewer");
      const session = await signInAs(viewer.email, viewer.password);
      expect((await call(session.token, "DELETE", `/automations/${flow}/enroll-jobs/${job.id}`)).status).toBe(403);
      expect((await call(session.token, "GET", `/automations/${flow}/enroll-jobs/${job.id}`)).status).toBe(200);
      expect((await call(fullKey, "DELETE", `/automations/${flow}/enroll-jobs/${job.id}`)).status).toBe(200);
      await Promise.all([process(db, tenant, flow, job.id), process(db, tenant, flow, job.id)]);
      expect(await enrollmentJob(flow, job.id)).toMatchObject({
        status: "cancelled", counts: { total: 501, processed: 500, enrolled: 500, skipped: 0, failed: 0 },
      });
      expect((await db.query(
        "select id,state,updated_at from automation_runs where automation_id=$1 order by id", [flow],
      )).rows).toEqual(before);
      const untouched = await queueEnrollment(flow);
      await call(fullKey, "DELETE", `/automations/${flow}/enroll-jobs/${untouched.id}`);
      await process(db, tenant, flow, untouched.id);
      expect((await enrollmentJob(flow, untouched.id)).counts.processed).toBe(0);
      expect(await flowRuns(flow)).toHaveLength(500);
      await db.query(schema);
      await db.query(schema);
      expect((await enrollmentJob(flow, job.id)).status).toBe("cancelled");
    }, 30_000);

    it("enrollment worker retries transient transaction failures and exposes permanent failures without partial work", async () => {
      const flow = await contactFlow({ type: "contact_updated", field: "first_name" });
      const tenant = await tenantFor(flow);
      await contactsFor(tenant, 11);
      const job = await queueEnrollment(flow);
      const { processEnrollmentJobs } = await import("../../../packages/db/src/enrollment-jobs.js");
      const { nextWorkAt } = await import("../../worker/src/runtime.js");
      expect(await nextWorkAt(db)).not.toBeNull();
      await db.query(`create or replace function transient_enrollment_failure() returns trigger language plpgsql as $$
        begin raise exception 'retry page' using errcode='40001'; end $$;
        create trigger transient_enrollment_failure before insert on automation_runs
        for each row execute function transient_enrollment_failure()`);
      try {
        await processEnrollmentJobs(db);
        expect((await enrollmentJob(flow, job.id)).status).toBe("queued");
        expect(await flowRuns(flow)).toHaveLength(0);
        await db.query(`create or replace function transient_enrollment_failure() returns trigger language plpgsql as $$
          begin raise exception 'permanent page failure'; end $$`);
        await processEnrollmentJobs(db);
        expect(await enrollmentJob(flow, job.id)).toMatchObject({
          status: "failed", error: "permanent page failure", counts: { processed: 0, enrolled: 0 },
        });
        expect(await flowRuns(flow)).toHaveLength(0);
      } finally {
        await db.query("drop trigger transient_enrollment_failure on automation_runs; drop function transient_enrollment_failure()");
      }
    });

    it("enrollment respects static segments global once and once per job for every-time flows", async () => {
      const once = await post(fullKey, "/automations", { name: "Once enrollment", enabled: true, reentry: "once", steps: [
        { key: "start", type: "trigger", config: { type: "contact_updated", field: "first_name" } },
      ] });
      expect(once.status).toBe(200);
      const tenant = await tenantFor(once.json.id);
      const contacts = await contactsFor(tenant, 4);
      const segment = await post(fullKey, "/segments", { name: "Enrollment subset" });
      for (const contact of contacts.slice(0, 3)) {
        expect((await post(fullKey, `/contacts/${contact.id}/segments/${segment.json.id}`, {})).status).toBe(200);
      }
      await call(fullKey, "PATCH", `/contacts/${contacts[0]!.id}`, { first_name: "Already entered" });
      const every = await contactFlow({ type: "contact_updated", field: "first_name" });
      const process = await enrollmentProcessor();
      const onceJob = await queueEnrollment(once.json.id, { segment_id: segment.json.id });
      await Promise.all([process(db, tenant, once.json.id, onceJob.id), process(db, tenant, once.json.id, onceJob.id)]);
      expect(await enrollmentJob(once.json.id, onceJob.id)).toMatchObject({
        status: "completed", counts: { total: 3, processed: 3, enrolled: 2, skipped: 1, failed: 0 },
      });
      const again = await queueEnrollment(once.json.id, { segment_id: segment.json.id });
      await process(db, tenant, once.json.id, again.id);
      expect((await enrollmentJob(once.json.id, again.id)).counts).toMatchObject({ enrolled: 0, skipped: 3 });
      expect(await flowRuns(once.json.id)).toHaveLength(3);
      for (let pass = 0; pass < 2; pass++) {
        const job = await queueEnrollment(every, { segment_id: segment.json.id });
        await Promise.all([process(db, tenant, every, job.id), process(db, tenant, every, job.id)]);
        expect((await enrollmentJob(every, job.id)).counts).toMatchObject({ total: 3, processed: 3, enrolled: 3, skipped: 0 });
        expect(await flowRuns(every)).toHaveLength((pass + 1) * 3);
      }
      expect((await db.query("select id from automation_runs where contact_id=$1", [contacts[3]!.id])).rows).toHaveLength(0);
    });

    it("enrollment validates bodies permissions tenant ownership and scoped idempotency keys", async () => {
      const flow = await contactFlow({ type: "contact_updated", field: "first_name" });
      const second = await contactFlow({ type: "contact_updated", field: "last_name" });
      const segment = await post(fullKey, "/segments", { name: "Idempotent enrollment" });
      const body = { all: true };
      const headers = { "idempotency-key": id("request") };
      const first = await post(fullKey, `/automations/${flow}/enroll`, body, headers);
      expect(first.status).toBe(202);
      const retry = await post(fullKey, `/automations/${flow}/enroll`, body, headers);
      expect(retry.status).toBe(202);
      expect(retry.json.id).toBe(first.json.id);
      expect((await post(fullKey, `/automations/${flow}/enroll`, { segment_id: segment.json.id }, headers)).status).toBe(409);
      const next = await post(fullKey, `/automations/${second}/enroll`, body, headers);
      expect(next.status).toBe(202);
      expect(next.json.id).not.toBe(first.json.id);
      const concurrentHeaders = { "idempotency-key": id("request") };
      const races = await Promise.all([1, 2].map(() => post(fullKey, `/automations/${flow}/enroll`, body, concurrentHeaders)));
      expect(races.map((row) => row.status)).toEqual([202, 202]);
      expect(races[0]!.json.id).toBe(races[1]!.json.id);
      for (const invalid of [{}, { all: false }, { all: "true" }, { segment_id: "" }, { all: true, segment_id: segment.json.id }, { all: true, unknown: true }]) {
        expect((await post(fullKey, `/automations/${flow}/enroll`, invalid)).status).toBe(400);
      }
      const viewer = await teammate("Viewer");
      const session = await signInAs(viewer.email, viewer.password);
      expect((await post(session.token, `/automations/${flow}/enroll`, body)).status).toBe(403);
      const otherKey = await seedTenant();
      expect((await post(otherKey, `/automations/${flow}/enroll`, body, headers)).status).toBe(404);
      expect((await call(otherKey, "GET", `/automations/${flow}/enroll-jobs/${first.json.id}`)).status).toBe(404);
      expect((await call(otherKey, "DELETE", `/automations/${flow}/enroll-jobs/${first.json.id}`)).status).toBe(404);
      expect((await call(fullKey, "GET", `/automations/${second}/enroll-jobs/${first.json.id}`)).status).toBe(404);
      expect((await call(fullKey, "DELETE", `/automations/${second}/enroll-jobs/${first.json.id}`)).status).toBe(404);
      const foreignSegment = await post(otherKey, "/segments", { name: "Foreign enrollment" });
      expect((await post(fullKey, `/automations/${flow}/enroll`, { segment_id: foreignSegment.json.id })).status).toBe(404);
      await call(fullKey, "DELETE", `/segments/${segment.json.id}`);
      expect((await post(fullKey, `/automations/${flow}/enroll`, { segment_id: segment.json.id })).status).toBe(404);
      const event = await post(fullKey, "/automations", { name: "Event enrollment refused", enabled: true, trigger: "enrollment.event", steps: [{ type: "delay", seconds: 1 }] });
      expect((await post(fullKey, `/automations/${event.json.id}/enroll`, body)).status).toBe(409);
      await call(fullKey, "PATCH", `/automations/${second}`, { enabled: false });
      expect((await post(fullKey, `/automations/${second}/enroll`, body)).status).toBe(409);
      // Temporary disposable-database columns exercise forward-compatible guards before L3/L6.
      const pause = (await db.query("select to_jsonb(a) ? 'paused_at' as supported from automations a where id=$1", [flow])).rows[0].supported;
      if (!pause) await db.query("alter table automations add column paused_at timestamptz");
      try {
        await db.query("update automations set paused_at=now() where id=$1", [flow]);
        expect((await post(fullKey, `/automations/${flow}/enroll`, body)).status).toBe(409);
      } finally {
        await db.query("update automations set paused_at=null where id=$1", [flow]);
        if (!pause) await db.query("alter table automations drop column paused_at");
      }
      const staticSegment = await post(fullKey, "/segments", { name: "Static only" });
      const dynamic = (await db.query("select to_jsonb(s) ? 'rule' as supported from segments s where id=$1", [staticSegment.json.id])).rows[0].supported;
      if (!dynamic) await db.query("alter table segments add column rule jsonb");
      try {
        await db.query("update segments set rule=$2::jsonb where id=$1", [staticSegment.json.id, JSON.stringify({ field: "contact.first_name", operator: "eq", value: "Ada" })]);
        expect((await post(fullKey, `/automations/${flow}/enroll`, { segment_id: staticSegment.json.id })).status).toBe(404);
      } finally {
        await db.query("update segments set rule=null where id=$1", [staticSegment.json.id]);
        if (!dynamic) await db.query("alter table segments drop column rule");
      }
      // The same key in another tenant creates that tenant's own job.
      const foreignFlow = await post(otherKey, "/automations", { name: "Foreign flow", enabled: true, steps: [
        { key: "start", type: "trigger", config: { type: "contact_updated", field: "first_name" } },
      ] });
      const foreignJob = await post(otherKey, `/automations/${foreignFlow.json.id}/enroll`, body, headers);
      expect(foreignJob.status).toBe(202);
      expect(foreignJob.json.id).not.toBe(first.json.id);
    });

    it("fair claiming executes an ordinary event within one tick behind ten thousand older bulk runs", async () => {
      const bulk = await contactFlow({ type: "contact_updated", field: "first_name" });
      await backlog(bulk, 10_000);
      const normal = await post(fullKey, "/automations", { name: "Priority event", enabled: true, trigger: "priority.event", steps: [{ type: "delay", seconds: 3600 }] });
      expect(normal.status).toBe(200);
      expect((await post(fullKey, "/events/send", { event: "priority.event" })).status).toBe(202);
      const run = (await flowRuns(normal.json.id))[0]!;
      expect((await db.query("select priority,state from automation_runs where id=$1", [run.id])).rows[0]).toEqual({ priority: "normal", state: "ready" });
      await tick();
      expect((await db.query("select state from automation_runs where id=$1", [run.id])).rows[0].state).toBe("waiting");
      expect((await db.query(
        "select count(*)::int as processed from automation_runs where automation_id=$1 and state<>'ready'", [bulk],
      )).rows[0].processed).toBe(2);
    });

    it("fair claiming rotates automations across ticks and caps each automation at two runs", async () => {
      const claim = await runClaimer();
      const flows = [];
      for (let index = 0; index < 5; index++) {
        const flow = await contactFlow({ type: "contact_updated", field: "first_name" });
        flows.push(flow);
        await backlog(flow, 30, "normal");
        await backlog(flow, 30, "bulk");
      }
      const state = { normal: "", bulk: "" };
      for (const priority of ["normal", "bulk"]) {
        if (priority === "bulk") await db.query("update automation_runs set state='done' where priority='normal'");
        const seen = new Set<string>();
        for (let pass = 0; pass < 5; pass++) {
          const rows = await claim(db, 3, state);
          expect(rows).toHaveLength(3);
          expect(rows.every((row) => row.priority === priority)).toBe(true);
          for (const flow of flows) expect(rows.filter((row) => row.automation_id === flow).length).toBeLessThanOrEqual(2);
          rows.forEach((row) => seen.add(row.automation_id));
          expect((await db.query("select distinct state from automation_runs where id=any($1::text[])", [rows.map((row) => row.id)])).rows).toEqual([{ state: "running" }]);
        }
        expect([...seen].sort()).toEqual([...flows].sort());
      }
    });

    it("fair claiming skips held run rows stays unique concurrently and does not lock automations", async () => {
      const claim = await runClaimer();
      const flow = await contactFlow({ type: "contact_updated", field: "first_name" });
      const runs = await backlog(flow, 12, "normal");
      let release = () => {};
      let locked = () => {};
      const held = new Promise<void>((resolve) => { locked = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const holder = tx(db, async (client) => {
        await client.query("select id from automation_runs where id=$1 for update", [runs[0]!.id]);
        await client.query("select id from automations where id=$1 for update", [flow]);
        locked();
        await gate;
      });
      await held;
      const pending = Promise.all([claim(db, 2), claim(db, 2)]);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await Promise.race([
          pending,
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Claims blocked on held automation")), 2000); }),
        ]);
        expect(results.map((rows) => rows.length)).toEqual([2, 2]);
        const ids = results.flat().map((row) => row.id);
        expect(new Set(ids).size).toBe(4);
        expect(ids).not.toContain(runs[0]!.id);
        expect((await db.query("select state from automation_runs where id=$1", [runs[0]!.id])).rows[0].state).toBe("ready");
      } finally {
        if (timeout) clearTimeout(timeout);
        release();
        await holder;
        await pending;
      }
    });

    it("contact history keeps 400 days and prunes only bounded batches from real rows", async () => {
      const module = "../../worker/src/logs.js";
      const { pruneContactChanges, contactChangesRetentionDays } = await import(module);
      const saved = process.env.CONTACT_CHANGES_RETENTION_DAYS;
      try {
        delete process.env.CONTACT_CHANGES_RETENTION_DAYS;
        expect(contactChangesRetentionDays()).toBe(400);
        for (const invalid of [0, -1, NaN, Infinity]) expect(contactChangesRetentionDays(invalid)).toBe(400);
        process.env.CONTACT_CHANGES_RETENTION_DAYS = "450";
        expect(contactChangesRetentionDays()).toBe(450);
        const contact = await post(fullKey, "/contacts", { email: "retained-history@example.com", first_name: "Before" });
        await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { first_name: "After" });
        const currentHistory = (await db.query("select count(*)::int as count from contact_changes where contact_id=$1", [contact.json.id])).rows[0].count;
        const tenant = (await db.query("select tenant_id from contacts where id=$1", [contact.json.id])).rows[0].tenant_id;
        const prefix = id("change");
        await db.query(
          `insert into contact_changes (id,tenant_id,contact_id,field,from_value,to_value,request_id,created_at)
           select $1 || n,$2,$3,'first_name','"Before"'::jsonb,'"After"'::jsonb,$1,
                  now()-(case when n<=5 then 401 else 399 end)*interval '1 day'
           from generate_series(1,6) n`, [prefix, tenant, contact.json.id],
        );
        expect(await pruneContactChanges(db, 400, 2, 2)).toBe(4);
        expect((await db.query("select count(*)::int as count from contact_changes where created_at<now()-interval '400 days'")).rows[0].count).toBe(1);
        expect(await pruneContactChanges(db, 400, 2, 2)).toBe(1);
        expect(await pruneContactChanges(db, 400, 2, 2)).toBe(0);
        expect((await db.query("select id from contact_changes where id=$1", [`${prefix}6`])).rows).toHaveLength(1);
        expect((await db.query("select id from contact_changes where contact_id=$1", [contact.json.id])).rows).toHaveLength(currentHistory + 1);
      } finally {
        if (saved === undefined) delete process.env.CONTACT_CHANGES_RETENTION_DAYS;
        else process.env.CONTACT_CHANGES_RETENTION_DAYS = saved;
      }
    });

    it("fair claiming finds unlocked normal work beyond a hundred contended automations before bulk", async () => {
      const claim = await runClaimer();
      const flow = await contactFlow({ type: "contact_updated", field: "first_name" });
      const tenant = await tenantFor(flow);
      const prefix = id("automation");
      const autos = (await db.query<{ id: string }>(
        `insert into automations (id,tenant_id,name,trigger,trigger_type,reentry,steps,connections,enabled)
         select $1||lpad(n::text,3,'0'),$2,$1||n,'@contact.updated','contact_updated','every_time',$3::jsonb,'[]',true
         from generate_series(1,101) n returning id`,
        [prefix, tenant, JSON.stringify([{ key: "start", type: "trigger", config: { type: "contact_updated", field: "first_name" } }])],
      )).rows;
      for (const auto of autos) await backlog(auto.id, 1, "normal");
      await backlog(flow, 2, "bulk");
      const holder = await db.connect();
      await holder.query("begin");
      try {
        await holder.query("select id from automation_runs where automation_id=any($1::text[]) for update", [autos.slice(0, 100).map((auto) => auto.id)]);
        const claimed = await claim(db, 3);
        expect(claimed.map((row) => row.priority)).toEqual(["normal", "bulk", "bulk"]);
        expect(claimed[0]!.automation_id).toBe(autos[100]!.id);
      } finally {
        await holder.query("rollback");
        holder.release();
      }
    });

    it("import retries keep bulk runs unique and cancellation prevents future CSV batches", async () => {
      const flow = await contactFlow({ type: "contact_created" });
      const tenant = await tenantFor(flow);
      const importId = id("import");
      await createImport(db, { id: importId, tenantId: tenant, storageKey: id("file"), columnMap: {}, onConflict: "upsert", segments: [], topics: [], triggerAutomations: true });
      const csv = `email\n${Array.from({ length: 1001 }, (_, index) => `cancel-import-${index}@example.com`).join("\n")}\n`;
      const storage = { stream: async () => Readable.from([csv]) };
      const first = (await claimImports(db, 1))[0]!;
      await runImport(db, storage, first, { batchSize: 500, maxRows: 500 });
      expect(await flowRuns(flow)).toHaveLength(500);
      const retry = (await claimImports(db, 1))[0]!;
      expect(retry.row_offset).toBe(500);
      await runImport(db, storage, retry, { batchSize: 500, maxRows: 500 });
      expect(await flowRuns(flow)).toHaveLength(1000);
      await runImport(db, storage, first, { batchSize: 500, maxRows: 500 });
      expect(await flowRuns(flow)).toHaveLength(1000);
      const pending = (await claimImports(db, 1))[0]!;
      expect(pending.row_offset).toBe(1000);
      const viewer = await teammate("Viewer");
      const session = await signInAs(viewer.email, viewer.password);
      expect((await call(session.token, "DELETE", `/contacts/imports/${importId}`)).status).toBe(403);
      const otherKey = await seedTenant();
      expect((await call(otherKey, "DELETE", `/contacts/imports/${importId}`)).status).toBe(404);
      const before = (await call(fullKey, "GET", `/contacts/imports/${importId}`)).json;
      expect((await call(fullKey, "DELETE", `/contacts/imports/${importId}`)).status).toBe(200);
      // A worker can still hold the row it claimed before the cancellation request.
      await runImport(db, storage, pending, { batchSize: 500 });
      await runImport(db, storage, pending, { batchSize: 500 });
      const cancelled = (await call(fullKey, "GET", `/contacts/imports/${importId}`)).json;
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.counts).toEqual(before.counts);
      expect((await db.query("select id from contacts where email='cancel-import-1000@example.com'")).rows).toHaveLength(0);
      expect((await db.query(
        "select count(*)::int as runs,count(distinct contact_id)::int as contacts,bool_and(priority='bulk') as bulk from automation_runs where automation_id=$1", [flow],
      )).rows[0]).toEqual({ runs: 1000, contacts: 1000, bulk: true });
      expect(await claimImports(db, 1)).toHaveLength(0);
    }, 30_000);
  });

  it("reentry serializes once and every-time entries, retains defaults across trigger edits, and allows contactless events", async () => {
    await post(fullKey, "/contact-properties", { key: "plan", type: "string" });
    const contact = await post(fullKey, "/contacts", { email: "entry@example.com", properties: { plan: "free" } });
    const create = (name: string, reentry?: string) => post(fullKey, "/automations", { name, enabled: true, reentry, steps: [
      { key: "start", type: "trigger", config: { type: "contact_updated", field: "plan" } }
    ] });
    const once = await create("Once");
    const every = await create("Every", "every_time");
    expect(once.json.reentry).toBe("once");
    const races = await Promise.all(["pro", "business"].map((plan) => call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { properties: { plan } })));
    expect(races.map((row) => row.status)).toEqual([200, 200]);
    expect(await flowRuns(once.json.id)).toHaveLength(1);
    expect(await flowRuns(every.json.id)).toHaveLength(2);
    await post(fullKey, `/automations/${once.json.id}/stop`, {});
    expect((await call(fullKey, "PATCH", `/automations/${once.json.id}`, { steps: [
      { key: "start", type: "trigger", config: { type: "event", event_name: "entry.ping" } }
    ] })).json.reentry).toBe("once");
    await call(fullKey, "PATCH", `/automations/${once.json.id}`, { enabled: true });
    const event = await post(fullKey, "/automations", { name: "Event default", enabled: true, trigger: "entry.ping", steps: [{ type: "delay", seconds: 1 }] });
    expect(event.json.reentry).toBe("every_time");
    const sent = await Promise.all([1, 2].map(() => post(fullKey, "/events/send", { event: "entry.ping" })));
    expect(sent.map((row) => row.status)).toEqual([202, 202]);
    expect(await flowRuns(once.json.id)).toHaveLength(3);
    expect((await db.query("select distinct priority from automation_runs")).rows).toEqual([{ priority: "normal" }]);
  });

  it("reentry reset removes only cancelled contacts, preserves completed entries, and refuses viewer resets", async () => {
    const once = await post(fullKey, "/automations", { name: "Reset", enabled: true, steps: [
      { key: "start", type: "trigger", config: { type: "contact_created" } }
    ] });
    const finished = await post(fullKey, "/contacts", { email: "done-entry@example.com" });
    const active = await post(fullKey, "/contacts", { email: "cancel-entry@example.com" });
    const runs = await db.query<{ id: string; email: string }>("select r.id,e.email from automation_runs r join custom_events e on e.id=r.event_id where r.automation_id=$1", [once.json.id]);
    const done = runs.rows.find((row) => row.email === "done-entry@example.com")!;
    await executeAutomationRun(db, (await flowRuns(once.json.id))[0]!.tenant_id, done.id);
    expect((await db.query("select state from automation_runs where id=$1", [done.id])).rows[0].state).toBe("done");
    await call(fullKey, "PATCH", `/contacts/${active.json.id}`, { email: "renamed-entry@example.com" });
    const viewer = await teammate("Viewer");
    const session = await signInAs(viewer.email, viewer.password);
    expect((await post(session.token, `/automations/${once.json.id}/stop`, { reset_reentry: true })).status).toBe(403);
    expect((await post(fullKey, `/automations/${once.json.id}/stop`, { reset_reentry: "true" })).status).toBe(400);
    expect((await post(fullKey, `/automations/${once.json.id}/stop`, { reset_reentry: true })).status).toBe(200);
    expect((await db.query("select contact_id from automation_enrollments where automation_id=$1", [once.json.id])).rows).toEqual([{ contact_id: finished.json.id }]);
    const cancelled = runs.rows.find((row) => row.email === "cancel-entry@example.com")!;
    expect((await db.query("select state from automation_runs where id=$1", [cancelled.id])).rows[0].state).toBe("stopped");
    // Repeated reset has no cancelled active runs and cannot erase a completed enrollment.
    await post(fullKey, `/automations/${once.json.id}/stop`, { reset_reentry: true });
    expect((await db.query("select contact_id from automation_enrollments where automation_id=$1", [once.json.id])).rows).toEqual([{ contact_id: finished.json.id }]);
    await call(fullKey, "PATCH", `/automations/${once.json.id}`, { enabled: true, steps: [
      { key: "start", type: "trigger", config: { type: "contact_updated", field: "first_name" } }
    ] });
    for (const contact of [finished, active]) await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { first_name: "Changed" });
    expect(await flowRuns(once.json.id)).toHaveLength(3);
  });

  it("import triggers resolve tenant defaults and explicit overrides once, and persist them through migrations", async () => {
    const tenant = (await db.query<{ id: string }>("select id from tenants limit 1")).rows[0]!.id;
    const queue = (triggerAutomations?: boolean) => createImport(db, { id: id("import"), tenantId: tenant, storageKey: id("file"), columnMap: {}, onConflict: "upsert", segments: [], topics: [], triggerAutomations });
    const off = await queue();
    expect(off!.trigger_automations).toBe(false);
    await call(fullKey, "PATCH", "/settings", { import_trigger_automations: true });
    const on = await queue();
    const override = await queue(false);
    await call(fullKey, "PATCH", "/settings", { import_trigger_automations: false });
    const explicit = await queue(true);
    const jobs = await claimImports(db, 10);
    expect(jobs.map((row) => [row.id, row.trigger_automations])).toEqual([
      [off!.id, false], [on!.id, true], [override!.id, false], [explicit!.id, true]
    ]);
    await db.query(schema);
    await db.query(schema);
    expect((await call(fullKey, "GET", `/contacts/imports/${on!.id}`)).json.trigger_automations).toBe(true);
    const other = await seedTenant();
    expect((await call(other, "GET", `/contacts/imports/${on!.id}`)).status).toBe(404);
  });

  it("import triggers return actual insert revival topic and segment changes, preserve optouts, and use bulk priority", async () => {
    const topic = await post(fullKey, "/topics", { name: "Import opt-in", key: "import", default_subscription: "opt_out" });
    const defaultOn = await post(fullKey, "/topics", { name: "Default receiving", key: "default_on", default_subscription: "opt_in" });
    const segment = await post(fullKey, "/segments", { name: "Import segment" });
    const create = await contactFlow({ type: "contact_created" });
    const update = await contactFlow({ type: "contact_updated" });
    const subscribed = await contactFlow({ type: "topic_subscribed", topic_id: topic.json.id });
    const defaults = await contactFlow({ type: "topic_subscribed", topic_id: defaultOn.json.id });
    const added = await contactFlow({ type: "segment_added", segment_id: segment.json.id });
    const old = await post(fullKey, "/contacts", { email: "existing-import@example.com", first_name: "Before", topics: [{ id: topic.json.id, subscription: "opt_out" }] });
    const global = await post(fullKey, "/contacts", { email: "global-import@example.com", unsubscribed: true });
    const revive = await post(fullKey, "/contacts", { email: "revived-import@example.com", properties: { old: "discard" } });
    await call(fullKey, "DELETE", `/contacts/${revive.json.id}`);
    const tenant = (await db.query<{ tenant_id: string }>("select tenant_id from contacts limit 1")).rows[0]!.tenant_id;
    const job = { id: id("import"), tenant_id: tenant, on_conflict: "upsert" as const, trigger_automations: true,
      segments: [{ id: segment.json.id }, { id: segment.json.id }],
      topics: [{ id: topic.json.id, subscription: "opt_in" }, { id: defaultOn.json.id, subscription: "opt_in" }] };
    const rows = ["new-import@example.com", old.json.email, global.json.email, revive.json.email].map((email) => ({
      email, first_name: "After", last_name: null, properties: { fresh: true }, unsubscribed: false
    }));
    const result = await tx(db, (client) => importBatch(client, job, rows));
    expect(result).toMatchObject({ created: 2, updated: 2, skipped: 0 });
    const newRow = result.rows.find((row) => row.contact.email === "new-import@example.com")!;
    expect(newRow).toMatchObject({ created: true, segments_added: [segment.json.id], topics_subscribed: [topic.json.id] });
    expect(result.rows.find((row) => row.id === revive.json.id)).toMatchObject({ created: true, contact: { properties: { fresh: true } } });
    expect(result.rows.find((row) => row.id === old.json.id)!.topics_subscribed).toEqual([]);
    expect(result.rows.find((row) => row.id === global.json.id)!.topics_subscribed).toEqual([]);
    expect(await flowRuns(create)).toHaveLength(5); // three route creates plus insert and revival.
    expect(await flowRuns(update)).toHaveLength(0);
    expect(await flowRuns(subscribed)).toHaveLength(2);
    expect(await flowRuns(defaults)).toHaveLength(0);
    expect(await flowRuns(added)).toHaveLength(4);
    expect((await db.query("select distinct priority from automation_runs r join custom_events e on e.id=r.event_id where e.request_id=$1", [job.id])).rows).toEqual([{ priority: "bulk" }]);
    const repeat = await tx(db, (client) => importBatch(client, job, rows));
    expect(repeat).toMatchObject({ created: 0, updated: 4 });
    expect(repeat.rows.every((row) => !row.created && !row.segments_added.length && !row.topics_subscribed.length)).toBe(true);
    expect(await flowRuns(added)).toHaveLength(4);
    await tx(db, (client) => importBatch(client, { ...job, trigger_automations: false }, [{ ...rows[0], email: "off-import@example.com" }]));
    expect(await flowRuns(create)).toHaveLength(5);
  });

  it("import triggers commit with progress, resume without duplicates, and roll back on trigger fanout failure", async () => {
    const create = await contactFlow({ type: "contact_created" });
    const tenant = (await db.query<{ tenant_id: string }>("select tenant_id from automations limit 1")).rows[0]!.tenant_id;
    const importId = id("import");
    await createImport(db, { id: importId, tenantId: tenant, storageKey: id("file"), columnMap: {}, onConflict: "upsert", segments: [], topics: [], triggerAutomations: true });
    const job = (await claimImports(db, 1))[0]!;
    const csv = "email\nimport-retry@example.com\n";
    const storage = { stream: async () => Readable.from([csv]) };
    const counts = await runImport(db, storage, job);
    expect(counts).toMatchObject({ total: 1, created: 1 });
    expect(await flowRuns(create)).toHaveLength(1);
    await runImport(db, storage, { ...job, row_offset: 1, counts });
    expect(await flowRuns(create)).toHaveLength(1);
    await db.query(`create or replace function reject_import_run() returns trigger language plpgsql as $$
      begin raise exception 'synthetic import failure'; end $$;
      create trigger reject_import_run before insert on automation_runs for each row execute function reject_import_run()`);
    try {
      await expect(tx(db, (client) => importBatch(client, job, [{ email: "rollback-import@example.com", first_name: null, last_name: null, properties: {}, unsubscribed: false }]))).rejects.toThrow("synthetic import failure");
    } finally {
      await db.query("drop trigger reject_import_run on automation_runs; drop function reject_import_run()");
    }
    expect((await db.query("select id from contacts where email='rollback-import@example.com'")).rows).toHaveLength(0);
    expect((await db.query("select id from custom_events where email='rollback-import@example.com'")).rows).toHaveLength(0);
  });

  it("import triggers report one actual creation under concurrent batches", async () => {
    const flow = await contactFlow({ type: "contact_created" });
    const tenant = (await flowRuns(flow))[0]?.tenant_id ?? (await db.query("select tenant_id from automations where id=$1", [flow])).rows[0].tenant_id;
    const contact = { email: "concurrent-import@example.com", first_name: null, last_name: null, properties: {}, unsubscribed: false };
    const job = { tenant_id: tenant, on_conflict: "upsert" as const, segments: [], topics: [], trigger_automations: true };
    const results = await Promise.all([1, 2].map(() => tx(db, (client) => importBatch(client, job, [contact]))));
    expect(results.map((row) => row.created).sort()).toEqual([0, 1]);
    expect(results.map((row) => row.updated).sort()).toEqual([0, 1]);
    expect(new Set(results.flatMap((row) => row.ids)).size).toBe(1);
    expect(await flowRuns(flow)).toHaveLength(1);
  });

  it("import triggers accept real multipart overrides, expose stored flags, and protect viewer uploads", async () => {
    await call(fullKey, "PATCH", "/settings", { import_trigger_automations: true });
    const upload = (key: string, flag?: string) => {
      const boundary = "entry-boundary";
      const field = flag === undefined ? "" : `--${boundary}\r\nContent-Disposition: form-data; name="trigger_automations"\r\n\r\n${flag}\r\n`;
      return app.inject({ method: "POST", url: "/contacts/imports", headers: {
        authorization: `Bearer ${key}`, "content-type": `multipart/form-data; boundary=${boundary}`
      }, payload: `${field}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="entry.csv"\r\nContent-Type: text/csv\r\n\r\nemail\nmultipart-entry@example.com\n\r\n--${boundary}--\r\n` });
    };
    const inherited = await upload(fullKey);
    const off = await upload(fullKey, "false");
    const on = await upload(fullKey, "true");
    expect([inherited.statusCode, off.statusCode, on.statusCode]).toEqual([200, 200, 200]);
    expect([inherited.json().trigger_automations, off.json().trigger_automations, on.json().trigger_automations]).toEqual([true, false, true]);
    expect((await upload(fullKey, "1")).statusCode).toBe(400);
    await call(fullKey, "PATCH", "/settings", { import_trigger_automations: false });
    expect((await call(fullKey, "GET", `/contacts/imports/${inherited.json().id}`)).json.trigger_automations).toBe(true);
    const viewer = await teammate("Viewer");
    const session = await signInAs(viewer.email, viewer.password);
    expect((await upload(session.token, "true")).statusCode).toBe(403);
    const list = (await call(session.token, "GET", "/contacts/imports")).json.data;
    expect(list).toHaveLength(3);
    expect(list.every((row: { trigger_automations: unknown }) => typeof row.trigger_automations === "boolean")).toBe(true);
  });

  it("contact triggers normalize contracts, record exact multi-field history, and suppress no-op writes", async () => {
    const plan = await post(fullKey, "/contact-properties", { key: "plan", type: "string" });
    const active = await post(fullKey, "/contact-properties", { key: "active", type: "boolean" });
    expect([plan.status, active.status]).toEqual([200, 200]);
    const created = await contactFlow({ type: "contact_created" });
    const updated = await contactFlow({ type: "contact_updated", field: "plan", from: "free", to: "pro" });
    const any = await contactFlow({ type: "contact_updated" });
    const first = await post(fullKey, "/contacts", { email: "trigger@example.com", properties: { plan: "free", active: false } });
    expect(first.status).toBe(200);
    expect(await flowRuns(created)).toHaveLength(1);
    expect((await post(fullKey, "/contacts", { email: "trigger@example.com", properties: { plan: "free", active: false } })).status).toBe(200);
    expect(await flowRuns(created)).toHaveLength(1);
    expect(await flowRuns(any)).toHaveLength(0);
    const patch = await call(fullKey, "PATCH", `/contacts/${first.json.id}`, {
      first_name: "Ada", properties: { plan: "pro", active: true }
    });
    expect(patch.status).toBe(200);
    expect(await flowRuns(updated)).toHaveLength(1);
    expect(await flowRuns(any)).toHaveLength(1);
    const events = await db.query("select data from custom_events where name = '@contact.updated'");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].data.changes).toEqual(expect.arrayContaining([
      { field: "first_name", from: null, to: "Ada" },
      { field: "plan", from: "free", to: "pro" }, { field: "active", from: false, to: true }
    ]));
    expect(events.rows[0].data.changes).toHaveLength(3);
    const history = await db.query("select field, from_value, to_value from contact_changes where contact_id = $1 and from_value is not null", [first.json.id]);
    expect(history.rows).toEqual(expect.arrayContaining([
      { field: "plan", from_value: "free", to_value: "pro" },
      { field: "active", from_value: false, to_value: true }
    ]));
    expect((await call(fullKey, "GET", "/fired-events")).json.data).toHaveLength(0);
    const wire = (await call(fullKey, "GET", `/automations/${created}`)).json;
    expect(wire).toMatchObject({ trigger: null, trigger_config: { type: "contact_created" }, reentry: "every_time" });
    await db.query(schema);
    await db.query(schema);
    expect((await db.query("select trigger_type, trigger from automations where id = $1", [created])).rows).toEqual([
      { trigger_type: "contact_created", trigger: "@contact.created" }
    ]);
    expect((await post(fullKey, "/events/send", { event: "@contact.created", email: "trigger@example.com" })).status).toBe(422);
    expect((await post(fullKey, "/events", { name: "@reserved" })).status).toBe(400);
    expect((await post(fullKey, "/automations", { name: "Reserved", trigger: "@reserved", steps: [{ type: "delay", seconds: 1 }] })).status).toBe(400);
    const other = await seedTenant();
    expect((await call(other, "GET", `/automations/${created}`)).status).toBe(404);
  });

  it("contact triggers record history without matching flows, serialize same-value writes, and roll back failed fanout", async () => {
    await post(fullKey, "/contact-properties", { key: "plan", type: "string" });
    const first = await post(fullKey, "/contacts", { email: "race@example.com", properties: { plan: "free" } });
    await call(fullKey, "PATCH", `/contacts/${first.json.id}`, { first_name: "Ada" });
    expect((await db.query("select id from custom_events")).rows).toHaveLength(0);
    expect((await db.query("select id from contact_changes where field = 'first_name' and to_value = '\"Ada\"'::jsonb")).rows).toHaveLength(1);
    const flow = await contactFlow({ type: "contact_updated", field: "plan", to: "pro" });
    const race = await Promise.all([1, 2].map(() => call(fullKey, "PATCH", `/contacts/${first.json.id}`, { properties: { plan: "pro" } })));
    expect(race.map((row) => row.status)).toEqual([200, 200]);
    expect(await flowRuns(flow)).toHaveLength(1);
    expect((await db.query("select id from custom_events where name = '@contact.updated'")).rows).toHaveLength(1);
    // Rollback covers contact state, transition history, internal event and run webhook fanout.
    await db.query(`create or replace function reject_contact_history() returns trigger language plpgsql as $$
      begin if new.field = 'last_name' then raise exception 'synthetic history failure'; end if; return new; end $$;
      create trigger reject_contact_history before insert on contact_changes for each row execute function reject_contact_history()`);
    try {
      expect((await call(fullKey, "PATCH", `/contacts/${first.json.id}`, { last_name: "Rollback" })).status).toBe(500);
      expect((await call(fullKey, "GET", `/contacts/${first.json.id}`)).json.last_name).toBe(null);
    } finally {
      await db.query("drop trigger reject_contact_history on contact_changes; drop function reject_contact_history()");
    }
    expect((await db.query("select id from contact_changes where field = 'last_name'")).rows).toHaveLength(0);
    expect(await flowRuns(flow)).toHaveLength(1);
  });

  it("contact triggers retain their once default under concurrent real transitions and reset enrollments on deletion", async () => {
    await post(fullKey, "/contact-properties", { key: "plan", type: "string" });
    const flow = await post(fullKey, "/automations", { name: "Once", status: "enabled", steps: [
      { key: "start", type: "trigger", config: { type: "contact_updated", field: "plan" } }
    ] });
    expect(flow.status).toBe(200);
    expect(flow.json.reentry).toBe("once");
    const first = await post(fullKey, "/contacts", { email: "once@example.com", properties: { plan: "free" } });
    const race = await Promise.all(["pro", "business"].map((plan) => call(fullKey, "PATCH", `/contacts/${first.json.id}`, { properties: { plan } })));
    expect(race.map((row) => row.status)).toEqual([200, 200]);
    expect(await flowRuns(flow.json.id)).toHaveLength(1);
    expect((await db.query("select id from contact_changes where contact_id = $1 and field = 'plan'", [first.json.id])).rows).toHaveLength(3);
    expect((await db.query("select contact_id from automation_enrollments where automation_id = $1", [flow.json.id])).rows).toEqual([{ contact_id: first.json.id }]);
    await call(fullKey, "DELETE", `/contacts/${first.json.id}`);
    expect((await db.query("select contact_id from automation_enrollments where automation_id = $1", [flow.json.id])).rows).toHaveLength(0);
    await post(fullKey, "/contacts", { email: "once@example.com" });
    await call(fullKey, "PATCH", `/contacts/${first.json.id}`, { properties: { plan: "revived" } });
    expect(await flowRuns(flow.json.id)).toHaveLength(2);
  });

  it("contact triggers cover topic and segment APIs, creation and revival, effective defaults, and deleted resources", async () => {
    const topic = await post(fullKey, "/topics", { name: "Opt-in", default_subscription: "opt_out" });
    const defaultTopic = await post(fullKey, "/topics", { name: "Default", default_subscription: "opt_in" });
    const segment = await post(fullKey, "/segments", { name: "Static" });
    const created = await contactFlow({ type: "contact_created" });
    const subscribed = await contactFlow({ type: "topic_subscribed", topic_id: topic.json.id });
    const defaults = await contactFlow({ type: "topic_subscribed", topic_id: defaultTopic.json.id });
    const joined = await contactFlow({ type: "segment_added", segment_id: segment.json.id });
    const contact = await post(fullKey, "/contacts", { email: "members@example.com",
      topics: [{ id: topic.json.id, subscription: "opt_in" }, { id: defaultTopic.json.id, subscription: "opt_in" }],
      segments: [{ id: segment.json.id }] });
    expect(contact.status).toBe(200);
    expect(await flowRuns(created)).toHaveLength(1);
    expect(await flowRuns(subscribed)).toHaveLength(1);
    expect(await flowRuns(defaults)).toHaveLength(0);
    expect(await flowRuns(joined)).toHaveLength(1);
    await call(fullKey, "PATCH", `/contacts/${contact.json.id}/topics`, { topics: [{ id: topic.json.id, subscription: "opt_in" }] });
    await post(fullKey, `/contacts/${contact.json.id}/segments/${segment.json.id}`, {});
    expect(await flowRuns(subscribed)).toHaveLength(1);
    expect(await flowRuns(joined)).toHaveLength(1);
    await call(fullKey, "PATCH", `/contacts/${contact.json.id}/topics`, { topics: [{ id: topic.json.id, subscription: "opt_out" }] });
    await post(fullKey, `/topics/${topic.json.id}/subscriptions`, { email: "members@example.com", status: "opt_in" });
    expect(await flowRuns(subscribed)).toHaveLength(2);
    expect((await post(fullKey, `/topics/${topic.json.id}/subscriptions`, { email: "topic-new@example.com", status: "opt_in" })).status).toBe(200);
    expect((await post(fullKey, `/segments/${segment.json.id}/contacts`, { email: "segment-new@example.com" })).status).toBe(200);
    expect(await flowRuns(created)).toHaveLength(3);
    expect(await flowRuns(subscribed)).toHaveLength(3);
    expect(await flowRuns(joined)).toHaveLength(2);
    await call(fullKey, "DELETE", `/contacts/${contact.json.id}`);
    await post(fullKey, "/contacts", { email: "members@example.com" });
    expect(await flowRuns(created)).toHaveLength(4);
    await post(fullKey, `/automations/${subscribed}/stop`, {});
    await call(fullKey, "DELETE", `/topics/${topic.json.id}`);
    expect((await call(fullKey, "PATCH", `/automations/${subscribed}`, { status: "enabled" })).status).toBe(422);
    await post(fullKey, `/automations/${joined}/stop`, {});
    await call(fullKey, "DELETE", `/segments/${segment.json.id}`);
    expect((await call(fullKey, "PATCH", `/automations/${joined}`, { status: "enabled" })).status).toBe(422);
    expect((await db.query("select trigger_type from automations where id = $1", [joined])).rows[0].trigger_type).toBe("segment_added");
  });

  it("contact triggers cover event-created contacts, name filling, preferences, and one-click without reviving deleted contacts", async () => {
    const created = await contactFlow({ type: "contact_created" });
    const named = await contactFlow({ type: "contact_updated", field: "first_name", to: "Ada" });
    const left = await contactFlow({ type: "contact_updated", field: "unsubscribed", from: false, to: true });
    const topic = await post(fullKey, "/topics", { name: "Preferences", visibility: "public", default_subscription: "opt_out" });
    const subscribed = await contactFlow({ type: "topic_subscribed", topic_id: topic.json.id });
    await post(fullKey, "/events/send", { event: "profile", email: "profile@example.com" });
    await post(fullKey, "/events/send", { event: "profile", email: "profile@example.com", payload: { first_name: "Ada" } });
    await post(fullKey, "/events/send", { event: "profile", email: "profile@example.com", payload: { first_name: "Changed" } });
    expect(await flowRuns(created)).toHaveLength(1);
    expect(await flowRuns(named)).toHaveLength(1);
    const contact = (await db.query("select id, tenant_id from contacts where email = 'profile@example.com'")).rows[0];
    const token = unsubscribeToken({ tenant_id: contact.tenant_id, contact_id: contact.id }, process.env.APP_SECRET ?? "dev-secret-change-before-deploy");
    expect((await app.inject({ method: "POST", url: `/unsubscribe/${token}`, payload: { topics: [{ id: topic.json.id, subscription: "opt_in" }] } })).statusCode).toBe(200);
    expect(await flowRuns(subscribed)).toHaveLength(1);
    for (let index = 0; index < 2; index++) expect((await app.inject({ method: "POST", url: `/unsubscribe/${token}`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" })).statusCode).toBe(200);
    expect(await flowRuns(left)).toHaveLength(1);
    await call(fullKey, "DELETE", `/contacts/${contact.id}`);
    await post(fullKey, "/events/send", { event: "profile", email: "profile@example.com", payload: { first_name: "Ada" } });
    expect((await db.query("select deleted_at from contacts where id = $1", [contact.id])).rows[0].deleted_at).not.toBe(null);
    expect(await flowRuns(created)).toHaveLength(1);
    const missing = unsubscribeToken({ tenant_id: contact.tenant_id, email: "unsub-created@example.com" }, process.env.APP_SECRET ?? "dev-secret-change-before-deploy");
    expect((await app.inject({ method: "POST", url: `/unsubscribe/${missing}`, payload: { unsubscribe_all: true } })).statusCode).toBe(200);
    expect(await flowRuns(created)).toHaveLength(1);
  });

  it("contact triggers prevent self-entry, stop cross-flow chains at recorded depth five, and never wake event waits", async () => {
    await post(fullKey, "/contact-properties", { key: "state", type: "string" });
    const a = await contactFlow({ type: "contact_updated", field: "state", to: "a" }, [{ key: "update", type: "contact_update", config: { properties: { state: "b" } } }]);
    const b = await contactFlow({ type: "contact_updated", field: "state", to: "b" }, [{ key: "update", type: "contact_update", config: { properties: { state: "a" } } }]);
    const self = await contactFlow({ type: "contact_updated", field: "first_name" }, [{ key: "name", type: "contact_update", config: { first_name: "Self" } }]);
    const contact = await post(fullKey, "/contacts", { email: "chain@example.com", properties: { state: "none" } });
    await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { first_name: "External" });
    const own = await flowRuns(self);
    expect(own).toHaveLength(1);
    await executeAutomationRun(db, own[0].tenant_id, own[0].id);
    expect(await flowRuns(self)).toHaveLength(1);
    const waiting = await post(fullKey, "/automations", { name: "Wait", status: "enabled", trigger: "wait.start", steps: [{ type: "wait_for_event", event_name: "contact.updated", timeout: "1 day" }] });
    await post(fullKey, "/events/send", { event: "wait.start", email: "chain@example.com" });
    const wait = (await flowRuns(waiting.json.id))[0];
    await executeAutomationRun(db, wait.tenant_id, wait.id);
    await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { properties: { state: "a" } });
    for (let i = 0; i < 8; i++) {
      const ready = await db.query("select id, tenant_id from automation_runs where state = 'ready' and automation_id = any($1)", [[a, b]]);
      for (const run of ready.rows) await executeAutomationRun(db, run.tenant_id, run.id);
    }
    expect([...(await flowRuns(a)), ...(await flowRuns(b))]).toHaveLength(5);
    expect((await db.query("select data from custom_events where name = '@contact.updated' and data->>'depth' = '5'")).rows).toHaveLength(1);
    expect((await db.query("select state from automation_runs where id = $1", [wait.id])).rows).toEqual([{ state: "waiting" }]);
    // A legacy @-named event automation remains an event, never a contact subscriber.
    await db.query("update automations set trigger = '@contact.updated', steps = $2::jsonb where id = $1", [waiting.json.id,
      JSON.stringify([{ key: "trigger", type: "trigger", config: { event_name: "@contact.updated" } }])]);
    await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { last_name: "Not an app event" });
    expect(await flowRuns(waiting.json.id)).toHaveLength(1);
    const legacy = await fireEvent(db, wait.tenant_id, "legacy-event-trigger", { name: "@contact.updated", email: "chain@example.com", data: {} });
    expect(legacy.runs).toHaveLength(1);
    expect(await flowRuns(waiting.json.id)).toHaveLength(2);
    expect([...(await flowRuns(a)), ...(await flowRuns(b))]).toHaveLength(5);
  });

  it("contact triggers dispatch step-created contacts and static additions exactly once and preserve typed transitions", async () => {
    await post(fullKey, "/contact-properties", { key: "active", type: "boolean" });
    await post(fullKey, "/contact-properties", { key: "due_at", type: "date" });
    const created = await contactFlow({ type: "contact_created" });
    const segment = await post(fullKey, "/segments", { name: "Step members" });
    const joined = await contactFlow({ type: "segment_added", segment_id: segment.json.id });
    const flow = await post(fullKey, "/automations", { name: "Step creator", trigger: "create.other", status: "enabled", steps: [
      { type: "add_to_segment", segment_id: segment.json.id, email: "step-created@example.com" },
      { type: "add_to_segment", segment_id: segment.json.id, email: "step-created@example.com" }
    ] });
    await post(fullKey, "/events/send", { event: "create.other", payload: { depth: 100 } });
    const run = (await flowRuns(flow.json.id))[0];
    await executeAutomationRun(db, run.tenant_id, run.id);
    expect(await flowRuns(created)).toHaveLength(1);
    expect(await flowRuns(joined)).toHaveLength(1);
    expect((await db.query("select data from custom_events where name = '@segment.added:' || $1", [segment.json.id])).rows[0].data).toMatchObject({ depth: 1, origin_run_id: run.id });
    expect((await post(fullKey, "/automations", { name: "Wrong type", steps: [{ key: "start", type: "trigger", config: { type: "contact_updated", field: "active", to: "true" } }] })).status).toBe(422);
    const active = await contactFlow({ type: "contact_updated", field: "active", from: false, to: true });
    const contact = await post(fullKey, "/contacts", { email: "typed@example.com", properties: { active: false } });
    await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { properties: { active: true } });
    expect(await flowRuns(active)).toHaveLength(1);
    const due = await contactFlow({ type: "contact_updated", field: "due_at", from: null, to: "2026-10-04T00:00:00Z" });
    await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { properties: { due_at: "2026-10-04T00:00:00Z" } });
    await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { properties: { due_at: "2026-10-04T00:00:00+00:00" } });
    expect(await flowRuns(due)).toHaveLength(1);
    // Exercise the later rule-backed dynamic schema without adding that product yet.
    await db.query("alter table segments add column rule jsonb");
    try {
      await db.query("update segments set rule = $2::jsonb where id = $1", [segment.json.id, JSON.stringify({ type: "rule", field: "contact.active", operator: "eq", value: true })]);
      expect((await call(fullKey, "PATCH", `/automations/${joined}`, { status: "enabled" })).status).toBe(422);
      expect((await post(fullKey, `/contacts/${contact.json.id}/segments/${segment.json.id}`, {})).status).toBe(422);
    } finally { await db.query("alter table segments drop column rule"); }
  });

  it("renders reserved and configured sandbox recipients and exposes their stored flags in detail and list responses", async () => {
    expect((await call(fullKey, "PATCH", "/settings", {
      sandbox_domains: ["qa.dispatch-fixture.net"],
    })).status).toBe(200);
    const template = await post(fullKey, "/templates", {
      name: "Sandbox",
      alias: "sandbox",
      subject: "Hello {{name}}",
      html: "<p>Hi {{name}}</p>",
      text: "Hi {{name}}",
      variables: ["name"],
      publish: true,
    });
    expect(template.status).toBe(200);
    const fixtures: Array<[string, boolean]> = [
      ["ada@example.com", true],
      ["ada@TEAM.EXAMPLE.COM", true],
      ["ada@example.net", true],
      ["ada@team.example.net", true],
      ["ada@example.org", true],
      ["ada@team.example.org", true],
      ["ada@mailer.test", true],
      ["ada@team.mailer.test", true],
      ["ada@mailer.example", true],
      ["ada@mailer.invalid", true],
      ["ada@qa.dispatch-fixture.net", true],
      ["ada@team.qa.dispatch-fixture.net", true],
      ["ada@notqa.dispatch-fixture.net", false],
      ["ada@dispatch-fixture.net", false],
    ];
    const accepted: Array<{ id: string; email: string; sandbox: boolean }> = [];
    for (const [email, sandbox] of fixtures) {
      const sent = await post(fullKey, "/emails", {
        from: "hello@dispatch-fixture.net",
        to: email,
        template: "sandbox",
        variables: { name: "Ada" },
      });
      expect(sent.status).toBe(200);
      expect(sent.json).toMatchObject({ id: expect.any(String), sandbox });
      const detail = await call(fullKey, "GET", `/emails/${sent.json.id}`);
      expect(detail.status).toBe(200);
      expect(detail.json).toMatchObject({
        id: sent.json.id, sandbox, last_event: "queued",
        subject: "Hello Ada", html: "<p>Hi Ada</p>", text: "Hi Ada",
        to: [email], cc: [], bcc: [],
        recipients: [{ email, kind: "to", sandbox }],
      });
      accepted.push({ id: sent.json.id, email, sandbox });
    }
    const list = await call(fullKey, "GET", "/emails?limit=100");
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(fixtures.length);
    for (const email of accepted)
      expect(list.json.data.find((row: { id: string }) => row.id === email.id)).toMatchObject({
        id: email.id, sandbox: email.sandbox, to: [email.email],
        recipients: [{ email: email.email, kind: "to", sandbox: email.sandbox }],
      });
    const flags = await db.query(
      `select e.id, e.sandbox, r.email, r.sandbox as recipient_sandbox
       from emails e join email_recipients r on r.email_id = e.id order by e.id`,
    );
    expect(flags.rows).toEqual(accepted.map((email) => ({
      id: email.id, sandbox: email.sandbox, email: email.email,
      recipient_sandbox: email.sandbox,
    })).sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("preserves sandbox attribution across repeated migrations and setting removal without sharing custom domains between tenants", async () => {
    expect((await call(fullKey, "PATCH", "/settings", {
      sandbox_domains: ["qa.dispatch-fixture.net"],
    })).status).toBe(200);
    const sandbox = await post(fullKey, "/emails", letter({
      to: "ada@qa.dispatch-fixture.net",
    }));
    const mixed = await post(fullKey, "/emails", letter({
      to: ["ada@team.qa.dispatch-fixture.net", "real@dispatch-fixture.net"],
    }));
    expect([sandbox.status, mixed.status]).toEqual([200, 200]);
    expect([sandbox.json.sandbox, mixed.json.sandbox]).toEqual([true, false]);
    const otherKey = await seedTenant();
    expect((await call(otherKey, "GET", "/settings")).json.sandbox_domains).toEqual([]);
    const other = await post(otherKey, "/emails", letter({ to: "ada@qa.dispatch-fixture.net" }));
    expect(other.status).toBe(200);
    expect(other.json.sandbox).toBe(false);
    expect((await call(otherKey, "GET", `/emails/${sandbox.json.id}`)).status).toBe(404);
    expect((await call(otherKey, "GET", "/emails")).json.data.map((row: { id: string }) => row.id)).toEqual([other.json.id]);
    const snapshot = () => db.query(
      `select e.id, e.sandbox, e.xmin::text as email_version, r.id as recipient_id,
              r.sandbox as recipient_sandbox, r.xmin::text as recipient_version
       from emails e join email_recipients r on r.email_id = e.id order by e.id, r.id`,
    );
    const before = (await snapshot()).rows;
    await db.query(schema);
    await db.query(schema);
    expect((await snapshot()).rows).toEqual(before);
    expect((await call(fullKey, "PATCH", "/settings", { sandbox_domains: [] })).status).toBe(200);
    await db.query(schema);
    await db.query(schema);
    expect((await snapshot()).rows).toEqual(before);

    const current = await post(fullKey, "/emails", letter({ to: "ada@qa.dispatch-fixture.net" }));
    expect(current.status).toBe(200);
    expect(current.json.sandbox).toBe(false);

    const blocked = recordingSes({ refuse: true });
    await productionDelivery(await sendJob(sandbox.json.id), blocked.provider);
    expect(blocked.quotas).toEqual([]);
    expect(blocked.sent).toEqual([]);
    const ses = recordingSes();
    await productionDelivery(await sendJob(mixed.json.id), ses.provider);
    await productionDelivery(await sendJob(other.json.id), ses.provider);
    await productionDelivery(await sendJob(current.json.id), ses.provider);
    expect(ses.sent.map((email) => email.recipients)).toEqual([
      [{ email: "real@dispatch-fixture.net", kind: "to" }],
      [{ email: "ada@qa.dispatch-fixture.net", kind: "to" }],
      [{ email: "ada@qa.dispatch-fixture.net", kind: "to" }],
    ]);
    expect((await call(fullKey, "GET", `/emails/${sandbox.json.id}`)).json).toMatchObject({
      sandbox: true, last_event: "delivered",
      recipients: [{ email: "ada@qa.dispatch-fixture.net", sandbox: true }],
    });
    expect((await call(fullKey, "GET", `/emails/${mixed.json.id}`)).json.recipients).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: "ada@team.qa.dispatch-fixture.net", sandbox: true }),
      expect.objectContaining({ email: "real@dispatch-fixture.net", sandbox: false }),
    ]));
    expect((await db.query(
      "select email, sandbox, status from email_recipients where email_id = $1 order by email",
      [mixed.json.id],
    )).rows).toEqual([
      { email: "ada@team.qa.dispatch-fixture.net", sandbox: true, status: "delivered" },
      { email: "real@dispatch-fixture.net", sandbox: false, status: "sent" },
    ]);
  });

  it("bypasses SES in production and delivers one signed sandbox webhook without duplicate events or attempts on job retries", async () => {
    const capture = await captureWebhook();
    try {
      const webhook = await post(fullKey, "/webhooks", {
        url: `${capture.base}/ok`,
        events: ["email.delivered"],
      });
      expect(webhook.status).toBe(200);
      const sent = await post(fullKey, "/emails", letter({
        to: "ada@example.com", cc: "grace@nested.example.org", bcc: "linus@mailer.invalid",
      }));
      expect(sent.status).toBe(200);
      expect(sent.json.sandbox).toBe(true);
      const job = await sendJob(sent.json.id);
      const ses = recordingSes({ refuse: true });
      await productionDelivery(job, ses.provider);
      const events = await db.query(
        "select id, type, data from email_events where email_id = $1 order by id",
        [sent.json.id],
      );
      expect(events.rows).toEqual([{
        id: expect.any(String), type: "email.delivered",
        data: { sandbox: true, recipients: expect.arrayContaining(["ada@example.com", "grace@nested.example.org", "linus@mailer.invalid"]) },
      }]);
      expect(events.rows[0]!.data.recipients).toHaveLength(3);
      expect(events.rows[0]!.data).not.toHaveProperty("provider_message_id");
      const attempts = await db.query(
        "select id, event_id, attempt, state from webhook_attempts where webhook_id = $1",
        [webhook.json.id],
      );
      expect(attempts.rows).toEqual([{
        id: expect.any(String), event_id: events.rows[0]!.id, attempt: 1, state: "queued",
      }]);
      await productionDelivery(job, ses.provider);
      expect((await db.query("select id, type, data from email_events where email_id = $1 order by id", [sent.json.id])).rows).toEqual(events.rows);
      expect((await db.query("select id, event_id, attempt, state from webhook_attempts where webhook_id = $1", [webhook.json.id])).rows).toEqual(attempts.rows);
      expect((await db.query("select status, sandbox, provider_message_id, message_id from emails where id = $1", [sent.json.id])).rows).toEqual([{
        status: "delivered", sandbox: true, provider_message_id: null, message_id: null,
      }]);
      expect((await db.query("select status, sandbox from email_recipients where email_id = $1", [sent.json.id])).rows).toEqual([
        { status: "delivered", sandbox: true },
        { status: "delivered", sandbox: true },
        { status: "delivered", sandbox: true },
      ]);
      expect((await db.query("select state from send_jobs where id = $1", [job.id])).rows).toEqual([{ state: "done" }]);
      expect((await db.query("select id from provider_events_raw where tenant_id = $1", [job.tenant_id])).rows).toEqual([]);
      expect((await db.query("select value from usage_counters where tenant_id = $1 and name = 'emails.sent'", [job.tenant_id])).rows).toEqual([]);
      await tick();
      expect(capture.received).toHaveLength(1);
      const delivered = capture.received[0]!;
      expect(JSON.parse(delivered.body)).toMatchObject({
        id: events.rows[0]!.id, type: "email.delivered",
        data: events.rows[0]!.data,
      });
      expect(JSON.parse(delivered.body).data).not.toHaveProperty("provider_message_id");
      expect(sign(delivered.body, webhook.json.signing_secret, delivered.id, Number(delivered.timestamp)).signature).toBe(delivered.signature);
      expect(verify(delivered.body, webhook.json.signing_secret, delivered.id, delivered.timestamp, delivered.signature)).toBe(true);
      await productionDelivery(job, ses.provider);
      await tick();
      expect(capture.received).toHaveLength(1);
      expect((await db.query("select id, attempt, state from webhook_attempts where webhook_id = $1", [webhook.json.id])).rows).toEqual([{
        id: attempts.rows[0]!.id, attempt: 1, state: "sent",
      }]);
      expect(ses.quotas).toEqual([]);
      expect(ses.sent).toEqual([]);
    } finally {
      await capture.close();
    }
  });

  it("hands only real to cc and bcc recipients to SES while sandbox delivery cannot promote a mixed email", async () => {
    const sent = await post(fullKey, "/emails", letter({
      to: ["real-to@dispatch-fixture.net", "sandbox-to@example.com"],
      cc: ["real-cc@dispatch-fixture.net", "sandbox-cc@mailer.test"],
      bcc: ["real-bcc@dispatch-fixture.net", "sandbox-bcc@example.net"],
    }));
    expect(sent.status).toBe(200);
    expect(sent.json.sandbox).toBe(false);
    const job = await sendJob(sent.json.id);
    const real = [
      { email: "real-to@dispatch-fixture.net", kind: "to" },
      { email: "real-cc@dispatch-fixture.net", kind: "cc" },
      { email: "real-bcc@dispatch-fixture.net", kind: "bcc" },
    ];
    const sandbox = ["sandbox-to@example.com", "sandbox-cc@mailer.test", "sandbox-bcc@example.net"];
    const ses = recordingSes({
      beforeSend: async () => {
        expect((await db.query("select status, sandbox, provider_message_id from emails where id = $1", [sent.json.id])).rows).toEqual([{
          status: "queued", sandbox: false, provider_message_id: null,
        }]);
        expect((await db.query("select type, data from email_events where email_id = $1", [sent.json.id])).rows).toEqual([{
          type: "email.delivered", data: { sandbox: true, recipients: expect.arrayContaining(sandbox) },
        }]);
        const recipients = await db.query("select email, status, sandbox from email_recipients where email_id = $1", [sent.json.id]);
        for (const row of recipients.rows)
          expect(row).toMatchObject({
            sandbox: sandbox.includes(row.email),
            status: sandbox.includes(row.email) ? "delivered" : "queued",
          });
      },
    });
    await productionDelivery(job, ses.provider);
    expect(ses.quotas).toEqual(["us-west-2"]);
    expect(ses.sent).toHaveLength(1);
    expect(ses.sent[0]!.recipients).toHaveLength(3);
    expect(ses.sent[0]!.recipients).toEqual(expect.arrayContaining(real));
    const detail = await call(fullKey, "GET", `/emails/${sent.json.id}`);
    expect(detail.json).toMatchObject({
      sandbox: false, last_event: "sent",
      to: expect.arrayContaining(["real-to@dispatch-fixture.net", "sandbox-to@example.com"]),
      cc: expect.arrayContaining(["real-cc@dispatch-fixture.net", "sandbox-cc@mailer.test"]),
      bcc: expect.arrayContaining(["real-bcc@dispatch-fixture.net", "sandbox-bcc@example.net"]),
    });
    expect(detail.json.recipients).toHaveLength(6);
    for (const row of detail.json.recipients)
      expect(row.sandbox).toBe(sandbox.includes(row.email));
    const afterSend = await db.query("select email, sandbox, status from email_recipients where email_id = $1", [sent.json.id]);
    for (const row of afterSend.rows)
      expect(row).toMatchObject({
        sandbox: sandbox.includes(row.email),
        status: sandbox.includes(row.email) ? "delivered" : "sent",
      });
    const list = await call(fullKey, "GET", "/emails");
    expect(list.json.data[0]).toMatchObject({
      id: sent.json.id, sandbox: false,
      recipients: expect.arrayContaining([
        ...real.map((recipient) => ({ ...recipient, status: "sent", sandbox: false })),
        ...sandbox.map((email, index) => ({ email, kind: ["to", "cc", "bcc"][index], status: "delivered", sandbox: true })),
      ]),
    });
    await appendEvent(db, {
      tenantId: job.tenant_id, requestId: job.request_id, emailId: job.email_id,
      type: "email.delivered", providerEventId: `${job.email_id}:ses:delivered`,
      data: { provider_message_id: `ses_${job.email_id}` },
      mode: "delivery", provider: "ses", recipients: real.map((recipient) => recipient.email),
    });
    expect((await stored(sent.json.id)).status).toBe("delivered");
    expect((await db.query("select status, sandbox from email_recipients where email_id = $1 and sandbox", [sent.json.id])).rows).toEqual([
      { status: "delivered", sandbox: true },
      { status: "delivered", sandbox: true },
      { status: "delivered", sandbox: true },
    ]);
    await productionDelivery(job, ses.provider);
    expect(ses.sent).toHaveLength(1);
    expect((await db.query("select id from email_events where email_id = $1", [sent.json.id])).rows).toHaveLength(3);
  });

  it("finishes mixed sandbox jobs without claiming real delivery when every real recipient is suppressed", async () => {
    await post(fullKey, "/suppressions", { email: "suppressed@dispatch-fixture.net" });
    const accepted = await post(fullKey, "/emails", letter({
      to: ["preview@example.com", "suppressed@dispatch-fixture.net"],
    }));
    expect(accepted.status).toBe(200);
    expect(accepted.json.sandbox).toBe(false);
    const ses = recordingSes({ refuse: true });
    const job = await sendJob(accepted.json.id);
    await productionDelivery(job, ses.provider);
    expect(ses.sent).toEqual([]);
    expect(ses.quotas).toEqual([]);
    expect((await db.query("select status, sandbox from emails where id = $1", [accepted.json.id])).rows).toEqual([{ status: "suppressed", sandbox: false }]);
    expect((await db.query("select state from send_jobs where id = $1", [job.id])).rows).toEqual([{ state: "done" }]);
    expect((await db.query("select email, sandbox, status from email_recipients where email_id = $1 order by email", [accepted.json.id])).rows).toEqual([
      { email: "preview@example.com", sandbox: true, status: "delivered" },
      { email: "suppressed@dispatch-fixture.net", sandbox: false, status: "suppressed" },
    ]);
  });

  it("marks actual sandbox tracking requests as simulated and excludes their opens and clicks", async () => {
    const accepted = await post(fullKey, "/emails", letter({
      to: "preview@example.com", html: '<p><a href="https://dispatch-fixture.net/docs">Docs</a></p>',
    }));
    expect(accepted.status).toBe(200);
    await productionDelivery(await sendJob(accepted.json.id), recordingSes({ refuse: true }).provider);
    const tracked = (await db.query<{ html_tracked: string }>("select html_tracked from emails where id = $1", [accepted.json.id])).rows[0]!.html_tracked;
    const open = new URL(tracked.match(/src="([^"]+\/open\/[^"]+)"/)![1]!);
    const click = new URL(tracked.match(/href="([^"]+\/click\/[^"]+)"/)![1]!);
    expect((await app.inject({ method: "GET", url: open.pathname })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: click.pathname })).statusCode).toBe(302);
    const events = (await db.query<{ type: string; data: Record<string, unknown> }>("select type, data from email_events where email_id = $1", [accepted.json.id])).rows;
    expect(events.map((event) => event.type).sort()).toEqual(["email.clicked", "email.delivered", "email.opened"]);
    expect(events.every((event) => event.data.sandbox === true)).toBe(true);
    const metrics = await call(fullKey, "GET", "/emails/metrics?metrics=sent,delivered,opened,clicked,open_rate,click_rate");
    expect(metrics.status).toBe(200);
    expect(metrics.json.totals).toEqual({ sent: 0, delivered: 0, opened: 0, clicked: 0, open_rate: 0, click_rate: 0 });
  });

  it("reconciles newly sandboxed recipients on a mixed retry without duplicating the delivery webhook", async () => {
    const webhook = await post(fullKey, "/webhooks", { url: "http://127.0.0.1:9/sandbox-retry", events: ["email.delivered"] });
    expect(webhook.status).toBe(200);
    const accepted = await post(fullKey, "/emails", letter({
      to: ["preview@example.com", "real@retry.dispatch-fixture.net"],
    }));
    const job = await sendJob(accepted.json.id);
    const retry = recordingSes();
    retry.provider.send = async () => { throw new ProviderError("Throttled", true, true); };
    await expect(productionDelivery(job, retry.provider)).rejects.toThrow("Throttled");
    expect((await stored(accepted.json.id)).status).toBe("queued");
    const before = (await db.query("select id, data from email_events where email_id = $1", [accepted.json.id])).rows;
    expect(before).toHaveLength(1);
    expect((await call(fullKey, "PATCH", "/settings", { sandbox_domains: ["retry.dispatch-fixture.net"] })).status).toBe(200);
    const ses = recordingSes({ refuse: true });
    await productionDelivery(job, ses.provider);
    expect(ses.quotas).toEqual([]);
    expect(ses.sent).toEqual([]);
    expect((await db.query("select sandbox, status from emails where id = $1", [accepted.json.id])).rows).toEqual([{ sandbox: true, status: "delivered" }]);
    expect((await db.query("select sandbox, status from email_recipients where email_id = $1", [accepted.json.id])).rows).toEqual([
      { sandbox: true, status: "delivered" }, { sandbox: true, status: "delivered" },
    ]);
    expect((await db.query("select id, data from email_events where email_id = $1", [accepted.json.id])).rows).toEqual(before);
    expect((await db.query("select id from webhook_attempts where webhook_id = $1", [webhook.json.id])).rows).toHaveLength(1);
    expect((await db.query("select state from send_jobs where id = $1", [job.id])).rows).toEqual([{ state: "done" }]);
  });

  it("returns each email's sandbox flag on split marketing and batch idempotency replays", async () => {
    const topic = await post(fullKey, "/topics", { name: "Sandbox", default_subscription: "opt_in" });
    expect(topic.status).toBe(200);
    const body = letter({
      to: ["ada@example.com", "real@dispatch-fixture.net"],
      cc: "grace@mailer.test",
      bcc: "real-bcc@dispatch-fixture.net",
      topic_id: topic.json.id,
    });
    const first = await post(fullKey, "/emails", body, { "idempotency-key": "sandbox-split" });
    expect(first.status).toBe(200);
    expect(first.json.sandbox).toBe(true);
    expect(first.json.emails.map((email: { to: string; sandbox: boolean }) => ({ to: email.to, sandbox: email.sandbox }))).toEqual([
      { to: "ada@example.com", sandbox: true },
      { to: "real@dispatch-fixture.net", sandbox: false },
      { to: "grace@mailer.test", sandbox: true },
      { to: "real-bcc@dispatch-fixture.net", sandbox: false },
    ]);
    expect((await post(fullKey, "/emails", body, { "idempotency-key": "sandbox-split" })).json).toEqual({ ...first.json, request_id: expect.any(String) });
    const batchBody = { emails: [
      letter({ to: "batch@example.org" }),
      letter({ to: "batch@dispatch-fixture.net" }),
      body,
    ] };
    const batch = await post(fullKey, "/emails/batch", batchBody, { "idempotency-key": "sandbox-batch" });
    expect(batch.status).toBe(200);
    expect(batch.json.data.map((email: { sandbox: boolean }) => email.sandbox)).toEqual([true, false, true]);
    expect(batch.json.data[2].emails.map((email: { sandbox: boolean }) => email.sandbox)).toEqual([true, false, true, false]);
    expect((await post(fullKey, "/emails/batch", batchBody, { "idempotency-key": "sandbox-batch" })).json).toEqual({ ...batch.json, request_id: expect.any(String) });
    expect((await db.query("select id from emails")).rows).toHaveLength(10);
  });

  describe("sandbox history", () => {
    it("calculates broadcast counts after waiting for the current classification transaction", async () => {
      const broadcast = await queuedBroadcast("locked@locked.dispatch-fixture.net");
      const job = await sendJob(broadcast.emailId);
      const writer = await db.connect();
      const reader = await db.connect();
      let pending: Promise<void> | undefined;
      try {
        await writer.query("begin");
        await writer.query("select id from broadcasts where tenant_id = $1 and id = $2 for update", [job.tenant_id, broadcast.id]);
        await reader.query("begin");
        const pid = (await reader.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
        pending = reconcileBroadcastSent(reader, job.tenant_id, broadcast.id);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting = (await db.query("select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = $1", [pid])).rows[0]?.waiting === true;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        // The aggregate's snapshot must follow this committed classification, not the
        // earlier snapshot it had while blocked behind the broadcast row lock.
        await writer.query("update emails set sandbox = true where tenant_id = $1 and id = $2", [job.tenant_id, broadcast.emailId]);
        await writer.query("commit");
        await pending;
        await reader.query("commit");
        expect((await call(fullKey, "GET", `/broadcasts/${broadcast.id}`)).json.sent_count).toBe(0);
        await appendEvent(db, {
          tenantId: job.tenant_id, requestId: job.request_id, emailId: broadcast.emailId,
          type: "email.sent", providerEventId: "historical:locked:sent",
          data: { sandbox: false }, mode: "delivery", provider: "ses",
        });
        await Promise.all(Array.from({ length: 3 }, () => tx(db, (client) =>
          reconcileBroadcastSent(client, job.tenant_id, broadcast.id))));
        expect((await call(fullKey, "GET", `/broadcasts/${broadcast.id}`)).json.sent_count).toBe(1);
        await tx(db, (client) => reconcileBroadcastSent(client, "other_tenant", broadcast.id));
        expect((await call(fullKey, "GET", `/broadcasts/${broadcast.id}`)).json.sent_count).toBe(1);
      } finally {
        await writer.query("rollback");
        await pending?.catch(() => undefined);
        await reader.query("rollback");
        writer.release();
        reader.release();
      }
    });

    it("reconciles a queued real broadcast to zero after late sandbox routing and keeps retries and setting removal stable", async () => {
      const capture = await captureWebhook();
      try {
        const webhook = await post(fullKey, "/webhooks", {
          url: `${capture.base}/ok`, events: ["email.delivered"],
        });
        expect(webhook.status).toBe(200);
        const broadcast = await queuedBroadcast("late@late.dispatch-fixture.net");
        const job = await sendJob(broadcast.emailId);
        const count = async (expected: number) => {
          const detail = await call(fullKey, "GET", `/broadcasts/${broadcast.id}`);
          expect(detail.status).toBe(200);
          expect(detail.json).toMatchObject({ sent_count: expected, recipient_count: 1 });
          const list = await call(fullKey, "GET", "/broadcasts");
          expect(list.status).toBe(200);
          expect(list.json.data.find((row: { id: string }) => row.id === broadcast.id)).toMatchObject({ id: broadcast.id });
          expect((await db.query("select sent_count from broadcasts where id = $1", [broadcast.id])).rows).toEqual([{ sent_count: expected }]);
        };
        // Ordinary real broadcasts count at queue time, before SES acceptance.
        await count(1);
        expect((await db.query("select sandbox, status, provider_message_id from emails where id = $1", [broadcast.emailId])).rows).toEqual([{
          sandbox: false, status: "queued", provider_message_id: null,
        }]);
        expect((await call(fullKey, "PATCH", "/settings", {
          sandbox_domains: ["late.dispatch-fixture.net"],
        })).status).toBe(200);
        const ses = recordingSes({ refuse: true });
        await productionDelivery(job, ses.provider);
        await count(0);
        expect((await call(fullKey, "GET", `/emails/${broadcast.emailId}`)).json).toMatchObject({
          sandbox: true, last_event: "delivered",
          recipients: [{ email: "late@late.dispatch-fixture.net", sandbox: true, status: "delivered" }],
        });
        const events = (await db.query("select id, type, data from email_events where email_id = $1 order by id", [broadcast.emailId])).rows;
        expect(events).toEqual([{
          id: expect.any(String), type: "email.delivered",
          data: { sandbox: true, recipients: ["late@late.dispatch-fixture.net"] },
        }]);
        const attempts = (await db.query("select id, event_id, attempt from webhook_attempts where webhook_id = $1", [webhook.json.id])).rows;
        expect(attempts).toEqual([{ id: expect.any(String), event_id: events[0]!.id, attempt: 1 }]);
        for (let repeat = 0; repeat < 2; repeat++) {
          await productionDelivery(job, ses.provider);
          await count(0);
        }
        expect((await call(fullKey, "PATCH", "/settings", { sandbox_domains: [] })).status).toBe(200);
        await db.query(schema);
        await db.query(schema);
        await productionDelivery(job, ses.provider);
        await count(0);
        expect((await db.query("select id, type, data from email_events where email_id = $1 order by id", [broadcast.emailId])).rows).toEqual(events);
        expect((await db.query("select id, event_id, attempt from webhook_attempts where webhook_id = $1", [webhook.json.id])).rows).toEqual(attempts);
        expect((await db.query("select state from send_jobs where id = $1", [job.id])).rows).toEqual([{ state: "done" }]);
        expect((await db.query("select status from broadcast_recipients where broadcast_id = $1", [broadcast.id])).rows).toEqual([{ status: "sent" }]);
        expect((await db.query("select id from provider_events_raw where tenant_id = $1", [job.tenant_id])).rows).toEqual([]);
        expect((await db.query("select value from usage_counters where tenant_id = $1 and name = 'emails.sent'", [job.tenant_id])).rows).toEqual([]);
        const metrics = await call(fullKey, "GET", `/emails/metrics?broadcast_id=${broadcast.id}&metrics=sent,delivered,opened,clicked`);
        expect(metrics.status).toBe(200);
        expect(metrics.json.totals).toEqual({ sent: 0, delivered: 0, opened: 0, clicked: 0 });
        await tick();
        await productionDelivery(job, ses.provider);
        await tick();
        await count(0);
        expect(capture.received).toHaveLength(1);
        const delivered = capture.received[0]!;
        expect(JSON.parse(delivered.body)).toMatchObject({ id: events[0]!.id, type: "email.delivered", data: events[0]!.data });
        expect(verify(delivered.body, webhook.json.signing_secret, delivered.id, delivered.timestamp, delivered.signature)).toBe(true);
        expect(ses.quotas).toEqual([]);
        expect(ses.sent).toEqual([]);
      } finally {
        await capture.close();
      }
    });

    it.each(["explicit", "legacy"] as const)(
      "preserves %s real broadcast email automation step and click history when an API retry becomes sandbox",
      async (attribution) => {
        const broadcast = await queuedBroadcast("history@history.dispatch-fixture.net");
        const job = await sendJob(broadcast.emailId);
        const flow = await post(fullKey, "/automations", {
          name: "Historical broadcast", enabled: false,
          steps: [{ key: "start", type: "trigger", config: { event_name: "sandbox.history" } }],
          connections: [],
        });
        expect(flow.status).toBe(200);
        await db.query("update emails set automation_id = $1, automation_step = 'welcome' where id = $2", [flow.json.id, broadcast.emailId]);
        const ses = recordingSes();
        await productionDelivery(job, ses.provider);
        const callback = {
          mail: {
            messageId: `ses_${broadcast.emailId}`, destination: ["history@history.dispatch-fixture.net"],
            tags: { dispatch_email_id: [broadcast.emailId], dispatch_tenant_id: [job.tenant_id] },
          },
        };
        expect(await tx(db, (client) => applySesEvent(client, {
          ...callback, eventType: "Delivery", delivery: { recipients: ["history@history.dispatch-fixture.net"] },
        }))).toHaveLength(1);
        const tracked = await stored(broadcast.emailId);
        const open = new URL(tracked.html_tracked.match(/src="([^"]+\/open\/[^"]+)"/)![1]!);
        const click = new URL(tracked.html_tracked.match(/href="([^"]+\/click\/[^"]+)"/)![1]!);
        expect((await app.inject({ method: "GET", url: open.pathname })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: click.pathname })).statusCode).toBe(302);
        // Tracking deduplicates within the same millisecond; these are two genuine clicks.
        await new Promise((resolve) => setTimeout(resolve, 2));
        expect((await app.inject({ method: "GET", url: click.pathname })).statusCode).toBe(302);
        const bounce = {
          ...callback, eventType: "Bounce",
          bounce: { bounceType: "Transient", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "history@history.dispatch-fixture.net" }] },
        };
        expect(await tx(db, (client) => applySesEvent(client, bounce))).toHaveLength(1);
        expect(await tx(db, (client) => applySesEvent(client, bounce))).toEqual([]);
        expect((await stored(broadcast.emailId)).status).toBe("bounced");
        // Permanent bounce/suppression would mask the retry routing regression.
        expect((await db.query("select id from suppressions where tenant_id = $1 and removed_at is null", [job.tenant_id])).rows).toEqual([]);
        if (attribution === "legacy")
          await db.query("update email_events set data = data - 'sandbox' where email_id = $1", [broadcast.emailId]);
        const history = (await db.query<{ id: string; type: string; data: Record<string, unknown> }>(
          "select id, type, data from email_events where email_id = $1 order by id", [broadcast.emailId],
        )).rows;
        expect(history).toHaveLength(6);
        expect(history.every((event) => attribution === "legacy"
          ? !Object.hasOwn(event.data, "sandbox") : event.data.sandbox === false)).toBe(true);
        const metricsQuery = new URLSearchParams({
          metrics: "sent,delivered,bounced,bounced_transient,opened,unique_opened,clicked,unique_clicked,delivery_rate,open_rate,click_rate,bounce_rate",
          automation_id: flow.json.id,
        });
        const totals = {
          sent: 1, delivered: 1, bounced: 1, bounced_transient: 1,
          opened: 1, unique_opened: 1, clicked: 2, unique_clicked: 1,
          delivery_rate: 100, open_rate: 100, click_rate: 100, bounce_rate: 100,
        };
        const reports = async () => {
          // Count committed history using the clock that timestamps those rows.
          const end = (await db.query<{ end_date: Date }>("select clock_timestamp() as end_date")).rows[0]!.end_date;
          metricsQuery.set("end_date", end.toISOString());
          for (const dimensions of ["", "email", "automation", "step"]) {
            metricsQuery.set("dimensions", dimensions);
            const metrics = await call(fullKey, "GET", `/emails/metrics?${metricsQuery}`);
            expect(metrics.status).toBe(200);
            expect(metrics.json.totals).toEqual(totals);
            if (dimensions)
              expect(metrics.json.data).toEqual([{
                ...(dimensions === "email" ? { email_id: broadcast.emailId } : { automation_id: flow.json.id }),
                ...(dimensions === "step" ? { automation_step: "welcome" } : {}),
                ...totals,
              }]);
          }
          const clicks = await call(fullKey, "GET", `/broadcasts/${broadcast.id}/clicked-links`);
          expect(clicks.status).toBe(200);
          expect(clicks.json.data).toEqual([{
            object: "clicked_link", id: expect.any(String), url: "https://dispatch-fixture.net/docs",
            clicks: 2, unique_clicks: 1,
          }]);
          expect((await call(fullKey, "GET", `/broadcasts/${broadcast.id}`)).json.sent_count).toBe(1);
        };
        await reports();
        const webhook = await post(fullKey, "/webhooks", {
          url: "http://127.0.0.1:9/history", events: ["email.delivered"],
        });
        expect(webhook.status).toBe(200);
        expect((await call(fullKey, "PATCH", "/settings", { sandbox_domains: ["history.dispatch-fixture.net"] })).status).toBe(200);
        const retried = await post(fullKey, `/emails/${broadcast.emailId}/retry`, {});
        expect(retried.status).toBe(200);
        expect(retried.json.job).toMatchObject({ id: expect.any(String), email_id: broadcast.emailId, state: "ready" });
        expect((await db.query("select provider_message_id, status, sandbox from emails where id = $1", [broadcast.emailId])).rows).toEqual([{
          provider_message_id: null, status: "queued", sandbox: false,
        }]);
        const retryJob = (await db.query<Job>("select id, tenant_id, email_id, request_id from send_jobs where id = $1", [retried.json.job.id])).rows[0]!;
        const blocked = recordingSes({ refuse: true });
        await productionDelivery(retryJob, blocked.provider);
        expect((await call(fullKey, "GET", `/emails/${broadcast.emailId}`)).json).toMatchObject({
          sandbox: true, last_event: "delivered",
          recipients: [{ email: "history@history.dispatch-fixture.net", sandbox: true }],
        });
        expect((await db.query("select provider_message_id from emails where id = $1", [broadcast.emailId])).rows).toEqual([{ provider_message_id: null }]);
        expect((await db.query("select id, type, data from email_events where id = any($1::text[]) order by id", [history.map((event) => event.id)])).rows).toEqual(
          history.map((event) => ({ ...event, data: { ...event.data, sandbox: false } })),
        );
        await reports();
        expect((await post(fullKey, `/emails/${broadcast.emailId}/retry`, {})).status).toBe(409);
        expect((await app.inject({ method: "GET", url: open.pathname })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: click.pathname })).statusCode).toBe(302);
        const simulated = (await db.query("select type, data from email_events where email_id = $1 and data->>'sandbox' = 'true'", [broadcast.emailId])).rows;
        expect(simulated.map((event) => event.type).sort()).toEqual(["email.clicked", "email.delivered", "email.opened"]);
        await reports();
        const snapshot = (await db.query("select id, type, data from email_events where email_id = $1 order by id", [broadcast.emailId])).rows;
        const attempts = (await db.query("select id, event_id, attempt from webhook_attempts where webhook_id = $1", [webhook.json.id])).rows;
        expect(attempts).toEqual([{ id: expect.any(String), event_id: expect.any(String), attempt: 1 }]);
        await productionDelivery(retryJob, blocked.provider);
        await productionDelivery(job, blocked.provider);
        expect((await call(fullKey, "PATCH", "/settings", { sandbox_domains: [] })).status).toBe(200);
        await db.query(schema);
        await db.query(schema);
        await productionDelivery(retryJob, blocked.provider);
        await reports();
        expect((await db.query("select id, type, data from email_events where email_id = $1 order by id", [broadcast.emailId])).rows).toEqual(snapshot);
        expect((await db.query("select id, event_id, attempt from webhook_attempts where webhook_id = $1", [webhook.json.id])).rows).toEqual(attempts);
        expect((await db.query("select value from usage_counters where tenant_id = $1 and name = 'emails.sent'", [job.tenant_id])).rows).toEqual([{ value: "1" }]);
        expect(ses.quotas).toEqual(["us-west-2"]);
        expect(ses.sent).toHaveLength(1);
        expect(blocked.quotas).toEqual([]);
        expect(blocked.sent).toEqual([]);
      },
    );

    it.each(["partial", "all"] as const)(
      "preserves explicit and legacy mixed-recipient history when %s real recipients become simulated on an API retry",
      async (routing) => {
        const webhook = await post(fullKey, "/webhooks", {
          url: "http://127.0.0.1:9/mixed-history", events: ["email.delivered"],
        });
        expect(webhook.status).toBe(200);
        const segment = await post(fullKey, "/segments", { name: "Mixed history" });
        expect(segment.status).toBe(200);
        const broadcast = await post(fullKey, "/broadcasts", {
          name: "Mixed clicks", segment_id: segment.json.id, from: "hello@dispatch-fixture.net",
          subject: "History", html: '<a href="https://dispatch-fixture.net/docs">Docs</a>',
        });
        const flow = await post(fullKey, "/automations", {
          name: "Mixed history", enabled: false,
          steps: [{ key: "start", type: "trigger", config: { event_name: "sandbox.mixed.history" } }],
          connections: [],
        });
        expect([broadcast.status, flow.status]).toEqual([200, 200]);
        const accepted = await post(fullKey, "/emails", letter({
          to: ["preview@example.com", "new@new.dispatch-fixture.net", "remaining@remaining.dispatch-fixture.net"],
          html: '<a href="https://dispatch-fixture.net/docs">Docs</a>',
        }));
        expect(accepted.status).toBe(200);
        const job = await sendJob(accepted.json.id);
        await db.query("update emails set broadcast_id = $1, automation_id = $2, automation_step = 'mixed' where id = $3", [
          broadcast.json.id, flow.json.id, accepted.json.id,
        ]);
        const ses = recordingSes();
        await productionDelivery(job, ses.provider);
        expect(ses.sent[0]!.recipients).toEqual(expect.arrayContaining([
          { email: "new@new.dispatch-fixture.net", kind: "to" },
          { email: "remaining@remaining.dispatch-fixture.net", kind: "to" },
        ]));
        expect(ses.sent[0]!.recipients).toHaveLength(2);
        const callback = {
          mail: {
            messageId: `ses_${accepted.json.id}`,
            tags: { dispatch_email_id: [accepted.json.id], dispatch_tenant_id: [job.tenant_id] },
          },
        };
        expect(await tx(db, (client) => applySesEvent(client, {
          ...callback, eventType: "Delivery",
          delivery: { recipients: ["new@new.dispatch-fixture.net", "remaining@remaining.dispatch-fixture.net"] },
        }))).toHaveLength(2);
        const recipients = (await db.query<{ id: string; email: string; sandbox: boolean }>(
          "select id, email, sandbox from email_recipients where email_id = $1 order by email", [accepted.json.id],
        )).rows;
        const history: Array<{ id: string; sandbox: boolean }> = [];
        for (const recipient of recipients) {
          for (const type of ["email.opened", "email.clicked"]) {
            const event = await appendEvent(db, {
              tenantId: job.tenant_id, requestId: job.request_id, emailId: accepted.json.id, recipientId: recipient.id,
              type, providerEventId: `history:${recipient.id}:${type}`,
              data: type === "email.clicked" ? { url: "https://dispatch-fixture.net/docs" } : {},
            });
            expect(event).not.toBeNull();
            expect(event!.data.sandbox).toBe(recipient.sandbox);
            history.push({ id: event!.id, sandbox: recipient.sandbox });
            // One real recipient and the original sandbox recipient predate explicit markers.
            // The other real recipient keeps explicit false even as current routing changes.
            if (recipient.email !== "remaining@remaining.dispatch-fixture.net")
              await db.query("update email_events set data = data - 'sandbox' where id = $1", [event!.id]);
          }
        }
        const tracked = await stored(accepted.json.id);
        const open = new URL(tracked.html_tracked.match(/src="([^"]+\/open\/[^"]+)"/)![1]!);
        const click = new URL(tracked.html_tracked.match(/href="([^"]+\/click\/[^"]+)"/)![1]!);
        expect((await app.inject({ method: "GET", url: open.pathname })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: click.pathname })).statusCode).toBe(302);
        const bounce = {
          ...callback, eventType: "Bounce",
          bounce: { bounceType: "Transient", bouncedRecipients: [
            { emailAddress: "new@new.dispatch-fixture.net" }, { emailAddress: "remaining@remaining.dispatch-fixture.net" },
          ] },
        };
        expect(await tx(db, (client) => applySesEvent(client, bounce))).toHaveLength(2);
        expect(await tx(db, (client) => applySesEvent(client, bounce))).toEqual([]);
        expect((await stored(accepted.json.id)).status).toBe("bounced");
        expect((await db.query("select id from suppressions where tenant_id = $1 and removed_at is null", [job.tenant_id])).rows).toEqual([]);
        // Also preserve legacy provider events with no recipient_id.
        await db.query(
          "update email_events set data = data - 'sandbox' where email_id = $1 and type in ('email.sent', 'email.bounced')",
          [accepted.json.id],
        );
        const metricsQuery = new URLSearchParams({
          metrics: "sent,delivered,bounced,bounced_transient,opened,unique_opened,clicked,unique_clicked",
          automation_id: flow.json.id,
        });
        const original = { sent: 1, delivered: 2, bounced: 2, bounced_transient: 2, opened: 3, unique_opened: 1, clicked: 3, unique_clicked: 1 };
        const after = routing === "all" ? original
          : { sent: 2, delivered: 3, bounced: 2, bounced_transient: 2, opened: 4, unique_opened: 1, clicked: 4, unique_clicked: 1 };
        const reports = async (totals: typeof original) => {
          const end = (await db.query<{ end_date: Date }>("select clock_timestamp() as end_date")).rows[0]!.end_date;
          metricsQuery.set("end_date", end.toISOString());
          for (const dimensions of ["", "email", "automation", "step"]) {
            metricsQuery.set("dimensions", dimensions);
            const metrics = await call(fullKey, "GET", `/emails/metrics?${metricsQuery}`);
            expect(metrics.status).toBe(200);
            expect(metrics.json.totals).toEqual(totals);
            if (dimensions)
              expect(metrics.json.data).toEqual([{
                ...(dimensions === "email" ? { email_id: accepted.json.id } : { automation_id: flow.json.id }),
                ...(dimensions === "step" ? { automation_step: "mixed" } : {}),
                ...totals,
              }]);
          }
          const clicks = await call(fullKey, "GET", `/broadcasts/${broadcast.json.id}/clicked-links`);
          expect(clicks.status).toBe(200);
          expect(clicks.json.data).toEqual([{
            object: "clicked_link", id: expect.any(String), url: "https://dispatch-fixture.net/docs",
            clicks: totals.clicked, unique_clicks: 1,
          }]);
        };
        await reports(original);
        expect((await call(fullKey, "PATCH", "/settings", {
          sandbox_domains: routing === "all"
            ? ["new.dispatch-fixture.net", "remaining.dispatch-fixture.net"] : ["new.dispatch-fixture.net"],
        })).status).toBe(200);
        const retried = await post(fullKey, `/emails/${accepted.json.id}/retry`, {});
        expect(retried.status).toBe(200);
        expect((await db.query("select provider_message_id, status from emails where id = $1", [accepted.json.id])).rows).toEqual([{
          provider_message_id: null, status: "queued",
        }]);
        const retryJob = (await db.query<Job>("select id, tenant_id, email_id, request_id from send_jobs where id = $1", [retried.json.job.id])).rows[0]!;
        const retrySes = recordingSes({ refuse: routing === "all" });
        const send = retrySes.provider.send;
        retrySes.provider.send = async (email) => {
          const result = await send(email);
          const messageId = `ses_retry_${email.id}`;
          return { ...result, provider_message_id: messageId, events: result.events.map((event) => ({
            ...event, provider_event_id: `${messageId}:sent`, data: { provider_message_id: messageId },
          })) };
        };
        await productionDelivery(retryJob, retrySes.provider);
        if (routing === "partial") {
          expect(retrySes.quotas).toEqual(["us-west-2"]);
          expect(retrySes.sent.map((email) => email.recipients)).toEqual([[{ email: "remaining@remaining.dispatch-fixture.net", kind: "to" }]]);
          const delivery = {
            ...callback, mail: { ...callback.mail, messageId: `ses_retry_${accepted.json.id}` },
            eventType: "Delivery", delivery: { recipients: ["remaining@remaining.dispatch-fixture.net"] },
          };
          expect(await tx(db, (client) => applySesEvent(client, delivery))).toHaveLength(1);
          expect(await tx(db, (client) => applySesEvent(client, delivery))).toEqual([]);
        } else {
          expect(retrySes.quotas).toEqual([]);
          expect(retrySes.sent).toEqual([]);
        }
        const detail = await call(fullKey, "GET", `/emails/${accepted.json.id}`);
        expect(detail.json).toMatchObject({ sandbox: routing === "all", last_event: "delivered" });
        expect(detail.json.recipients).toEqual(expect.arrayContaining([
          expect.objectContaining({ email: "preview@example.com", sandbox: true, status: "delivered" }),
          // The old bounce remains a terminal recipient status; routing is independent.
          expect.objectContaining({ email: "new@new.dispatch-fixture.net", sandbox: true }),
          expect.objectContaining({ email: "remaining@remaining.dispatch-fixture.net", sandbox: routing === "all" }),
        ]));
        expect((await db.query("select id, data->'sandbox' as sandbox from email_events where id = any($1::text[]) order by id", [history.map((event) => event.id)])).rows).toEqual(
          [...history].sort((a, b) => a.id.localeCompare(b.id)),
        );
        const newlySandbox = recipients.find((recipient) => recipient.email === "new@new.dispatch-fixture.net")!;
        for (const type of ["email.opened", "email.clicked"]) {
          const event = await appendEvent(db, {
            tenantId: job.tenant_id, requestId: job.request_id, emailId: accepted.json.id, recipientId: newlySandbox.id,
            type, providerEventId: `simulated:${newlySandbox.id}:${type}`,
            data: type === "email.clicked" ? { url: "https://dispatch-fixture.net/docs" } : {},
          });
          expect(event!.data.sandbox).toBe(true);
        }
        expect((await app.inject({ method: "GET", url: open.pathname })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: click.pathname })).statusCode).toBe(302);
        await reports(after);
        const snapshot = (await db.query("select id, type, data from email_events where email_id = $1 order by id", [accepted.json.id])).rows;
        const attempts = (await db.query("select id, event_id, attempt from webhook_attempts where webhook_id = $1 order by id", [webhook.json.id])).rows;
        expect(attempts).toHaveLength(routing === "all" ? 3 : 4);
        expect(attempts.every((attempt) => attempt.attempt === 1)).toBe(true);
        await productionDelivery(retryJob, retrySes.provider);
        expect((await call(fullKey, "PATCH", "/settings", { sandbox_domains: [] })).status).toBe(200);
        await db.query(schema);
        await db.query(schema);
        await productionDelivery(retryJob, retrySes.provider);
        await reports(after);
        expect((await db.query("select id, type, data from email_events where email_id = $1 order by id", [accepted.json.id])).rows).toEqual(snapshot);
        expect((await db.query("select id, event_id, attempt from webhook_attempts where webhook_id = $1 order by id", [webhook.json.id])).rows).toEqual(attempts);
        expect(retrySes.sent).toHaveLength(routing === "all" ? 0 : 1);
        expect(retrySes.quotas).toHaveLength(routing === "all" ? 0 : 1);
        expect((await db.query("select value from usage_counters where tenant_id = $1 and name = 'emails.sent'", [job.tenant_id])).rows).toEqual([{ value: routing === "all" ? "1" : "2" }]);
      },
    );
  });

  it("hand-counts only real sending and engagement metrics including mixed recipients and automation steps", async () => {
    const flow = await post(fullKey, "/automations", {
      name: "Sandbox metrics", enabled: false,
      steps: [{ key: "start", type: "trigger", config: { event_name: "sandbox.metrics" } }],
      connections: [],
    });
    expect(flow.status).toBe(200);
    const allSandbox = await post(fullKey, "/emails", letter({ to: "only@example.com" }));
    const mixed = await post(fullKey, "/emails", letter({
      to: ["real@dispatch-fixture.net", "sandbox@example.net"],
    }));
    const real = await post(fullKey, "/emails", letter({ to: "other@dispatch-fixture.net" }));
    expect([allSandbox.status, mixed.status, real.status]).toEqual([200, 200, 200]);
    const job = await sendJob(mixed.json.id);
    await db.query(
      `update emails set automation_id = $1, automation_step = case id
       when $2 then 'sandbox' when $3 then 'welcome' else 'followup' end,
       created_at = '2026-10-01T12:00:00Z' where id = any($4::text[])`,
      [flow.json.id, allSandbox.json.id, mixed.json.id, [allSandbox.json.id, mixed.json.id, real.json.id]],
    );
    const recipients = (await db.query<{ id: string; email_id: string; sandbox: boolean }>(
      "select id, email_id, sandbox from email_recipients",
    )).rows;
    const types = ["email.sent", "email.delivered", "email.opened", "email.clicked", "email.unsubscribed"];
    await tx(db, async (client) => {
      const append = async (emailId: string, recipientId: string | null, type: string, key: string, sandbox = false) => {
        const event = await appendEvent(client, {
          tenantId: job.tenant_id, requestId: job.request_id, emailId, recipientId,
          type, providerEventId: `metrics:${key}`, data: sandbox ? { sandbox: true } : {},
        });
        expect(event).not.toBeNull();
        await client.query("update email_events set created_at = '2026-10-01T12:00:00Z' where id = $1", [event!.id]);
        return event!;
      };
      for (const [index, type] of types.entries()) {
        // Legacy events without the JSON marker must still be excluded by the email flag.
        const emailEvent = await append(allSandbox.json.id, null, type, `all:${index}`);
        expect(emailEvent.data.sandbox).toBe(true);
        await client.query("update email_events set data = '{}' where id = $1", [emailEvent.id]);
        // A simulation on a mixed email is excluded by its marker even without recipient_id.
        await append(mixed.json.id, null, type, `marker:${index}`, true);
        // Legacy recipient events must be excluded by the stored recipient flag alone.
        const recipient = recipients.find((row) => row.email_id === mixed.json.id && row.sandbox)!;
        const recipientEvent = await append(mixed.json.id, recipient.id, type, `recipient:${index}`);
        expect(recipientEvent.data.sandbox).toBe(true);
        await client.query("update email_events set data = '{}' where id = $1", [recipientEvent.id]);
      }
      const mixedRecipient = recipients.find((row) => row.email_id === mixed.json.id && !row.sandbox)!;
      for (const [index, type] of [...types, "email.opened"].entries())
        await append(mixed.json.id, mixedRecipient.id, type, `mixed-real:${index}`);
      const realRecipient = recipients.find((row) => row.email_id === real.json.id)!;
      for (const [index, type] of ["email.sent", "email.delivered", "email.opened", "email.clicked", "email.clicked"].entries())
        await append(real.json.id, realRecipient.id, type, `real:${index}`);
    });
    const query = new URLSearchParams({
      start_date: "2026-10-01T00:00:00Z", end_date: "2026-10-02T00:00:00Z",
      metrics: "sent,delivered,opened,unique_opened,clicked,unique_clicked,unsubscribed,delivery_rate,open_rate,click_rate,unsubscribe_rate",
    });
    const totals = {
      sent: 2, delivered: 2, opened: 3, unique_opened: 2, clicked: 3, unique_clicked: 2,
      unsubscribed: 1, delivery_rate: 100, open_rate: 100, click_rate: 100, unsubscribe_rate: 50,
    };
    const metrics = await call(fullKey, "GET", `/emails/metrics?${query}`);
    expect(metrics.status).toBe(200);
    expect(metrics.json.totals).toEqual(totals);
    query.set("dimensions", "step");
    query.set("automation_id", flow.json.id);
    const steps = await call(fullKey, "GET", `/emails/metrics?${query}`);
    expect(steps.status).toBe(200);
    expect(steps.json.totals).toEqual(totals);
    expect(steps.json.data.sort((a: { automation_step: string }, b: { automation_step: string }) => a.automation_step.localeCompare(b.automation_step))).toEqual([
      {
        automation_id: flow.json.id, automation_step: "followup",
        sent: 1, delivered: 1, opened: 1, unique_opened: 1, clicked: 2, unique_clicked: 1,
        unsubscribed: 0, delivery_rate: 100, open_rate: 100, click_rate: 100, unsubscribe_rate: 0,
      },
      {
        automation_id: flow.json.id, automation_step: "welcome",
        sent: 1, delivered: 1, opened: 2, unique_opened: 1, clicked: 1, unique_clicked: 1,
        unsubscribed: 1, delivery_rate: 100, open_rate: 100, click_rate: 100, unsubscribe_rate: 100,
      },
    ]);
    expect((await db.query("select count(*)::int as count from email_events where created_at = '2026-10-01T12:00:00Z'")).rows).toEqual([{ count: 26 }]);
  });

  it("merges concurrent settings patches atomically without changing another tenant", async () => {
    const otherKey = await seedTenant();
    const results = await Promise.all([
      call(fullKey, "PATCH", "/settings", { import_trigger_automations: true }),
      call(fullKey, "PATCH", "/settings", { sandbox_domains: ["atomic.test"] }),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect((await call(fullKey, "GET", "/settings")).json).toMatchObject({
      import_trigger_automations: true,
      sandbox_domains: ["atomic.test"],
    });
    expect((await call(otherKey, "GET", "/settings")).json).toMatchObject({
      import_trigger_automations: false,
      sandbox_domains: [],
    });
  });

  it("keeps tenant settings across repeated migrations and refuses viewer writes", async () => {
    const original = await call(fullKey, "GET", "/settings");
    expect(original.json).toMatchObject({
      import_trigger_automations: false,
      sandbox_domains: [],
    });
    const changed = await call(fullKey, "PATCH", "/settings", {
      import_trigger_automations: true,
    });
    expect(changed.status).toBe(200);
    await call(fullKey, "PATCH", "/settings", { sandbox_domains: ["qa.test"] });
    await db.query(schema);
    await db.query(schema);
    expect((await call(fullKey, "GET", "/settings")).json).toMatchObject({
      import_trigger_automations: true,
      sandbox_domains: ["qa.test"],
    });
    const viewer = await teammate("Viewer");
    const session = await signInAs(viewer.email, viewer.password);
    expect((await call(session.token, "GET", "/settings")).status).toBe(200);
    expect(
      (
        await call(session.token, "PATCH", "/settings", {
          import_trigger_automations: false,
        })
      ).status,
    ).toBe(403);
  });

  it("signs in with a password, and lets a viewer read but not write or see secrets", async () => {
    await teammate("Admin");
    const viewer = await teammate("Viewer");
    const webhook = await call(fullKey, "POST", "/webhooks", {
      endpoint: "http://127.0.0.1:9/hooks/secret-path",
      events: ["email.sent"],
    });
    expect(webhook.status).toBe(200);
    const session = await signInAs(viewer.email, viewer.password);
    expect(session.status).toBe(200);

    // The real preHandler, not a test stand-in, decides.
    expect((await call(session.token, "GET", "/emails")).status).toBe(200);
    expect(
      (await call(session.token, "POST", "/emails", letter())).status,
    ).toBe(403);
    expect(
      (
        await call(session.token, "PATCH", `/webhooks/${webhook.json.id}`, {
          enabled: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(session.token, "POST", "/roles", {
          name: "Sneaky",
          permissions: ["full"],
        })
      ).status,
    ).toBe(403);
    const shown = await call(
      session.token,
      "GET",
      `/webhooks/${webhook.json.id}`,
    );
    expect(shown.status).toBe(200);
    expect(shown.json.signing_secret).toBeUndefined();
    expect(shown.json.endpoint).toBe("http://127.0.0.1:9/…");
    expect((await call(session.token, "GET", "/me")).json.scope).toBe("read");
    expect(
      (
        await call(session.token, "POST", "/me/password", {
          current_password: "not the password",
          password: "another long password",
        })
      ).status,
    ).toBe(422);

    // Ending its own session is the one delete a viewer may make.
    const me = await call(session.token, "GET", "/me");
    expect(
      (await call(session.token, "DELETE", `/sessions/${me.json.session_id}`))
        .status,
    ).toBe(200);
    expect((await call(session.token, "GET", "/emails")).status).toBe(401);
  });

  it("refuses an email after 10 failed sign-ins, counting attempts that arrive together", async () => {
    const admin = await teammate("Admin");
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        signInAs(admin.email, "wrong password here"),
      ),
    );
    expect(results.filter((result) => result.status === 401)).toHaveLength(10);
    expect(results.filter((result) => result.status === 429)).toHaveLength(5);
    expect((await signInAs(admin.email, admin.password)).status).toBe(429);
  });

  it("applies the schema again after an admin renamed the Viewer role", async () => {
    await db.query(schema);
    const tenant = (
      await db.query<{ id: string }>("select id from tenants limit 1")
    ).rows[0]!.id;
    const viewer = (
      await db.query<{ id: string }>(
        "select id from roles where tenant_id = $1 and name = 'Viewer'",
        [tenant],
      )
    ).rows[0]!;
    expect(
      (await call(fullKey, "PATCH", `/roles/${viewer.id}`, { name: "Support" }))
        .status,
    ).toBe(200);
    await db.query(schema);
    const roles = await db.query<{ name: string }>(
      "select name from roles where tenant_id = $1 and permissions = '[\"read\"]'::jsonb",
      [tenant],
    );
    expect(roles.rows.map((row) => row.name)).toEqual(["Support"]);
  });

  it("makes one contact when two events for a new address arrive together", async () => {
    const sends = await Promise.all(
      ["Ada", "Grace"].map((name) =>
        post(fullKey, "/events/send", {
          event: "user.created",
          email: "new@dispatch-fixture.net",
          payload: { first_name: name },
        }),
      ),
    );
    expect(sends.map((send) => send.status)).toEqual([202, 202]);
    const contacts = await db.query<{ first_name: string }>(
      "select first_name from contacts where lower(email) = 'new@dispatch-fixture.net'",
    );
    expect(contacts.rows).toHaveLength(1);
    expect(["Ada", "Grace"]).toContain(contacts.rows[0]!.first_name);
  });

  it("lets a send key send, then returns 403 after that key is revoked", async () => {
    const created = await post(fullKey, "/api-keys", {
      name: "send",
      scope: "send",
    });
    expect(created.status).toBe(200);
    const secret = created.json.token as string;
    const keyId = created.json.id as string;

    const sent = await post(secret, "/emails", letter());
    expect(sent.status).toBe(200);
    expect(sent.json.id).toEqual(expect.any(String));

    const removed = await app.inject({
      method: "DELETE",
      url: `/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(removed.statusCode).toBe(200);

    const again = await post(
      secret,
      "/emails",
      letter({ to: "again@dispatch-fixture.net" }),
    );
    expect(again.status).toBe(403);
  });

  it("replays the same idempotency key and rejects a different body", async () => {
    const body = letter();
    const headers = { "idempotency-key": "idem-accept-1" };
    const first = await post(fullKey, "/emails", body, headers);
    const second = await post(fullKey, "/emails", body, headers);
    expect(first.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);

    const conflict = await post(
      fullKey,
      "/emails",
      letter({ subject: "Different" }),
      headers,
    );
    expect(conflict.status).toBe(409);

    const stored = await db.query("select id from emails");
    expect(stored.rows).toEqual([{ id: first.json.id }]);
  });

  it("stores inline attachment metadata after its parent transactional email", async () => {
    const sent = await post(
      fullKey,
      "/emails",
      letter({
        attachments: [
          {
            filename: "a.txt",
            content: "YQ==",
            disposition: "inline",
            content_id: "logo",
          },
        ],
      }),
    );
    expect(sent.status).toBe(200);
    expect(sent.json.id).toEqual(expect.any(String));
    expect(sent.json).not.toHaveProperty("emails");
    const stored = await db.query(
      `select a.filename, a.content_id, a.disposition, a.size_bytes
       from email_attachments a join emails e on e.id = a.email_id where e.id = $1`,
      [sent.json.id],
    );
    expect(stored.rows).toEqual([
      {
        filename: "a.txt",
        content_id: "logo",
        disposition: "inline",
        size_bytes: 1,
      },
    ]);
  });

  it("replays a batch and rejects a batch that includes an attachment", async () => {
    const body = {
      emails: [
        letter({ to: "one@dispatch-fixture.net", subject: "One" }),
        letter({ to: "two@dispatch-fixture.net", subject: "Two" }),
      ],
    };
    const headers = { "idempotency-key": "idem-batch-1" };
    const first = await post(fullKey, "/emails/batch", body, headers);
    const second = await post(fullKey, "/emails/batch", body, headers);
    expect(first.status).toBe(200);
    const ids = first.json.data.map((email: { id: string }) => email.id);
    expect(second.json.data.map((email: { id: string }) => email.id)).toEqual(
      ids,
    );

    const stored = await db.query(
      "select id from emails order by created_at, id",
    );
    expect(stored.rows.map((row) => row.id).sort()).toEqual([...ids].sort());

    const rejected = await post(fullKey, "/emails/batch", {
      emails: [
        letter({ attachments: [{ filename: "a.txt", content: "YQ==" }] }),
      ],
    });
    expect(rejected.status).toBe(400);
  });

  it("returns 403 for an unverified sender", async () => {
    const response = await post(
      fullKey,
      "/emails",
      letter({ from: "hello@not-verified.test" }),
    );
    expect(response.status).toBe(403);
    const stored = await db.query("select id from emails");
    expect(stored.rows).toEqual([]);
  });

  it("returns 422 when to plus cc is more than 50", async () => {
    const response = await post(
      fullKey,
      "/emails",
      letter({
        to: Array.from({ length: 50 }, (_, index) => `to-${index}@dispatch-fixture.net`),
        cc: "cc-0@dispatch-fixture.net",
      }),
    );
    expect(response.status).toBe(422);
    const stored = await db.query("select id from emails");
    expect(stored.rows).toEqual([]);
  });

  it("sends to an unsubscribed contact and accepts a suppressed address", async () => {
    const unsubscribed = await post(fullKey, "/contacts", {
      email: "gone@dispatch-fixture.net",
      unsubscribed: true,
    });
    expect(unsubscribed.status).toBe(200);
    const contactSend = await post(
      fullKey,
      "/emails",
      letter({ to: "gone@dispatch-fixture.net" }),
    );
    expect(contactSend.status).toBe(200);
    const contactRow = await db.query<{ status: string }>(
      "select status from emails where id = $1",
      [contactSend.json.id],
    );
    expect(contactRow.rows[0]?.status).toBe("queued");

    const suppression = await post(fullKey, "/suppressions", {
      email: "manual@dispatch-fixture.net",
      reason: "manual",
    });
    expect(suppression.status).toBe(200);
    const suppressedSend = await post(
      fullKey,
      "/emails",
      letter({ to: "manual@dispatch-fixture.net" }),
    );
    expect(suppressedSend.status).toBe(200);
    const suppressedRow = await db.query<{ status: string }>(
      "select status from emails where id = $1",
      [suppressedSend.json.id],
    );
    expect(suppressedRow.rows[0]?.status).toBe("suppressed");
    const events = await db.query<{ type: string }>(
      "select type from email_events where email_id = $1",
      [suppressedSend.json.id],
    );
    expect(events.rows.map((row) => row.type)).toContain("email.suppressed");
  });

  it("stores the rendered template on the email", async () => {
    const template = {
      name: "Welcome",
      alias: "welcome",
      subject: "Hello {{name}}",
      text: "Hi {{name}}",
      variables: ["name"],
    };
    const created = await post(fullKey, "/templates", {
      ...template,
      publish: true,
    });
    expect(created.status).toBe(200);

    const sent = await post(fullKey, "/emails", {
      from: "hello@dispatch-fixture.net",
      to: "ada@dispatch-fixture.net",
      template: "welcome",
      variables: { name: "Ada" },
    });
    expect(sent.status).toBe(200);

    const rendered = renderTemplate(template, { name: "Ada" });
    const stored = await db.query<{ subject: string; text: string }>(
      "select subject, text from emails where id = $1",
      [sent.json.id],
    );
    expect(stored.rows[0]).toEqual({
      subject: rendered.subject,
      text: rendered.text,
    });
  });

  it("leaves a future send scheduled after one worker tick", async () => {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const sent = await post(
      fullKey,
      "/emails",
      letter({ scheduled_at: scheduledAt }),
    );
    expect(sent.status).toBe(200);
    const storedBefore = await db.query<{ status: string }>(
      "select status from emails where id = $1",
      [sent.json.id],
    );
    expect(storedBefore.rows[0]?.status).toBe("scheduled");

    await tick();

    const stored = await db.query<{ status: string }>(
      "select status from emails where id = $1",
      [sent.json.id],
    );
    expect(stored.rows[0]?.status).toBe("scheduled");
  });
});

describe.skipIf(!live)("contact timeline", () => {
  it("pages thirty runs without skipped or repeated rows, including equal timestamps and case-insensitive email events", async () => {
    const contact = await post(fullKey, "/contacts", {
      email: "ada@dispatch-fixture.net",
    });
    const flow = await post(fullKey, "/automations", {
      name: "History",
      enabled: false,
      steps: [
        { key: "start", type: "trigger", config: { event_name: "history" } },
      ],
      connections: [],
    });
    expect([contact.status, flow.status]).toEqual([200, 200]);
    const tenant = (
      await db.query<{ tenant_id: string }>(
        "select tenant_id from contacts where id = $1",
        [contact.json.id],
      )
    ).rows[0]!.tenant_id;
    await tx(db, async (client) => {
      for (let i = 0; i < 30; i++) {
        const eventId = id("ce");
        await client.query(
          "insert into custom_events (id, tenant_id, request_id, name, email, created_at) values ($1, $2, 'req_history', 'history', 'ADA@DISPATCH-FIXTURE.NET', '2026-10-01')",
          [eventId, tenant],
        );
        await client.query(
          `insert into automation_runs (id, tenant_id, automation_id, event_id, state, created_at, updated_at)
           values ($1, $2, $3, $4, $5, '2026-10-01', '2026-10-02')`,
          [
            id("run"),
            tenant,
            flow.json.id,
            eventId,
            ["done", "failed", "stopped"][i % 3],
          ],
        );
      }
      await client.query(
        "insert into custom_events (id, tenant_id, request_id, name, email) values ($1, $2, 'req_internal', '@contact.updated', 'ada@dispatch-fixture.net')",
        [id("ce"), tenant],
      );
    });
    const sent = await post(
      fullKey,
      "/emails",
      letter({ to: ["ADA@dispatch-fixture.net", "ada@dispatch-fixture.net"] }),
    );
    expect(sent.status).toBe(200);
    await db.query(
      "insert into email_events (id, tenant_id, email_id, type, provider_event_id) values ($1, $2, $3, 'email.delivered', $4)",
      [id("event"), tenant, sent.json.id, id("provider")],
    );
    const rows: Array<{
      id: string;
      type: string;
      label: string;
      created_at: string;
      automation_id: string | null;
      run_id: string | null;
    }> = [];
    let after = "";
    for (let pages = 0; pages < 20; pages++) {
      const page = await call(
        fullKey,
        "GET",
        `/contacts/${contact.json.id}/activity?limit=7${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      expect(page.status).toBe(200);
      rows.push(...page.json.data);
      if (!page.json.has_more) break;
      after = page.json.data.at(-1).id;
    }
    expect(rows).toHaveLength(92);
    expect(new Set(rows.map((row) => row.id)).size).toBe(92);
    expect(rows.filter((row) => row.type === "event.fired")).toHaveLength(30);
    expect(
      rows.filter((row) => row.type === "automation.run.started"),
    ).toHaveLength(30);
    const ended = rows.filter((row) => row.type === "automation.run.completed");
    expect(ended).toHaveLength(30);
    expect(new Set(ended.map((row) => row.label))).toEqual(
      new Set(["done", "failed", "stopped"]),
    );
    expect(
      ended.every(
        (row) =>
          row.automation_id === flow.json.id &&
          row.id === `${row.run_id}:completed`,
      ),
    ).toBe(true);
    expect(rows.filter((row) => row.type === "email.delivered")).toHaveLength(
      1,
    );
    expect(rows.some((row) => row.label === "@contact.updated")).toBe(false);
    for (let i = 1; i < rows.length; i++)
      expect(
        new Date(rows[i - 1]!.created_at).getTime(),
      ).toBeGreaterThanOrEqual(new Date(rows[i]!.created_at).getTime());
  });
});

async function audience() {
  const topic = await post(fullKey, "/topics", {
    name: "News",
    default_subscription: "opt_in",
  });
  const first = await post(fullKey, "/contacts", {
    email: "ada@dispatch-fixture.net",
    first_name: "Ada",
  });
  const second = await post(fullKey, "/contacts", {
    email: "bob@dispatch-fixture.net",
    first_name: "Bob",
  });
  expect([topic.status, first.status, second.status]).toEqual([
    200, 200, 200,
  ]);
  return {
    topic: topic.json.id as string,
    first: first.json.id as string,
    second: second.json.id as string,
  };
}

async function stored(emailId: string) {
  const result = await db.query<{
    headers: Record<string, string>;
    html: string;
    html_tracked: string;
    text: string;
    status: string;
  }>(
    "select headers, html, html_tracked, text, status from emails where id = $1",
    [emailId],
  );
  return result.rows[0]!;
}

function link(headers: Record<string, string>) {
  return new URL(headers["List-Unsubscribe"]!.slice(1, -1)).pathname;
}

describe.skipIf(!live)("marketing", () => {
  it.each(["topic", "global", "deleted_topic"])(
    "isolates a split recipient's %s unsubscribe and replays the whole request",
    async (mode) => {
      const contacts = await audience();
      const body = letter({
        to: ["ada@dispatch-fixture.net", "bob@dispatch-fixture.net"],
        cc: ["ADA@dispatch-fixture.net"],
        topic_id: contacts.topic,
        html: '<a href="{{UNSUBSCRIBE_URL}}">Leave</a><a href="https://dispatch-fixture.net/read">Read</a><p>{{name}}</p>',
        text: "{{{DISPATCH_UNSUBSCRIBE_URL}}}",
        headers: {
          "list-unsubscribe": "caller",
          "LIST-UNSUBSCRIBE-POST": "caller",
        },
      });
      const sent = await post(fullKey, "/emails", body, {
        "idempotency-key": "marketing-split",
      });
      expect(sent.status).toBe(200);
      expect(sent.json.emails).toHaveLength(2);
      expect(sent.json.id).toBe(sent.json.emails[0].id);
      const replay = await post(fullKey, "/emails", body, {
        "idempotency-key": "marketing-split",
      });
      expect(replay.json.emails).toEqual(sent.json.emails);
      expect((await db.query("select id from emails")).rows).toHaveLength(2);
      const first = await stored(sent.json.emails[0].id);
      const second = await stored(sent.json.emails[1].id);
      expect(link(first.headers)).not.toBe(link(second.headers));
      expect(first.headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );
      expect(first.headers).not.toHaveProperty("list-unsubscribe");
      expect(first.html).toContain("/unsubscribe?token=");
      expect(first.html).toContain("{{name}}");
      expect(first.html_tracked).toContain("/click/");
      expect(first.text).toContain("/unsubscribe?token=");
      const recipients = await db.query(
        "select email_id, email, kind from email_recipients order by email",
      );
      expect(recipients.rows).toEqual([
        {
          email_id: sent.json.emails[0].id,
          email: "ada@dispatch-fixture.net",
          kind: "to",
        },
        {
          email_id: sent.json.emails[1].id,
          email: "bob@dispatch-fixture.net",
          kind: "to",
        },
      ]);
      const page = await app.inject({
        method: "GET",
        url: link(first.headers),
      });
      expect(page.statusCode).toBe(200);
      expect(
        page
          .json()
          .topics.some((row: { id: string }) => row.id === contacts.topic),
      ).toBe(true);
      if (mode === "deleted_topic")
        expect(
          (await call(fullKey, "DELETE", `/topics/${contacts.topic}`)).status,
        ).toBe(200);
      const action =
        mode === "global"
          ? { unsubscribe_all: true }
          : { "List-Unsubscribe": "One-Click" };
      const left = await Promise.all([
        post("", link(first.headers), action),
        post("", link(first.headers), action),
      ]);
      expect(left.map((row) => row.status)).toEqual([200, 200]);
      const states = await db.query<{
        email: string;
        unsubscribed_at: Date | null;
        status: string;
      }>(
        `select c.email, c.unsubscribed_at, coalesce(s.status, 'subscribed') as status
       from contacts c left join topic_subscriptions s on s.contact_id = c.id and s.topic_id = $1
       order by c.email`,
        [contacts.topic],
      );
      expect(states.rows[1]).toEqual({
        email: "bob@dispatch-fixture.net",
        unsubscribed_at: null,
        status: "subscribed",
      });
      if (mode === "topic")
        expect(states.rows[0]).toEqual({
          email: "ada@dispatch-fixture.net",
          unsubscribed_at: null,
          status: "unsubscribed",
        });
      else expect(states.rows[0]?.unsubscribed_at).not.toBeNull();
      const events = await db.query(
        "select email_id from email_events where type = 'email.unsubscribed'",
      );
      expect(events.rows).toEqual([{ email_id: sent.json.emails[0].id }]);
    },
  );

  it("protects scheduled updates and cancels after a late topic opt-out without sending", async () => {
    const contacts = await audience();
    const sent = await post(
      fullKey,
      "/emails",
      letter({
        to: "ada@dispatch-fixture.net",
        topic_id: contacts.topic,
        text: "{{UNSUBSCRIBE_URL}}",
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    expect(sent.status).toBe(200);
    expect(sent.json).not.toHaveProperty("emails");
    const updated = await call(fullKey, "PATCH", `/emails/${sent.json.id}`, {
      text: "{{{RESEND_UNSUBSCRIBE_URL}}}",
      headers: { "LIST-UNSUBSCRIBE": "caller" },
    });
    expect(updated.status).toBe(200);
    const email = await stored(sent.json.id);
    expect(email.text).toContain("/unsubscribe?token=");
    expect(email.headers).not.toHaveProperty("LIST-UNSUBSCRIBE");
    expect(
      (await post("", link(email.headers), { "List-Unsubscribe": "One-Click" }))
        .status,
    ).toBe(200);
    await db.query(
      "update emails set scheduled_at = now() - interval '1 second' where id = $1",
      [sent.json.id],
    );
    await db.query(
      "update send_jobs set available_at = now() - interval '1 second' where email_id = $1",
      [sent.json.id],
    );
    await tick();
    expect((await stored(sent.json.id)).status).toBe("cancelled");
    const job = await db.query(
      "select state, error from send_jobs where email_id = $1",
      [sent.json.id],
    );
    expect(job.rows[0]).toEqual({ state: "done", error: "opted_out" });
    const events = await db.query<{
      type: string;
      data: { failed?: { reason: string } };
    }>("select type, data from email_events where email_id = $1", [
      sent.json.id,
    ]);
    expect(events.rows.some((row) => row.type === "email.sent")).toBe(false);
    expect(
      events.rows.find((row) => row.type === "email.failed")?.data.failed
        ?.reason,
    ).toBe("opted_out");
  });

  it("creates an opted-out contact only when an unknown address uses its link, without reviving deleted rows", async () => {
    const contacts = await audience();
    const sent = await post(
      fullKey,
      "/emails",
      letter({ to: "new@dispatch-fixture.net", topic_id: contacts.topic }),
    );
    expect(sent.status).toBe(200);
    expect(
      (
        await db.query(
          "select id from contacts where email = 'new@dispatch-fixture.net'",
        )
      ).rows,
    ).toHaveLength(0);
    await post("", link((await stored(sent.json.id)).headers), {
      "List-Unsubscribe": "One-Click",
    });
    const opted = await db.query(
      "select c.deleted_at, s.status from contacts c join topic_subscriptions s on s.contact_id = c.id where c.email = 'new@dispatch-fixture.net'",
    );
    expect(opted.rows).toEqual([{ deleted_at: null, status: "unsubscribed" }]);
    const deleted = await post(
      fullKey,
      "/emails",
      letter({ to: "gone@dispatch-fixture.net", topic_id: contacts.topic }),
    );
    const gone = await post(fullKey, "/contacts", {
      email: "gone@dispatch-fixture.net",
    });
    await call(fullKey, "DELETE", `/contacts/${gone.json.id}`);
    expect(
      (
        await post("", link((await stored(deleted.json.id)).headers), {
          unsubscribe_all: true,
        })
      ).status,
    ).toBe(200);
    const row = await db.query(
      "select deleted_at, unsubscribed_at from contacts where id = $1",
      [gone.json.id],
    );
    expect(row.rows[0].deleted_at).not.toBeNull();
    expect(row.rows[0].unsubscribed_at).not.toBeNull();
  });

  it("isolates each split batch item and preserves opt-in-topic behavior for new addresses", async () => {
    const contacts = await audience();
    const batch = await post(
      fullKey,
      "/emails/batch",
      [
        letter({
          topic_id: contacts.topic,
          to: ["ada@dispatch-fixture.net", "bob@dispatch-fixture.net"],
        }),
        letter({ to: ["one@dispatch-fixture.net", "two@dispatch-fixture.net"] }),
      ],
      { "idempotency-key": "marketing-batch" },
    );
    expect(batch.status).toBe(200);
    expect(batch.json.data).toHaveLength(2);
    expect(batch.json.data[0].emails).toHaveLength(2);
    expect(batch.json.data[1]).not.toHaveProperty("emails");
    expect((await db.query("select id from emails")).rows).toHaveLength(3);
    const topic = await post(fullKey, "/topics", {
      name: "Opt-in only",
      default_subscription: "opt_out",
    });
    const sent = await post(
      fullKey,
      "/emails",
      letter({ topic_id: topic.json.id, to: "unknown@dispatch-fixture.net" }),
    );
    expect(sent.status).toBe(200);
    expect((await stored(sent.json.id)).status).toBe("queued");
    expect(
      (
        await db.query(
          "select id from contacts where email = 'unknown@dispatch-fixture.net'",
        )
      ).rows,
    ).toHaveLength(0);
  });

  it("aggregates automation steps from stored attribution and backfills legacy messages only once", async () => {
    const template = await post(fullKey, "/templates", {
      name: "Metrics",
      alias: "metrics",
      subject: "Metrics",
      html: "<p>Hello</p>",
      publish: true,
    });
    expect(template.status).toBe(200);
    const flow = await post(fullKey, "/automations", {
      name: "Metrics",
      enabled: true,
      steps: [
        { key: "start", type: "trigger", config: { event_name: "measure" } },
        {
          key: "one",
          type: "send_email",
          config: { from: "hello@dispatch-fixture.net", template: "metrics" },
        },
        {
          key: "two",
          type: "send_email",
          config: { from: "hello@dispatch-fixture.net", template: "metrics" },
        },
      ],
      connections: [
        { from: "start", to: "one", type: "default" },
        { from: "one", to: "two", type: "default" },
      ],
    });
    expect(flow.status).toBe(200);
    expect(
      (
        await post(fullKey, "/events/send", {
          event: "measure",
          email: "ada@dispatch-fixture.net",
        })
      ).status,
    ).toBe(202);
    await tick();
    await tick();
    const messages = await db.query<{
      id: string;
      automation_step: string;
      html_tracked: string;
    }>(
      "select id, automation_step, html_tracked from emails where automation_id = $1 order by automation_step",
      [flow.json.id],
    );
    expect(messages.rows.map((row) => row.automation_step)).toEqual([
      "one",
      "two",
    ]);
    const pixel = new URL(
      messages.rows[0]!.html_tracked.match(/src="([^"]+\/open\/[^"]+)"/)![1]!,
    );
    expect(
      (await app.inject({ method: "GET", url: pixel.pathname })).statusCode,
    ).toBe(200);
    expect(
      (
        await db.query(
          "select email_id from email_events where type = 'email.opened'",
        )
      ).rows,
    ).toEqual([{ email_id: messages.rows[0]!.id }]);
    const query = new URLSearchParams({
      dimensions: "step",
      automation_id: flow.json.id,
      metrics: "sent,delivered,opened,open_rate",
      end_date: new Date(Date.now() + 1000).toISOString(),
    });
    const metrics = await call(fullKey, "GET", `/emails/metrics?${query}`);
    expect(metrics.status).toBe(200);
    const rows = metrics.json.data.sort(
      (a: { automation_step: string }, b: { automation_step: string }) =>
        a.automation_step.localeCompare(b.automation_step),
    );
    expect(rows).toEqual([
      {
        automation_id: flow.json.id,
        automation_step: "one",
        sent: 1,
        delivered: 1,
        opened: 1,
        open_rate: 100,
      },
      {
        automation_id: flow.json.id,
        automation_step: "two",
        sent: 1,
        delivered: 1,
        opened: 0,
        open_rate: 0,
      },
    ]);
    expect(
      (await call(fullKey, "GET", "/emails/metrics?dimensions=step")).status,
    ).toBe(422);
    const tagged = await post(
      fullKey,
      "/emails",
      letter({ tags: { automation_id: flow.json.id } }),
    );
    expect(tagged.status).toBe(200);
    await db.query(
      "update emails set created_at = '2026-10-01', automation_id = null, automation_step = null where id = $1",
      [messages.rows[0]!.id],
    );
    await db.query(
      "update emails set created_at = '2026-10-01' where id = $1",
      [tagged.json.id],
    );
    await db.query(schema);
    expect(
      (
        await db.query(
          "select automation_id, automation_step from emails where id = $1",
          [messages.rows[0]!.id],
        )
      ).rows[0],
    ).toEqual({
      automation_id: flow.json.id,
      automation_step: null,
    });
    expect(
      (
        await db.query("select automation_id from emails where id = $1", [
          tagged.json.id,
        ])
      ).rows[0].automation_id,
    ).toBeNull();
    const before = await db.query<{ version: string }>(
      "select xmin::text as version from emails where id = $1",
      [messages.rows[0]!.id],
    );
    await db.query(schema);
    const after = await db.query<{ version: string }>(
      "select xmin::text as version from emails where id = $1",
      [messages.rows[0]!.id],
    );
    expect(after.rows[0]?.version).toBe(before.rows[0]?.version);
  });

  it("renders automation recipient context and skips a later marketing step after one-click", async () => {
    const contacts = await audience();
    const template = await post(fullKey, "/templates", {
      name: "Lifecycle",
      alias: "lifecycle",
      subject: "Hi {{{FIRST_NAME}}}",
      text: "Hello {{{FIRST_NAME}}}. {{{UNSUBSCRIBE_URL}}}",
      publish: true,
    });
    expect(template.status).toBe(200);
    const receipt = await post(fullKey, "/templates", {
      name: "Receipt",
      alias: "receipt",
      subject: "Receipt",
      text: "Receipt for {{{FIRST_NAME}}}",
      publish: true,
    });
    expect(receipt.status).toBe(200);
    const automation = await post(fullKey, "/automations", {
      name: "Lifecycle",
      enabled: true,
      steps: [
        { key: "start", type: "trigger", config: { event_name: "joined" } },
        {
          key: "first",
          type: "send_email",
          config: {
            from: "hello@dispatch-fixture.net",
            template: "lifecycle",
            topic_id: contacts.topic,
          },
        },
        { key: "wait", type: "delay", config: { duration: "1 hour" } },
        {
          key: "second",
          type: "send_email",
          config: {
            from: "hello@dispatch-fixture.net",
            template: "lifecycle",
            topic_id: contacts.topic,
          },
        },
        {
          key: "receipt",
          type: "send_email",
          config: { from: "hello@dispatch-fixture.net", template: "receipt" },
        },
      ],
      connections: [
        { from: "start", to: "first", type: "default" },
        { from: "first", to: "wait", type: "default" },
        { from: "wait", to: "second", type: "default" },
        { from: "second", to: "receipt", type: "default" },
      ],
    });
    expect(automation.status).toBe(200);
    expect(
      (
        await post(fullKey, "/events/send", {
          event: "joined",
          email: "ada@dispatch-fixture.net",
          payload: {
            FIRST_NAME: "Mallory",
            UNSUBSCRIBE_URL: "https://evil.example",
          },
        })
      ).status,
    ).toBe(202);
    await tick();
    await tick();
    const emails = await db.query<{ id: string }>(
      "select id from emails order by created_at",
    );
    expect(emails.rows).toHaveLength(1);
    const email = await stored(emails.rows[0]!.id);
    expect(email.text).toContain("Hello Ada");
    expect(email.text).not.toContain("evil.example");
    expect(
      (await post("", link(email.headers), { "List-Unsubscribe": "One-Click" }))
        .status,
    ).toBe(200);
    await db.query(
      "update automation_runs set resume_at = now() - interval '1 second' where state = 'waiting'",
    );
    await tick();
    const steps = await db.query(
      "select state, data from automation_steps where step_key = 'second'",
    );
    expect(steps.rows[0]).toMatchObject({ data: { skipped: "opted_out" } });
    expect((await stored(steps.rows[0].data.email_id)).status).toBe("failed");
    expect(
      (
        await db.query("select id from send_jobs where email_id = $1", [
          steps.rows[0].data.email_id,
        ])
      ).rows,
    ).toHaveLength(0);
    const transactional = await db.query(
      "select text, headers from emails where text = 'Receipt for Ada'",
    );
    expect(transactional.rows).toEqual([
      { text: "Receipt for Ada", headers: {} },
    ]);
  });
});

describe.skipIf(!live)("delivery", () => {
  it("delivers one signed unsubscribe webhook and one event for each automation transition", async () => {
    const received: Array<{
      url: string;
      body: string;
      id: string;
      timestamp: string;
      signature: string;
    }> = [];
    const server = createServer((request, response) =>
      recordWebhook(request, response, received),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("webhook server did not bind");
    try {
      const endpoint = await post(fullKey, "/webhooks", {
        url: `http://127.0.0.1:${address.port}/ok`,
        events: [
          "email.unsubscribed",
          "automation.run.started",
          "automation.run.completed",
          "automation.run.failed",
        ],
      });
      expect(endpoint.status).toBe(200);
      const topic = await post(fullKey, "/topics", {
        name: "News",
        default_subscription: "opt_in",
      });
      const sent = await post(
        fullKey,
        "/emails",
        letter({ topic_id: topic.json.id }),
      );
      expect(sent.status).toBe(200);
      const email = (
        await db.query<{ headers: Record<string, string> }>(
          "select headers from emails where id = $1",
          [sent.json.id],
        )
      ).rows[0]!;
      const unsubscribe = new URL(
        email.headers["List-Unsubscribe"]!.slice(1, -1),
      ).pathname;
      expect(
        (await post("", unsubscribe, { "List-Unsubscribe": "One-Click" }))
          .status,
      ).toBe(200);
      expect(
        (await post("", unsubscribe, { "List-Unsubscribe": "One-Click" }))
          .status,
      ).toBe(200);
      const flow = await post(fullKey, "/automations", {
        name: "Complete",
        enabled: true,
        steps: [
          { key: "start", type: "trigger", config: { event_name: "complete" } },
        ],
        connections: [],
      });
      const failed = await post(fullKey, "/automations", {
        name: "Fail",
        enabled: true,
        steps: [
          { key: "start", type: "trigger", config: { event_name: "fail" } },
          {
            key: "send",
            type: "send_email",
            config: { from: "hello@dispatch-fixture.net", template: "missing-template" },
          },
        ],
        connections: [{ from: "start", to: "send", type: "default" }],
      });
      const cancelled = await post(fullKey, "/automations", {
        name: "Cancel",
        enabled: true,
        steps: [
          { key: "start", type: "trigger", config: { event_name: "cancel" } },
          { key: "wait", type: "delay", config: { duration: "1 hour" } },
        ],
        connections: [{ from: "start", to: "wait", type: "default" }],
      });
      expect([flow.status, failed.status, cancelled.status]).toEqual([
        200, 200, 200,
      ]);
      await post(fullKey, "/events/send", {
        event: "complete",
        email: "ada@dispatch-fixture.net",
      });
      await post(fullKey, "/events/send", {
        event: "fail",
        email: "ada@dispatch-fixture.net",
      });
      await post(fullKey, "/events/send", {
        event: "cancel",
        email: "ada@dispatch-fixture.net",
      });
      await tick();
      expect(
        (await post(fullKey, `/automations/${cancelled.json.id}/stop`, {}))
          .status,
      ).toBe(200);
      await tick();
      await tick();
      const bodies = received.map((row) => JSON.parse(row.body));
      expect(
        bodies.filter((body) => body.type === "email.unsubscribed"),
      ).toHaveLength(1);
      expect(
        bodies.filter((body) => body.type === "automation.run.started"),
      ).toHaveLength(3);
      expect(
        bodies.filter((body) => body.type === "automation.run.completed"),
      ).toHaveLength(2);
      expect(
        bodies.filter((body) => body.type === "automation.run.failed"),
      ).toHaveLength(1);
      for (const row of received)
        expect(
          verify(
            row.body,
            endpoint.json.signing_secret,
            row.id,
            row.timestamp,
            row.signature,
          ),
        ).toBe(true);
      const ended = bodies.find(
        (body) =>
          body.type === "automation.run.completed" &&
          body.data.automation_id === flow.json.id,
      );
      expect(ended.data).toMatchObject({
        automation_id: flow.json.id,
        contact_id: expect.any(String),
        state: "done",
      });
      expect(ended.data.run_id).toMatch(/^run_/);
      expect(
        bodies.find(
          (body) =>
            body.type === "automation.run.completed" &&
            body.data.automation_id === cancelled.json.id,
        )?.data.state,
      ).toBe("stopped");
      const before = received.length;
      await tick();
      expect(received).toHaveLength(before);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["one_click", "preferences", "global", "deleted_topic", "broadcast", "legacy_broadcast"])(
    "delivers only to subscribed endpoints once for the %s unsubscribe path",
    async (mode) => {
      const contacts = await audience();
      const received: Parameters<typeof recordWebhook>[2] = [];
      const server = createServer((request, response) => recordWebhook(request, response, received));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("webhook server did not bind");
      try {
        const endpoint = await post(fullKey, "/webhooks", {
          url: `http://127.0.0.1:${address.port}/ok`, events: ["email.unsubscribed"],
        });
        const unrelated = await post(fullKey, "/webhooks", {
          url: `http://127.0.0.1:${address.port}/unrelated`, events: ["automation.run.started"],
        });
        const disabled = await post(fullKey, "/webhooks", {
          url: `http://127.0.0.1:${address.port}/disabled`, events: ["email.unsubscribed"], enabled: false,
        });
        const otherKey = await seedTenant();
        const other = await post(otherKey, "/webhooks", {
          url: `http://127.0.0.1:${address.port}/other`, events: ["email.unsubscribed"],
        });
        expect([endpoint.status, unrelated.status, disabled.status, other.status]).toEqual([200, 200, 200, 200]);
        const sent = await post(fullKey, "/emails", letter({ to: "ada@dispatch-fixture.net", topic_id: contacts.topic }));
        expect(sent.status).toBe(200);
        let path = link((await stored(sent.json.id)).headers);
        const tenant = (await db.query<{ tenant_id: string }>("select tenant_id from contacts where id = $1", [contacts.first])).rows[0]!.tenant_id;
        if (mode.includes("broadcast")) {
          const broadcastId = id("broadcast");
          await db.query(
            "insert into broadcasts (id, tenant_id, name, from_email, topic_id) values ($1, $2, 'History', 'hello@dispatch-fixture.net', $3)",
            [broadcastId, tenant, contacts.topic],
          );
          await db.query(
            "insert into broadcast_recipients (id, tenant_id, broadcast_id, contact_id, email_id, email) values ($1, $2, $3, $4, $5, 'ada@dispatch-fixture.net')",
            [id("br"), tenant, broadcastId, contacts.first, sent.json.id],
          );
          const token = unsubscribeToken({
            tenant_id: tenant, contact_id: contacts.first, broadcast_id: broadcastId,
            ...(mode === "broadcast" ? { email_id: sent.json.id } : {}),
          }, process.env.APP_SECRET ?? "dev-secret-change-before-deploy");
          path = `/unsubscribe/${encodeURIComponent(token)}`;
        }
        if (mode === "deleted_topic") {
          expect((await call(fullKey, "DELETE", `/topics/${contacts.topic}`)).status).toBe(200);
        }
        if (mode === "preferences") {
          // A last opt-in must neither count as an unsubscribe nor queue a delivery.
          expect((await post("", path, { topics: [
            { id: contacts.topic, subscription: "opt_out" },
            { id: contacts.topic, subscription: "opt_in" },
          ] })).status).toBe(200);
          expect((await db.query("select id from email_events where type = 'email.unsubscribed'")).rows).toHaveLength(0);
          expect((await db.query("select id from webhook_attempts")).rows).toHaveLength(0);
          expect((await db.query("select status from topic_subscriptions where contact_id = $1", [contacts.first])).rows).toEqual([{ status: "subscribed" }]);
        }
        const action = mode === "global" ? { unsubscribe_all: true } : mode === "preferences" ? { topics: [
          { id: contacts.topic, subscription: "opt_in" },
          { id: contacts.topic, subscription: "opt_out" },
        ] } : { "List-Unsubscribe": "One-Click" };
        expect((await Promise.all([post("", path, action), post("", path, action)])).map((row) => row.status)).toEqual([200, 200]);
        const attempts = await db.query(
          `select a.webhook_id, e.email_id from webhook_attempts a join email_events e on e.id = a.event_id
           where e.type = 'email.unsubscribed'`,
        );
        expect(attempts.rows).toEqual([{ webhook_id: endpoint.json.id, email_id: sent.json.id }]);
        if (mode.includes("broadcast")) {
          expect((await db.query("select unsubscribed_at from broadcast_recipients where email_id = $1", [sent.json.id])).rows[0]!.unsubscribed_at).not.toBeNull();
        }
        await tick();
        await tick();
        expect(received).toHaveLength(1);
        expect(received[0]!.url).toBe("/ok");
        const delivery = received[0]!;
        expect(JSON.parse(delivery.body)).toMatchObject({ type: "email.unsubscribed", data: { email_id: sent.json.id } });
        expect(verify(delivery.body, endpoint.json.signing_secret, delivery.id, delivery.timestamp, delivery.signature)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.each(["delay", "event", "timeout", "recovery"])(
    "does not repeat lifecycle transitions after %s resumption and retries",
    async (mode) => {
      const endpoint = await post(fullKey, "/webhooks", {
        url: "http://127.0.0.1:1/unused",
        events: ["automation.run.started", "automation.run.completed", "automation.run.failed"],
      });
      const flow = await post(fullKey, "/automations", {
        name: "Resume", enabled: true,
        steps: [
          { key: "start", type: "trigger", config: { event_name: "resume" } },
          mode === "delay"
            ? { key: "wait", type: "delay", config: { duration: "1 hour" } }
            : { key: "wait", type: "wait_for_event", config: { event_name: "wake", timeout: "1 hour" } },
        ],
        connections: [{ from: "start", to: "wait", type: "default" }],
      });
      expect([endpoint.status, flow.status]).toEqual([200, 200]);
      await post(fullKey, "/events/send", { event: "resume", email: "ada@dispatch-fixture.net" });
      // Execute directly so webhook attempts stay queued, without network retries.
      const run = (await db.query<{ id: string; tenant_id: string }>("select id, tenant_id from automation_runs")).rows[0]!;
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect((await db.query("select state from automation_runs where id = $1", [run.id])).rows).toEqual([{ state: "waiting" }]);
      expect((await db.query("select id from email_events where type = 'automation.run.started'")).rows).toHaveLength(1);
      expect((await db.query("select id from email_events where type = 'automation.run.completed'")).rows).toHaveLength(0);
      if (mode === "event") {
        await post(fullKey, "/events/send", { event: "wake", email: "ADA@dispatch-fixture.net" });
      } else {
        await db.query(
          `update automation_runs set state = $2, resume_data = $3::jsonb, updated_at = now() - interval '6 minutes'
           where id = $1`,
          [run.id, mode === "recovery" ? "running" : "ready", JSON.stringify({ timed_out: mode !== "delay" })],
        );
      }
      await executeAutomationRun(db, run.tenant_id, run.id);
      await executeAutomationRun(db, run.tenant_id, run.id);
      const events = await db.query<{ type: string; data: Record<string, unknown> }>(
        "select type, data from email_events where type like 'automation.run.%' order by type",
      );
      expect(events.rows.map((row) => row.type)).toEqual(["automation.run.completed", "automation.run.started"]);
      for (const event of events.rows) expect(event.data).toMatchObject({
        automation_id: flow.json.id, run_id: run.id, contact_id: expect.any(String),
        state: event.type === "automation.run.started" ? "ready" : "done",
      });
      expect((await db.query("select webhook_id from webhook_attempts")).rows).toEqual([
        { webhook_id: endpoint.json.id }, { webhook_id: endpoint.json.id },
      ]);
      expect((await db.query("select state from automation_steps where run_id = $1", [run.id])).rows).toEqual([{ state: "done" }]);
    },
  );

  it("rolls back enrollment and stop together with failed event insertion or fanout", async () => {
    const endpoint = await post(fullKey, "/webhooks", {
      url: "http://127.0.0.1:1/unused", events: ["automation.run.started", "automation.run.completed"],
    });
    const flow = await post(fullKey, "/automations", {
      name: "Atomic", enabled: true,
      steps: [{ key: "start", type: "trigger", config: { event_name: "atomic" } }],
      connections: [],
    });
    expect([endpoint.status, flow.status]).toEqual([200, 200]);
    try {
      await db.query(`
        create function lifecycle_reject_start() returns trigger language plpgsql as $$
          begin if new.type = 'automation.run.started' then raise exception 'synthetic start failure'; end if; return new; end $$;
        create trigger lifecycle_reject_start before insert on email_events for each row execute function lifecycle_reject_start();
      `);
      expect((await post(fullKey, "/events/send", { event: "atomic", email: "ada@dispatch-fixture.net" })).status).toBe(500);
      expect((await db.query("select id from contacts")).rows).toHaveLength(0);
      expect((await db.query("select id from custom_events")).rows).toHaveLength(0);
      expect((await db.query("select id from automation_runs")).rows).toHaveLength(0);
      expect((await db.query("select id from webhook_attempts")).rows).toHaveLength(0);
      await db.query("drop trigger lifecycle_reject_start on email_events; drop function lifecycle_reject_start()");
      expect((await post(fullKey, "/events/send", { event: "atomic", email: "ada@dispatch-fixture.net" })).status).toBe(202);
      await db.query(`
        create function lifecycle_reject_terminal() returns trigger language plpgsql as $$
          begin if exists (select 1 from email_events where id = new.event_id and type = 'automation.run.completed')
            then raise exception 'synthetic terminal fanout failure'; end if; return new; end $$;
        create trigger lifecycle_reject_terminal before insert on webhook_attempts for each row execute function lifecycle_reject_terminal();
      `);
      expect((await post(fullKey, `/automations/${flow.json.id}/stop`, {})).status).toBe(500);
      expect((await db.query("select enabled from automations where id = $1", [flow.json.id])).rows).toEqual([{ enabled: true }]);
      expect((await db.query("select state from automation_runs")).rows).toEqual([{ state: "ready" }]);
      expect((await db.query("select id from email_events where type = 'automation.run.completed'")).rows).toHaveLength(0);
      await db.query("drop trigger lifecycle_reject_terminal on webhook_attempts; drop function lifecycle_reject_terminal()");
      expect((await post(fullKey, `/automations/${flow.json.id}/stop`, {})).status).toBe(200);
      expect((await post(fullKey, `/automations/${flow.json.id}/stop`, {})).status).toBe(200);
      expect((await db.query("select state from automation_runs")).rows).toEqual([{ state: "stopped" }]);
      expect((await db.query("select id from email_events where type = 'automation.run.completed'")).rows).toHaveLength(1);
      expect((await db.query("select id from webhook_attempts")).rows).toHaveLength(2);
    } finally {
      await db.query(`
        drop trigger if exists lifecycle_reject_start on email_events;
        drop function if exists lifecycle_reject_start();
        drop trigger if exists lifecycle_reject_terminal on webhook_attempts;
        drop function if exists lifecycle_reject_terminal();
      `);
    }
  });

  it("serializes a stop against completion without two terminal events", async () => {
    const flow = await post(fullKey, "/automations", {
      name: "Race", enabled: true,
      steps: [{ key: "start", type: "trigger", config: { event_name: "race" } }],
      connections: [],
    });
    expect(flow.status).toBe(200);
    await post(fullKey, "/events/send", { event: "race", email: "ada@dispatch-fixture.net" });
    const run = (await db.query<{ id: string; tenant_id: string }>("select id, tenant_id from automation_runs")).rows[0]!;
    const [, stop] = await Promise.all([
      executeAutomationRun(db, run.tenant_id, run.id),
      post(fullKey, `/automations/${flow.json.id}/stop`, {}),
    ]);
    expect(stop.status).toBe(200);
    const state = (await db.query<{ state: string }>("select state from automation_runs where id = $1", [run.id])).rows[0]!.state;
    expect(["done", "stopped"]).toContain(state);
    expect((await db.query("select data from email_events where type = 'automation.run.completed'")).rows).toEqual([{
      data: { automation_id: flow.json.id, run_id: run.id, contact_id: expect.any(String), state, exit_reason: state === "done" ? "completed" : "stopped" },
    }]);
    await executeAutomationRun(db, run.tenant_id, run.id);
    expect((await db.query("select id from email_events where type like 'automation.run.%'")).rows).toHaveLength(2);
  });

  it("writes a bounce event and a suppression row from one worker tick", async () => {
    const sent = await post(
      fullKey,
      "/emails",
      letter({ to: "bounce@dispatch-fixture.net" }),
    );
    expect(sent.status).toBe(200);

    await tick();

    const events = await db.query<{ type: string }>(
      "select type from email_events where email_id = $1 order by created_at",
      [sent.json.id],
    );
    expect(events.rows.map((row) => row.type)).toContain("email.bounced");
    const suppressed = await db.query(
      "select email, reason from suppressions where removed_at is null",
    );
    expect(suppressed.rows).toEqual([
      { email: "bounce@dispatch-fixture.net", reason: "email.bounced" },
    ]);
  });

  it("writes open and click events when the tracking urls are fetched", async () => {
    const sent = await post(
      fullKey,
      "/emails",
      letter({
        html: `<p><a href="https://dispatch-fixture.net/docs">Docs</a></p>`,
        text: undefined,
      }),
    );
    expect(sent.status).toBe(200);

    const stored = await db.query<{
      html: string;
      html_tracked: string | null;
    }>("select html, html_tracked from emails where id = $1", [sent.json.id]);
    expect(stored.rows[0]?.html ?? "").not.toContain("/click/");
    const html = stored.rows[0]?.html_tracked ?? "";
    const click = new URL(
      html.match(/href="(https?:\/\/[^"]+\/click\/[^"]+)"/)?.[1] ?? "",
    );
    const open = new URL(
      html.match(/src="(https?:\/\/[^"]+\/open\/[^"]+)"/)?.[1] ?? "",
    );

    const opened = await app.inject({
      method: "GET",
      url: `${open.pathname}${open.search}`,
    });
    const clicked = await app.inject({
      method: "GET",
      url: `${click.pathname}${click.search}`,
    });
    expect(opened.statusCode).toBe(200);
    expect(clicked.statusCode).toBe(302);

    const events = await db.query<{ type: string }>(
      "select type from email_events where email_id = $1 order by created_at",
      [sent.json.id],
    );
    expect(events.rows.map((row) => row.type)).toEqual(
      expect.arrayContaining(["email.opened", "email.clicked"]),
    );
  });

  it("verifies a delivered webhook with sign and queues a second attempt after a refusal", async () => {
    const received: Array<{
      url: string;
      body: string;
      id: string;
      timestamp: string;
      signature: string;
    }> = [];
    const server = createServer((request, response) =>
      recordWebhook(request, response, received),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("webhook server did not bind");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const accepted = await post(fullKey, "/webhooks", {
        url: `${base}/ok`,
        events: ["email.sent"],
      });
      const refused = await post(fullKey, "/webhooks", {
        url: `${base}/refuse`,
        events: ["email.sent"],
      });
      expect(accepted.status).toBe(200);
      expect(refused.status).toBe(200);

      const sent = await post(
        fullKey,
        "/emails",
        letter({ to: "webhook@dispatch-fixture.net" }),
      );
      expect(sent.status).toBe(200);
      await tick();

      const delivery = received.find((call) => call.url === "/ok");
      expect(delivery).toBeTruthy();
      const signed = sign(
        delivery!.body,
        accepted.json.signing_secret,
        delivery!.id,
        Number(delivery!.timestamp),
      );
      expect(signed.signature).toBe(delivery!.signature);
      expect(
        verify(
          delivery!.body,
          accepted.json.signing_secret,
          delivery!.id,
          delivery!.timestamp,
          delivery!.signature,
        ),
      ).toBe(true);

      const attempts = await db.query<{ attempt: number; state: string }>(
        "select attempt, state from webhook_attempts where webhook_id = $1 order by attempt",
        [refused.json.id],
      );
      expect(attempts.rows).toEqual([
        { attempt: 1, state: "failed" },
        { attempt: 2, state: "queued" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe.skipIf(!live)("typed properties and rules", () => {
  it("wakes a date-filtered event wait using the stored received time, not payload metadata", async () => {
    for (const name of ["typed.wait.start", "typed.wait.done"]) expect((await post(fullKey, "/events", { name })).status).toBe(200);
    const flow = await post(fullKey, "/automations", { name: "Typed wait", enabled: true, steps: [
      { key: "start", type: "trigger", config: { event_name: "typed.wait.start" } },
      { key: "wait", type: "wait_for_event", config: { event_name: "typed.wait.done", filter_rule: {
        type: "rule", field: "event.received_at", operator: "within", value: "1 day",
      } } },
    ], connections: [{ from: "start", to: "wait" }] });
    expect(flow.status).toBe(200);
    expect((await post(fullKey, "/events/send", { event: "typed.wait.start", email: "wait@example.com" })).status).toBe(202);
    const run = (await db.query<{ id: string; tenant_id: string }>("select id,tenant_id from automation_runs")).rows[0]!;
    await executeAutomationRun(db, run.tenant_id, run.id);
    expect((await db.query("select state from automation_runs")).rows).toEqual([{ state: "waiting" }]);
    expect((await post(fullKey, "/events/send", { event: "typed.wait.done", email: "WAIT@example.com", payload: { received_at: "invalid" } })).status).toBe(202);
    expect((await db.query("select state from automation_runs")).rows).toEqual([{ state: "ready" }]);
    await executeAutomationRun(db, run.tenant_id, run.id);
    expect((await db.query("select state from automation_runs")).rows).toEqual([{ state: "done" }]);
  });

  it("stores four types across repeated migrations and protects reserved definitions and viewer writes", async () => {
    const fixtures = [["plan", "string", "free"], ["seats", "number", 3], ["activated", "boolean", false], ["last_active_at", "date", "2026-10-01T01:02:03+02:00"]] as const;
    for (const [key, type, fallback_value] of fixtures) {
      expect((await post(fullKey, "/contact-properties", { key, type, fallback_value })).status).toBe(200);
    }
    await db.query(schema);
    await db.query(schema);
    expect((await call(fullKey, "GET", "/contact-properties")).json.data).toEqual(expect.arrayContaining(
      fixtures.map(([key, type, fallback_value]) => expect.objectContaining({ key, type, fallback_value })),
    ));
    for (const key of ["topics", "segments"]) {
      expect((await post(fullKey, "/contact-properties", { key, type: "string" })).status).toBe(400);
    }
    const saved = await post(fullKey, "/contacts", { email: "typed@example.com", properties: {
      plan: "pro", seats: 4, activated: true, last_active_at: "2026-10-02", undeclared: { ok: true },
    } });
    expect(saved.status).toBe(200);
    expect(saved.json.properties).toMatchObject({
      activated: { type: "boolean", value: true }, last_active_at: { type: "date", value: "2026-10-02" }, undeclared: { value: { ok: true } },
    });
    for (const properties of [{ activated: "true" }, { last_active_at: "2026-02-30" }, { seats: "4" }, { plan: false }]) {
      expect((await call(fullKey, "PATCH", `/contacts/${saved.json.id}`, { properties })).status).toBe(400);
    }
    const tenant = (await db.query<{ tenant_id: string }>("select tenant_id from contacts where id = $1", [saved.json.id])).rows[0]!.tenant_id;
    await db.query("insert into contact_properties (id, tenant_id, key, type) values ($1,$2,'topics','string')", [id("prop"), tenant]);
    expect((await post(fullKey, "/contact-properties", { key: "topics", type: "string", fallback_value: "legacy" })).status).toBe(200);
    expect((await call(fullKey, "PATCH", `/contacts/${saved.json.id}`, { properties: { topics: "legacy", segments: false } })).status).toBe(200);
    expect(await contactContext(db, tenant, "TYPED@example.com")).toMatchObject({ topics: "legacy", segments: false });
    const otherKey = await seedTenant();
    expect((await call(otherKey, "GET", `/contacts/${saved.json.id}`)).status).toBe(404);
    expect((await call(otherKey, "GET", "/contact-properties")).json.data).toEqual([]);
    const viewer = await teammate("Viewer");
    const signed = await signInAs(viewer.email, viewer.password);
    expect((await post(signed.token, "/contact-properties", { key: "hidden", type: "boolean" })).status).toBe(403);
    expect((await call(signed.token, "PATCH", `/contacts/${saved.json.id}`, { properties: { activated: false } })).status).toBe(403);
  });

  it("imports typed booleans and ISO dates into actual JSONB with row errors and retry-safe counts", async () => {
    for (const [key, type] of [["activated", "boolean"], ["last_active_at", "date"]]) {
      expect((await post(fullKey, "/contact-properties", { key, type })).status).toBe(200);
    }
    const tenant = (await db.query<{ tenant_id: string }>("select tenant_id from contact_properties limit 1")).rows[0]!.tenant_id;
    const importId = id("import");
    await createImport(db, { id: importId, tenantId: tenant, storageKey: `imports/${tenant}/${importId}`,
      columnMap: { properties: { activated: { column: "active" }, last_active_at: { column: "date" } } },
      onConflict: "upsert", segments: [], topics: [] });
    const job = (await claimImports(db, 1))[0]!;
    const csv = "email,active,date\none@example.com,YES,2026-10-01\ntwo@example.com,0,2026-10-02T03:04:05Z\nbadbool@example.com,maybe,2026-10-01\nbaddate@example.com,true,2026-02-30\n";
    const counts = await runImport(db, { stream: async () => Readable.from([csv]) }, job);
    expect(counts).toEqual({ total: 4, created: 2, updated: 0, skipped: 0, failed: 2 });
    expect((await db.query("select email, properties from contacts order by email")).rows).toEqual([
      { email: "one@example.com", properties: { activated: true, last_active_at: "2026-10-01" } },
      { email: "two@example.com", properties: { activated: false, last_active_at: "2026-10-02T03:04:05Z" } },
    ]);
    expect((await db.query("select status, counts from contact_imports where id = $1", [importId])).rows).toEqual([{ status: "completed", counts }]);
    const restarted = await runImport(db, { stream: async () => Readable.from([csv]) }, { ...job, row_offset: 4, counts });
    expect(restarted).toEqual(counts);
    expect((await db.query("select id from contacts")).rows).toHaveLength(2);
  });

  it("routes receiving topics with defaults and fresh changes, preserves segment membership and maps immutable event age", async () => {
    const subscribed = await post(fullKey, "/topics", { name: "Receiving", key: "receiving", default_subscription: "opt_in" });
    const optedOut = await post(fullKey, "/topics", { name: "Not receiving", key: "not_receiving", default_subscription: "opt_out" });
    const segment = await post(fullKey, "/segments", { name: "Members" });
    const contact = await post(fullKey, "/contacts", { email: "member@example.com", first_name: "Ada" });
    expect((await post(fullKey, `/segments/${segment.json.id}/contacts`, { email: "member@example.com" })).status).toBe(200);
    const tenant = (await db.query<{ tenant_id: string }>("select tenant_id from contacts where id=$1", [contact.json.id])).rows[0]!.tenant_id;
    expect(await contactContext(db, tenant, "MEMBER@example.com")).toMatchObject({ topics: [subscribed.json.id], segments: [segment.json.id], created_at: expect.any(String) });
    const template = await post(fullKey, "/templates", { name: "Mapped", subject: "Mapped", text: "{{{NAME}}}: {{{SEATS}}}: {{{WHEN}}}", variables: ["NAME", { key: "SEATS", type: "number" }, "WHEN"], publish: true });
    expect((await post(fullKey, "/events", { name: "typed.context" })).status).toBe(200);
    const flow = await post(fullKey, "/automations", { name: "Typed context", enabled: true, steps: [
      { key: "start", type: "trigger", config: { event_name: "typed.context" } },
      { key: "check", type: "condition", config: { type: "and", rules: [
        { type: "rule", field: "contact.topics", operator: "contains", value: subscribed.json.id },
        { type: "rule", field: "contact.topics", operator: "not_contains", value: optedOut.json.id },
        { type: "rule", field: "contact.segments", operator: "contains", value: segment.json.id },
        { type: "rule", field: "event.received_at", operator: "within", value: "1 day" },
      ] } },
      { key: "send", type: "send_email", config: { from: "hello@dispatch-fixture.net", template: template.json.id,
        variable_mapping: { NAME: "contact.first_name", SEATS: "event.seats", WHEN: "event.received_at" } } },
    ], connections: [{ from: "start", to: "check" }, { from: "check", to: "send", type: "condition_met" }] });
    expect(flow.status).toBe(200);
    const fire = () => post(fullKey, "/events/send", { event: "typed.context", email: "MEMBER@example.com", payload: { seats: 3, received_at: "spoof" } });
    expect((await fire()).status).toBe(202);
    const run = (await db.query<{ id: string }>("select id from automation_runs")).rows[0]!;
    await executeAutomationRun(db, tenant, run.id);
    const event = (await db.query<{ created_at: Date }>("select created_at from custom_events")).rows[0]!;
    const emails = await db.query<{ text: string }>("select text from emails");
    expect(emails.rows).toEqual([{ text: `Ada: 3: ${event.created_at.toISOString()}` }]);
    expect((await call(fullKey, "PATCH", `/contacts/${contact.json.id}`, { unsubscribed: true })).status).toBe(200);
    expect(await contactContext(db, tenant, "member@example.com")).toMatchObject({ topics: [], segments: [segment.json.id] });
    expect((await fire()).status).toBe(202);
    const second = (await db.query<{ id: string }>("select id from automation_runs where id <> $1", [run.id])).rows[0]!;
    await executeAutomationRun(db, tenant, second.id);
    expect((await db.query("select id from emails")).rows).toHaveLength(1);
    expect((await db.query("select data from automation_steps where run_id=$1 and step_key='check'", [second.id])).rows).toEqual([{ data: { result: false } }]);
  });
});

async function call(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) {
  const response = await app.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "dispatch-accept-test",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.statusCode,
    json: response.body ? response.json() : null,
  };
}

// A user with a password and a role, made through the API the way the team page makes one. The
// email is new on every run, because sign-in counters live in Redis and outlast the truncate.
async function teammate(
  role: "Admin" | "Viewer",
  password = "a long private password",
) {
  const roles = await call(fullKey, "GET", "/roles");
  let found = (roles.json.data as Array<{ id: string; name: string }>).find(
    (row) => row.name === role,
  );
  if (!found)
    found = (
      await call(fullKey, "POST", "/roles", {
        name: role,
        permissions: [role === "Admin" ? "full" : "read"],
      })
    ).json;
  const email = `${role.toLowerCase()}-${id("run").slice(4, 14)}@dispatch-fixture.net`;
  const user = await call(fullKey, "POST", "/users", {
    email,
    name: role,
    password,
  });
  expect(user.status).toBe(200);
  expect(
    (
      await call(fullKey, "POST", "/memberships", {
        user_id: user.json.id,
        role_id: found!.id,
      })
    ).status,
  ).toBe(200);
  return { email, password, id: user.json.id as string };
}

async function signInAs(email: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { "content-type": "application/json" },
    payload: { email, password },
  });
  return {
    status: response.statusCode,
    token: response.statusCode === 200 ? (response.json().token as string) : "",
  };
}

async function ensureDatabase() {
  const admin = connect(adminUrl);
  try {
    const existing = await admin.query(
      "select 1 from pg_database where datname = $1",
      [databaseName],
    );
    if (existing.rowCount === 0)
      await admin.query(
        `create database "${databaseName.replaceAll('"', '""')}"`,
      );
  } finally {
    await admin.end();
  }
}

async function truncate() {
  const tables = await db.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public'",
  );
  if (tables.rowCount === 0) return;
  const list = tables.rows
    .map((row) => `"${row.tablename.replaceAll('"', '""')}"`)
    .join(", ");
  const sql = `truncate ${list} restart identity cascade`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await db.query(sql);
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      if (code !== "40P01" || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function seedTenant() {
  const tenantId = id("tenant");
  const secret = makeKey().secret;
  const pepper =
    process.env.API_KEY_PEPPER ?? "dev-pepper-change-before-deploy";
  await tx(db, async (client) => {
    await client.query("insert into tenants (id, name) values ($1, $2)", [
      tenantId,
      "Test",
    ]);
    await client.query(
      "insert into domains (id, tenant_id, name, region, status, open_tracking, click_tracking) values ($1, $2, 'dispatch-fixture.net', 'us-west-2', 'verified', true, true)",
      [id("domain"), tenantId],
    );
    await client.query(
      "insert into api_keys (id, tenant_id, name, prefix, hash, scope) values ($1, $2, 'full', $3, $4, 'full')",
      [id("key"), tenantId, secret.slice(0, 12), keyHash(secret, pepper)],
    );
  });
  return secret;
}

async function contactFlow(config: Record<string, unknown>, following: Array<Record<string, unknown>> = []) {
  const steps = [{ key: "trigger", type: "trigger", config }, ...following];
  const result = await post(fullKey, "/automations", { name: id("flow"), status: "enabled", reentry: "every_time", steps,
    connections: steps.slice(1).map((step, index) => ({ from: steps[index].key, to: step.key, type: "default" })) });
  expect(result.status, JSON.stringify(result.json)).toBe(200);
  return result.json.id as string;
}

async function flowRuns(automationId: string) {
  return (await db.query<{ id: string; tenant_id: string }>(
    "select id, tenant_id from automation_runs where automation_id = $1 order by created_at, id", [automationId]
  )).rows;
}

function letter(overrides: Record<string, unknown> = {}) {
  return {
    from: "hello@dispatch-fixture.net",
    to: "you@dispatch-fixture.net",
    subject: "Hello",
    text: "Hi",
    ...overrides,
  };
}

async function queuedBroadcast(email: string) {
  const segment = await post(fullKey, "/segments", { name: "Sandbox history" });
  expect(segment.status).toBe(200);
  expect((await post(fullKey, `/segments/${segment.json.id}/contacts`, { email })).status).toBe(200);
  const broadcast = await post(fullKey, "/broadcasts", {
    name: "Sandbox history", segment_id: segment.json.id,
    from: "hello@dispatch-fixture.net", subject: "History",
    html: '<a href="https://dispatch-fixture.net/docs">Docs</a>', send: true,
  });
  expect(broadcast.status).toBe(200);
  // A tick queues broadcast recipients after processing ready send jobs. Stop here so
  // the fixture can change settings before its first production-configured delivery.
  expect((await tick()).jobs).toBe(0);
  const recipients = await db.query<{ email_id: string; status: string }>(
    "select email_id, status from broadcast_recipients where broadcast_id = $1",
    [broadcast.json.id],
  );
  expect(recipients.rows).toEqual([{ email_id: expect.any(String), status: "sent" }]);
  return { id: broadcast.json.id as string, emailId: recipients.rows[0]!.email_id };
}

async function sendJob(emailId: string) {
  const result = await db.query<Job>(
    "select id, tenant_id, email_id, request_id from send_jobs where email_id = $1",
    [emailId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

// These fixtures have no attachments. Fail rather than accidentally touch local/S3 storage.
const noStorage: Storage = {
  async put() { throw new Error("unexpected attachment write"); },
  async get() { throw new Error("unexpected attachment read"); },
  async stream() { throw new Error("unexpected attachment stream"); },
  async url() { throw new Error("unexpected attachment URL"); },
  async delete() { throw new Error("unexpected attachment deletion"); },
};

async function productionDelivery(job: Job, provider: Provider) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await deliverJob(db, noStorage, provider, job, { durable: true });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

function recordingSes(options: {
  refuse?: boolean;
  beforeSend?: (email: ProviderEmail) => Promise<void>;
} = {}) {
  const quotas: string[] = [];
  const sent: ProviderEmail[] = [];
  const provider: Provider = {
    name: "ses",
    async quota(region) {
      quotas.push(region);
      expect(process.env.NODE_ENV).toBe("production");
      if (options.refuse) throw new Error("sandbox mail called the SES quota API");
      return { max_24_hour: 100_000, max_per_second: 0, sent_24_hour: 0, sandbox: false };
    },
    async send(email) {
      sent.push(email);
      expect(process.env.NODE_ENV).toBe("production");
      if (options.refuse) throw new Error("sandbox mail called the SES send API");
      await options.beforeSend?.(email);
      const messageId = `ses_${email.id}`;
      // Like SES, accept the send but leave terminal delivery to a later provider callback.
      return {
        provider_message_id: messageId,
        events: [{
          type: "email.sent", provider_event_id: `${messageId}:sent`, delay_ms: 0,
          recipients: email.recipients.map((recipient) => recipient.email),
          data: { provider_message_id: messageId },
        }],
      };
    },
  };
  return { provider, quotas, sent };
}

async function captureWebhook() {
  const received: Parameters<typeof recordWebhook>[2] = [];
  const server = createServer((request, response) =>
    recordWebhook(request, response, received),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("webhook server did not bind");
  return {
    received,
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    ),
  };
}

async function post(
  secret: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "user-agent": "dispatch-accept-test",
      ...headers,
    },
    payload: JSON.stringify(body),
  });
  return { status: response.statusCode, json: response.json() };
}

function recordWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  received: Array<{
    url: string;
    body: string;
    id: string;
    timestamp: string;
    signature: string;
  }>,
) {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    received.push({
      url: request.url ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
      id: request.headers["dispatch-webhook-id"]?.toString() ?? "",
      timestamp:
        request.headers["dispatch-webhook-timestamp"]?.toString() ?? "",
      signature:
        request.headers["dispatch-webhook-signature"]?.toString() ?? "",
    });
    if (request.url === "/refuse") {
      response.writeHead(500);
      response.end("no");
      return;
    }
    response.writeHead(200);
    response.end("ok");
  });
}
