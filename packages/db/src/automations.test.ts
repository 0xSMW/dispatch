import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "./index.js";

const ingestEmail = vi.hoisted(() => vi.fn());
const emit = vi.hoisted(() => vi.fn());
vi.mock("./emails.js", () => ({ ingestEmail }));
vi.mock("./events.js", () => ({ emit }));

const { executeAutomationRun, fireEvent, stepLimit, contactContext, eventContext, mappedVariables } = await import("./automations.js");

type StepRow = { step_key: string | null; step_index: number; type: string; state: string; data: Record<string, unknown>; error?: string };
type Contact = { id: string; email: string; unsubscribed_at?: string | null; deleted?: boolean; properties?: Record<string, unknown>; topics?: string[]; segments?: string[] };

// An in-memory stand-in for the tables the executor touches. Writes made inside a transaction
// are undone on rollback, the way the step transaction depends on.
function fake(run: {
  steps: Array<Record<string, unknown>>;
  connections?: unknown[];
  trigger?: string;
  data?: Record<string, unknown>;
  email?: string | null;
  state?: string;
  next_step_index?: number;
  next_step_key?: string | null;
  resume_data?: Record<string, unknown> | null;
  rows?: StepRow[];
  contacts?: Contact[];
  deleted?: boolean;
  onStep?: (text: string, state: ReturnType<typeof fake>["state"]) => void;
}) {
  const state = {
    run: {
      id: "run_1",
      tenant_id: "tenant_1",
      automation_id: "automation_1",
      event_id: "ce_1",
      request_id: "req_1",
      state: run.state ?? "ready",
      next_step_index: run.next_step_index ?? 0,
      next_step_key: run.next_step_key ?? null,
      resume_data: run.resume_data ?? null,
      resume_at: null as Date | null,
      wait_event: null as string | null,
      error: null as string | null,
      trigger: run.trigger ?? "user.created",
      steps: run.steps,
      connections: run.connections ?? [],
      automation_deleted: run.deleted ?? false,
      email: run.email === undefined ? "ada@example.com" : run.email,
      data: run.data ?? {},
      received_at: "2026-10-04T00:00:00Z"
    },
    steps: [...(run.rows ?? [])] as StepRow[],
    contacts: [...(run.contacts ?? [])] as Contact[],
    deletedEmails: [] as string[],
    cleared: [] as string[]
  };
  let snapshot: string | null = null;

  const running = () => state.run.state === "running";
  const active = () => ["ready", "running", "waiting"].includes(state.run.state);
  const one = [{ id: "run_1" }];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    run.onStep?.(text, state);
    if (text === "begin") {
      snapshot = JSON.stringify({ run: state.run, steps: state.steps, contacts: state.contacts });
      return { rows: [] };
    }
    if (text === "commit") {
      snapshot = null;
      return { rows: [] };
    }
    if (text === "rollback") {
      if (snapshot) {
        const saved = JSON.parse(snapshot) as { run: typeof state.run; steps: StepRow[]; contacts: Contact[] };
        Object.assign(state.run, saved.run, { resume_at: saved.run.resume_at ? new Date(saved.run.resume_at) : null });
        state.steps.splice(0, state.steps.length, ...saved.steps);
        state.contacts.splice(0, state.contacts.length, ...saved.contacts);
      }
      snapshot = null;
      return { rows: [] };
    }
    if (text.includes("from automation_runs r join automations a")) return { rows: [{ ...state.run }] };
    if (text.startsWith("select r.id, r.automation_id")) return { rows: [{
      ...state.run, contact_id: state.contacts.find((contact) => contact.email.toLowerCase() === state.run.email?.toLowerCase())?.id ?? null,
    }] };
    if (text.startsWith("select id from automation_runs")) return { rows: running() ? one : [] };
    if (text.startsWith("update automation_runs set state = 'stopped'")) {
      if (!active()) return { rows: [] };
      state.run.state = "stopped";
      return { rows: one };
    }
    if (text.startsWith("update automation_runs set state = 'running'")) {
      if (!active()) return { rows: [] };
      Object.assign(state.run, { state: "running", resume_at: null, wait_event: null });
      return { rows: one };
    }
    if (text.startsWith("update automation_runs set state = 'waiting'")) {
      if (!running()) return { rows: [] };
      Object.assign(state.run, { state: "waiting", next_step_key: params[2], resume_at: params[3], wait_event: params[4], resume_data: null });
      return { rows: one };
    }
    if (text.startsWith("update automation_runs set next_step_key = $3, resume_data = null")) {
      if (!running()) return { rows: [] };
      Object.assign(state.run, { next_step_key: params[2], resume_data: null, state: params[2] === null ? "done" : "running" });
      return { rows: one };
    }
    if (text.startsWith("update automation_runs set state = 'failed'")) {
      if (!running()) return { rows: [] };
      Object.assign(state.run, { state: "failed", error: params[2] });
      return { rows: one };
    }
    if (text.startsWith("update automation_runs set next_step_key")) {
      state.run.next_step_key = params[2] as string | null;
      return { rows: [] };
    }
    if (text.startsWith("select id, step_index from automation_steps")) {
      const row = state.steps.find((step) => step.state === "waiting" && !step.step_key);
      return { rows: row ? [{ id: "step_legacy", step_index: row.step_index }] : [] };
    }
    if (text.startsWith("update automation_steps set step_key")) {
      const row = state.steps.find((step) => step.state === "waiting" && !step.step_key);
      if (row) row.step_key = params[2] as string;
      return { rows: [] };
    }
    if (text.startsWith("update automation_steps set state = 'done'")) {
      const row = state.steps.find((step) => step.step_key === params[2] && step.state === "waiting");
      if (!row) return { rows: [], rowCount: 0 };
      Object.assign(row, { state: "done", data: { ...row.data, ...JSON.parse(params[3] as string) } });
      return { rows: [{ id: "step" }], rowCount: 1 };
    }
    if (text.startsWith("insert into automation_steps")) {
      const waiting = text.includes("'waiting'");
      const failed = text.includes("'failed'");
      state.steps.push({
        step_index: params[3] as number,
        step_key: params[4] as string,
        type: params[5] as string,
        state: waiting ? "waiting" : failed ? "failed" : "done",
        data: failed ? {} : JSON.parse(params[6] as string),
        error: failed ? (params[6] as string) : undefined
      });
      return { rows: [] };
    }
    if (text.includes("from contact_properties")) return { rows: [] };
    if (text.includes("(deleted_at is not null) as deleted from contacts")) {
      const found = state.contacts.find((contact) => contact.email.toLowerCase() === String(params[1]).toLowerCase());
      return { rows: found ? [{ id: found.id, email: found.email, deleted: Boolean(found.deleted) }] : [] };
    }
    if (text.includes("from contacts where tenant_id = $1 and lower(email) = lower($2) and deleted_at is not null")) {
      const found = state.contacts.find((contact) => contact.deleted && contact.email.toLowerCase() === String(params[1]).toLowerCase());
      return { rows: found ? [{ "?column?": 1 }] : [] };
    }
    if (text.includes("from contacts where tenant_id = $1 and lower(email) = lower($2) and deleted_at is null")) {
      const found = state.contacts.find((contact) => !contact.deleted && contact.email.toLowerCase() === String(params[1]).toLowerCase());
      return {
        rows: found
          ? [{ id: found.id, email: found.email, first_name: null, last_name: null, properties: found.properties ?? {}, unsubscribed_at: found.unsubscribed_at ?? null, created_at: "2026-09-01T00:00:00Z", topics: found.topics ?? [], segments: found.segments ?? [] }]
          : []
      };
    }
    if (text.startsWith("insert into contacts")) {
      const created = { id: "contact_new", email: String(params[2]) };
      state.contacts.push(created);
      return { rows: [{ ...created, created: true }] };
    }
    if (text.startsWith("select id from contacts where tenant_id = $1 and lower(email) = lower($2)")) {
      const found = state.contacts.find((contact) => !contact.deleted && contact.email.toLowerCase() === String(params[1]).toLowerCase());
      return { rows: found ? [{ id: found.id }] : [] };
    }
    if (text.startsWith("update contacts set deleted_at")) {
      const found = state.contacts.find((contact) => !contact.deleted && contact.id === params[1]);
      if (!found) return { rows: [] };
      found.deleted = true;
      state.deletedEmails.push(found.email);
      return { rows: [{ id: found.id }] };
    }
    if (text.startsWith("delete from segment_contacts") || text.startsWith("delete from topic_subscriptions")) {
      state.cleared.push(text.split(" ")[2]!);
      return { rows: [] };
    }
    if (text.startsWith("update contacts set first_name")) return { rows: [{ id: params[1], email: "updated" }] };
    if (text.startsWith("select id from segments")) return { rows: [{ id: params[1] }] };
    if (text.startsWith("insert into segment_contacts")) return { rows: [] };
    throw new Error(`unexpected query: ${text}`);
  });
  const db = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Db;
  return { db, state, query };
}

const sent = () => ingestEmail.mock.calls.map((call) => (call[1] as { template: string }).template);
const send = (key: string, template: string) => ({ key, type: "send_email", config: { from: "hello@acme.com", template } });

const branch = {
  steps: [
    { key: "start", type: "trigger", config: { event_name: "user.created" } },
    { key: "check", type: "condition", config: { type: "rule", field: "event.plan", operator: "eq", value: "pro" } },
    send("pro", "pro-welcome"),
    send("free", "free-welcome")
  ],
  connections: [
    { from: "start", to: "check" },
    { from: "check", to: "pro", type: "condition_met" },
    { from: "check", to: "free", type: "condition_not_met" }
  ]
};

const waitFlow = {
  steps: [
    { key: "start", type: "trigger", config: { event_name: "user.created" } },
    { key: "wait", type: "wait_for_event", config: { event_name: "user.activated", timeout: "3 days" } },
    send("nudge", "nudge"),
    send("thanks", "thanks")
  ],
  connections: [
    { from: "start", to: "wait" },
    { from: "wait", to: "nudge", type: "timeout" },
    { from: "wait", to: "thanks", type: "event_received" }
  ]
};

beforeEach(() => {
  ingestEmail.mockReset();
  emit.mockReset();
  ingestEmail.mockImplementation(async (_client: unknown, input: { template: string }) => ({ email: { id: `email_${input.template}` } }));
});

describe("executeAutomationRun", () => {
  it("emits one completion transition and does not emit it again on a retry", async () => {
    emit.mockClear();
    const { db } = fake({ ...branch, data: { plan: "pro" }, contacts: [{ id: "contact_1", email: "ada@example.com" }] });
    await executeAutomationRun(db, "tenant_1", "run_1");
    await executeAutomationRun(db, "tenant_1", "run_1");
    const events = emit.mock.calls.filter((call) => call[1]?.type === "automation.run.completed");
    expect(events).toHaveLength(1);
    expect(events[0]![1]).toMatchObject({
      key: "run_1:automation.run.completed", data: { automation_id: "automation_1", run_id: "run_1", contact_id: "contact_1", state: "done" },
    });
  });

  it("follows condition_met and records keyed steps", async () => {
    const { db, state } = fake({ ...branch, data: { plan: "pro" } });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(ingestEmail).toHaveBeenCalledTimes(1);
    expect(ingestEmail.mock.calls[0]![1]).toMatchObject({ template: "pro-welcome", to: "ada@example.com", variables: { plan: "pro" }, automationId: "automation_1", automationStep: "pro" });
    expect(state.steps.map((step) => [step.step_key, step.state])).toEqual([
      ["check", "done"],
      ["pro", "done"]
    ]);
    expect(state.steps[0]!.data).toEqual({ result: true });
    expect(state.steps[1]!.data).toEqual({ email_id: "email_pro-welcome" });
    expect(state.run.state).toBe("done");
  });

  it("follows condition_not_met when the rule fails", async () => {
    const { db } = fake({ ...branch, data: { plan: "free" } });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(sent()).toEqual(["free-welcome"]);
  });

  it("pauses at a wait and takes the timeout edge the worker recorded", async () => {
    const { db, state } = fake(waitFlow);
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(state.run).toMatchObject({ state: "waiting", next_step_key: "wait", wait_event: "user.activated" });
    const days = ((state.run.resume_at as unknown as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.99);
    expect(ingestEmail).not.toHaveBeenCalled();

    // What the worker's claim writes for a wait that ran out.
    Object.assign(state.run, { state: "running", resume_data: { timed_out: true } });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(sent()).toEqual(["nudge"]);
    expect(state.steps[0]).toMatchObject({ step_key: "wait", state: "done", data: { timed_out: true } });
    expect(state.run).toMatchObject({ state: "done", resume_data: null });
  });

  it("takes the event_received edge when an event woke the run", async () => {
    const { db, state } = fake(waitFlow);
    await executeAutomationRun(db, "tenant_1", "run_1");
    // What fireEvent writes for a run it wakes.
    Object.assign(state.run, { state: "ready", resume_data: { event_id: "ce_2" } });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(sent()).toEqual(["thanks"]);
    expect(state.steps[0]!.data).toMatchObject({ event_id: "ce_2" });
  });

  it("pauses a delay for its natural-language duration", async () => {
    const { db, state } = fake({
      steps: [{ key: "start", type: "trigger", config: { event_name: "e" } }, { key: "later", type: "delay", config: { duration: "30 days" } }],
      connections: [{ from: "start", to: "later" }]
    });
    await executeAutomationRun(db, "tenant_1", "run_1");
    const days = ((state.run.resume_at as unknown as Date).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect(state.run.wait_event).toBeNull();
  });

  it("stays stopped when the automation is stopped while a step is in flight", async () => {
    const flow = {
      steps: [
        { key: "start", type: "trigger", config: { event_name: "e" } },
        send("one", "one"),
        { key: "later", type: "delay", config: { duration: "1 hour" } },
        send("two", "two")
      ],
      connections: [
        { from: "start", to: "one" },
        { from: "one", to: "later" },
        { from: "later", to: "two" }
      ]
    };
    const { db, state } = fake(flow);
    // POST /stop lands while the first email is being accepted.
    ingestEmail.mockImplementationOnce(async () => {
      state.run.state = "stopped";
      return { email: { id: "email_one" } };
    });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(state.run.state).toBe("stopped");
    expect(state.run.resume_at).toBeNull();
    expect(state.steps.some((step) => step.state === "waiting")).toBe(false);

    // A later wake-up of the stopped run does nothing.
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(sent()).toEqual(["one"]);
    expect(state.run.state).toBe("stopped");
  });

  it("stops a run whose automation was deleted", async () => {
    const { db, state } = fake({ ...branch, deleted: true, state: "waiting", next_step_key: "pro" });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(state.run.state).toBe("stopped");
    expect(ingestEmail).not.toHaveBeenCalled();
  });

  it("leaves no trace of a step when the worker dies inside it, so a second pass sends once", async () => {
    const { db, state } = fake({ ...branch, data: { plan: "pro" } });
    ingestEmail.mockImplementationOnce(async () => {
      throw Object.assign(new Error("connection lost"), { fatal: true });
    });
    await executeAutomationRun(db, "tenant_1", "run_1");
    // The failure is recorded and the run fails. Nothing from the send step itself was kept.
    expect(state.steps.map((step) => [step.step_key, step.state])).toEqual([
      ["check", "done"],
      ["pro", "failed"]
    ]);
    expect(state.run).toMatchObject({ state: "failed", next_step_key: "pro" });
  });

  it("resumes a reclaimed run at its next step without repeating finished ones", async () => {
    const { db, state } = fake({ ...branch, data: { plan: "pro" }, state: "running", next_step_key: "pro" });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(sent()).toEqual(["pro-welcome"]);
    expect(state.steps.map((step) => step.step_key)).toEqual(["pro"]);
    expect(state.run.state).toBe("done");
  });

  it("with a topic, skips a contact who unsubscribed from everything, and goes on", async () => {
    const flow = {
      steps: [
        { key: "start", type: "trigger", config: { event_name: "e" } },
        { key: "one", type: "send_email", config: { from: "hello@acme.com", template: "one", topic_id: "topic_news" } },
        { key: "tag", type: "add_to_segment", config: { segment_id: "segment_1" } }
      ],
      connections: [
        { from: "start", to: "one" },
        { from: "one", to: "tag" }
      ]
    };
    const { db, state } = fake({ ...flow, email: "Ada@Example.com", contacts: [{ id: "contact_1", email: "ada@example.com", unsubscribed_at: "2026-10-01T00:00:00Z" }] });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(ingestEmail).not.toHaveBeenCalled();
    expect(state.steps[0]).toMatchObject({ step_key: "one", state: "done", data: { skipped: "unsubscribed" } });
    expect(state.steps[1]).toMatchObject({ step_key: "tag", data: { contact_id: "contact_1" } });
    expect(state.run.state).toBe("done");
  });

  it("with a topic, skips a deleted contact, who is subscribed to nothing", async () => {
    const flow = {
      steps: [
        { key: "start", type: "trigger", config: { event_name: "e" } },
        { key: "one", type: "send_email", config: { from: "hello@acme.com", template: "one", topic_id: "topic_news" } }
      ],
      connections: [{ from: "start", to: "one" }]
    };
    const { db, state } = fake({ ...flow, email: "ada@example.com", contacts: [{ id: "contact_1", email: "ada@example.com", deleted: true }] });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(ingestEmail).not.toHaveBeenCalled();
    expect(state.steps[0]).toMatchObject({ step_key: "one", state: "done", data: { skipped: "contact_deleted" } });
  });

  it("without a topic, sends to an unsubscribed contact, as a receipt or a password reset must", async () => {
    const flow = {
      steps: [{ key: "start", type: "trigger", config: { event_name: "e" } }, { key: "one", type: "send_email", config: { template: "one" } }],
      connections: [{ from: "start", to: "one" }]
    };
    const { db, state } = fake({ ...flow, email: "ada@example.com", contacts: [{ id: "contact_1", email: "ada@example.com", unsubscribed_at: "2026-10-01T00:00:00Z" }] });
    await executeAutomationRun(db, "tenant_1", "run_1");
    // No sender on the step: the template's own is used, so an empty one is passed through.
    expect(ingestEmail.mock.calls[0]![1]).toMatchObject({ template: "one", to: "ada@example.com", from: "", topicId: undefined });
    expect(state.steps[0]).toMatchObject({ step_key: "one", state: "done", data: { email_id: "email_one" } });
  });

  it("passes the topic to the send and records an opt-out as skipped", async () => {
    ingestEmail.mockImplementation(async () => ({ email: { id: "email_x", status: "failed" } }));
    const flow = {
      steps: [{ key: "start", type: "trigger", config: { event_name: "e" } }, { key: "one", type: "send_email", config: { from: "hello@acme.com", template: "one", topic_id: "topic_news" } }],
      connections: [{ from: "start", to: "one" }]
    };
    const { db, state } = fake({ ...flow, email: "ada@example.com", contacts: [{ id: "contact_1", email: "ada@example.com" }] });
    await executeAutomationRun(db, "tenant_1", "run_1", { secret: "test-secret", appUrl: "https://app.example", publicUrl: "https://api.example" });
    expect(ingestEmail.mock.calls[0]![1]).toMatchObject({ topicId: "topic_news", headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    expect(state.steps[0]).toMatchObject({ data: { email_id: "email_x", skipped: "opted_out" } });
    expect(state.run.state).toBe("done");
  });

  it("tells webhooks about a contact an automation changed", async () => {
    const flow = {
      steps: [{ key: "start", type: "trigger", config: { event_name: "e" } }, { key: "edit", type: "contact_update", config: { first_name: "Ada" } }],
      connections: [{ from: "start", to: "edit" }]
    };
    const { db } = fake({ ...flow, email: "ada@example.com", contacts: [{ id: "contact_1", email: "ada@example.com" }] });
    await executeAutomationRun(db, "tenant_1", "run_1");
    const changes = emit.mock.calls.filter((call) => call[1]?.type === "contact.updated");
    expect(changes).toHaveLength(1);
    expect(changes[0]![1]).toMatchObject({ type: "contact.updated", resourceId: "contact_1", key: "contact_1:contact.updated:run_1:edit" });
  });

  it("does not bring a deleted contact back", async () => {
    const flow = {
      steps: [
        { key: "start", type: "trigger", config: { event_name: "e" } },
        { key: "tag", type: "add_to_segment", config: { segment_id: "segment_1" } },
        { key: "edit", type: "contact_update", config: { first_name: "Ada" } }
      ],
      connections: [
        { from: "start", to: "tag" },
        { from: "tag", to: "edit" }
      ]
    };
    const { db, state, query } = fake({ ...flow, contacts: [{ id: "contact_1", email: "ada@example.com", deleted: true }] });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(state.steps.map((step) => step.data)).toEqual([
      { skipped: "contact_deleted", email: "ada@example.com" },
      { skipped: "contact_deleted", email: "ada@example.com" }
    ]);
    expect(query.mock.calls.some((call) => String(call[0]).includes("insert into contacts"))).toBe(false);
    expect(query.mock.calls.some((call) => String(call[0]).includes("insert into segment_contacts"))).toBe(false);
  });

  it("fails a run that loops past the step limit", async () => {
    const check = (key: string) => ({ key, type: "condition", config: { type: "rule", field: "event.x", operator: "exists" } });
    const { db, state } = fake({
      steps: [{ key: "start", type: "trigger", config: { event_name: "e" } }, check("a"), check("b")],
      connections: [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" }
      ]
    });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(state.run.state).toBe("failed");
    expect(state.run.error).toBe(`Automation run stopped after ${stepLimit} steps`);
    expect(state.steps).toHaveLength(stepLimit);
  });

  it("deletes the contact on contact_delete, matching the address in any case", async () => {
    const flow = {
      steps: [{ key: "start", type: "trigger", config: { event_name: "e" } }, { key: "drop", type: "contact_delete", config: {} }],
      connections: [{ from: "start", to: "drop" }]
    };
    const { db, state } = fake({ ...flow, email: "ADA@example.com", contacts: [{ id: "contact_1", email: "ada@example.com" }] });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(state.deletedEmails).toEqual(["ada@example.com"]);
    expect(state.cleared).toEqual(["segment_contacts", "topic_subscriptions"]);
    expect(state.steps[0]!.data).toMatchObject({ contact_id: "contact_1", deleted: true });

    const missing = fake(flow);
    await executeAutomationRun(missing.db, "tenant_1", "run_1");
    expect(missing.state.steps[0]!.data).toMatchObject({ contact_id: null, deleted: false });
  });

  it("resolves a legacy run paused at a wait from next_step_index once", async () => {
    const { db, state } = fake({
      trigger: "user.created",
      steps: [
        { type: "delay", seconds: 60 },
        { type: "wait", event: "user.activated" },
        { type: "send_email", from: "hello@acme.com", template: "after" }
      ],
      state: "running",
      next_step_index: 2,
      resume_data: { event_id: "ce_2" },
      rows: [
        { step_key: null, step_index: 0, type: "delay", state: "done", data: {} },
        { step_key: null, step_index: 1, type: "wait", state: "waiting", data: {} }
      ]
    });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(state.steps[1]).toMatchObject({ step_key: "step_2", state: "done" });
    expect(sent()).toEqual(["after"]);
    expect(state.run.state).toBe("done");
  });

  it("resolves a legacy run that had not paused to the next unexecuted step", async () => {
    const { db } = fake({
      steps: [
        { type: "send_email", from: "hello@acme.com", template: "first" },
        { type: "send_email", from: "hello@acme.com", template: "second" }
      ],
      next_step_index: 1
    });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(sent()).toEqual(["second"]);
  });

  it("records a failed step and fails the run", async () => {
    const { db, state } = fake({ ...branch, email: null, data: { plan: "pro" } });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(state.steps.at(-1)).toMatchObject({ step_key: "pro", state: "failed" });
    expect(state.run).toMatchObject({ state: "failed", error: "send_email step needs a recipient" });
  });

  it("finishes a run whose graph has only a trigger", async () => {
    const { db, state } = fake({ steps: [{ key: "start", type: "trigger", config: { event_name: "e" } }], connections: [] });
    await executeAutomationRun(db, "tenant_1", "run_1");
    expect(state.run.state).toBe("done");
  });
});

describe("typed automation context", () => {
  it("adds memberships and created time while preserving legacy reserved properties", async () => {
    const current = fake({ steps: [], contacts: [{ id: "contact_1", email: "ada@example.com", topics: ["topic_1"], segments: ["seg_1"], properties: { activated: false } }] });
    expect(await contactContext(current.db, "tenant_1", "ADA@example.com")).toMatchObject({
      activated: false, topics: ["topic_1"], segments: ["seg_1"], created_at: "2026-09-01T00:00:00Z", unsubscribed: false,
    });
    current.state.contacts[0]!.unsubscribed_at = "2026-10-01";
    expect(await contactContext(current.db, "tenant_1", "ada@example.com")).toMatchObject({ topics: [], segments: ["seg_1"] });
    current.state.contacts[0]!.properties = { topics: "legacy", segments: false };
    expect(await contactContext(current.db, "tenant_1", "ada@example.com")).toMatchObject({ topics: "legacy", segments: false });
    expect(await contactContext(current.db, "tenant_1", null)).toBeNull();
  });
  it("uses received time instead of a payload spoof and maps only own context fields", () => {
    const event = eventContext({ received_at: "spoof", plan: "pro" }, "2026-10-04T00:00:00Z");
    expect(event.received_at).toBe("2026-10-04T00:00:00Z");
    const contact = Object.assign(Object.create({ hidden: "secret" }), { activated: false, seats: 3 });
    expect(mappedVariables({ PLAN: "event.plan", ACTIVE: "contact.activated", SEATS: "contact.seats", SECRET: "contact.hidden", MISSING: "event.absent" }, { event, contact })).toEqual({ PLAN: "pro", ACTIVE: false, SEATS: 3 });
  });
  it("routes against receiving topics and maps fresh recipient values", async () => {
    const run = fake({
      steps: [
        { key: "trigger", type: "trigger", config: { event_name: "user.created" } },
        { key: "rule", type: "condition", config: { type: "rule", field: "contact.topics", operator: "contains", value: "topic_1" } },
        { key: "send", type: "send_email", config: { template: { id: "tmpl_1", variables: { PLAN: "literal" } }, variable_mapping: { PLAN: "event.plan", ACTIVE: "contact.activated", AGE: "event.received_at" } } },
      ],
      connections: [{ from: "trigger", to: "rule" }, { from: "rule", to: "send", type: "condition_met" }],
      data: { plan: "pro", received_at: "spoof" },
      contacts: [{ id: "contact_1", email: "ada@example.com", topics: ["topic_1"], properties: { activated: false } }],
    });
    ingestEmail.mockResolvedValue({ email: { id: "email_1", status: "queued" } });
    await executeAutomationRun(run.db, "tenant_1", "run_1");
    expect(run.state.steps.find((step) => step.step_key === "rule")?.data).toEqual({ result: true });
    expect(ingestEmail.mock.calls.at(-1)?.[1].variables).toMatchObject({ PLAN: "pro", ACTIVE: false, AGE: "2026-10-04T00:00:00Z" });
  });
});

describe("fireEvent", () => {
  it("starts matching automations and wakes only waiting runs whose filter passes", async () => {
    const waitStep = (rule: unknown) => ({
      trigger: "user.created",
      steps: [
        { key: "start", type: "trigger", config: { event_name: "user.created" } },
        { key: "wait", type: "wait_for_event", config: { event_name: "plan.changed", filter_rule: rule } }
      ],
      connections: [{ from: "start", to: "wait" }]
    });
    const query = vi.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes("insert into custom_events")) return { rows: [{ id: "ce_9", name: "plan.changed", data: { plan: "free" } }] };
      if (sql.includes("select id from contacts")) return { rows: [{ id: "contact_1" }] };
      if (sql.includes("select id from automations")) return { rows: [{ id: "automation_2" }] };
      if (sql.includes("insert into automation_runs")) return { rows: [{ id: "run_new" }] };
      if (sql.includes("for update of r skip locked")) {
        return {
          rows: [
            { id: "run_pro", next_step_key: "wait", ...waitStep({ type: "rule", field: "event.plan", operator: "eq", value: "pro" }) },
            { id: "run_any", next_step_key: "wait", ...waitStep(undefined) },
            { id: "run_legacy", next_step_key: null, trigger: "x", steps: [{ type: "wait", event: "plan.changed" }], connections: [] }
          ]
        };
      }
      return { rows: [] };
    });
    const db = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Db;
    const fired = await fireEvent(db, "tenant_1", "req_1", { name: "plan.changed", email: "Ada@Example.com", data: { plan: "free" } });
    expect(fired.runs).toEqual(["run_new"]);
    expect(fired.resumed).toEqual(["run_any", "run_legacy"]);

    // The address is stored and matched in lower case.
    const stored = query.mock.calls.find((call) => call[0].includes("insert into custom_events"));
    expect(stored?.[1]?.[4]).toBe("ada@example.com");
    const waiting = query.mock.calls.find((call) => call[0].includes("for update of r skip locked"));
    expect(waiting?.[1]).toEqual(["tenant_1", "plan.changed", "ada@example.com"]);
    // A run with no contact is woken only by an event with no contact.
    expect(waiting?.[0]).toContain("started.email is null and $3::text is null");

    // Woken runs are left for the worker, with the event that woke them.
    const wake = query.mock.calls.find((call) => call[0].includes("set state = 'ready'"));
    expect(wake?.[1]).toEqual(["tenant_1", ["run_any", "run_legacy"], JSON.stringify({ event_id: "ce_9" })]);
  });

  // `existing` is what the lookup by address finds, live or deleted. `inserted` is false when the
  // insert met another event's contact and did nothing.
  type Found = { id: string; first_name: string | null; last_name: string | null; deleted_at: string | null };
  function contactDb(existing: Found[], inserted = true) {
    const query = vi.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes("insert into custom_events")) return { rows: [{ id: "ce_1", name: "user.created", data: {} }] };
      if (sql.includes("deleted_at from contacts")) return { rows: existing };
      if (sql.includes("insert into contacts")) return { rows: inserted ? [{ id: "contact_new", email: "ada@example.com" }] : [] };
      if (sql.includes("update contacts set")) return { rows: existing.filter((row) => !row.deleted_at).map((row) => ({ id: row.id, email: "ada@example.com" })) };
      return { rows: [] };
    });
    const db = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Db;
    const calls = (text: string) => query.mock.calls.filter((call) => call[0].includes(text));
    return { db, query, inserts: () => calls("insert into contacts"), updates: () => calls("update contacts set") };
  }
  const live = (names: Partial<Found> = {}): Found => ({ id: "contact_1", first_name: null, last_name: null, deleted_at: null, ...names });

  it("creates a contact for an address it has not seen, named from the payload", async () => {
    emit.mockClear();
    const { db, query, inserts } = contactDb([]);
    await fireEvent(db, "tenant_1", "req_1", { name: "user.created", email: "Ada@Example.com", data: { first_name: " Ada ", last_name: 7, plan: "pro" } });
    expect(inserts()).toHaveLength(1);
    const [sql, params] = inserts()[0]! as [string, unknown[]];
    // Lowercased, named from the string field only, and subscribed: the insert sets no opt-out.
    expect(params.slice(2, 5)).toEqual(["ada@example.com", "Ada", null]);
    expect(sql).not.toContain("unsubscribed_at");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![1]).toMatchObject({ type: "contact.created", resourceId: "contact_new", key: "contact_new:contact.created:ce_1" });
    // The contact exists before the runs and their condition context are read.
    const order = query.mock.calls.map((call) => call[0]);
    expect(order.findIndex((text) => text.includes("insert into contacts"))).toBeLessThan(order.findIndex((text) => text.includes("select id from automations")));
  });

  it("finds a deleted contact by its address and does not bring it back", async () => {
    emit.mockClear();
    const { db, query, inserts, updates } = contactDb([live({ deleted_at: "2026-10-01T00:00:00Z" })]);
    await fireEvent(db, "tenant_1", "req_1", { name: "user.created", email: "ada@example.com", data: { first_name: "Ada" } });
    // The lookup must see deleted rows. Filtering them out would create a second contact.
    const lookup = query.mock.calls.find((call) => call[0].includes("deleted_at from contacts"))!;
    expect(lookup[0]).not.toContain("deleted_at is null");
    expect(inserts()).toHaveLength(0);
    expect(updates()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("leaves a named contact alone, and names one that has no name", async () => {
    emit.mockClear();
    const named = contactDb([live({ first_name: "Grace", last_name: "Hopper" })]);
    await fireEvent(named.db, "tenant_1", "req_1", { name: "user.created", email: "ada@example.com", data: { first_name: "Ada", last_name: "Lovelace" } });
    expect(named.inserts()).toHaveLength(0);
    expect(named.updates()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();

    const nameless = contactDb([live({ first_name: " ", last_name: "Lovelace" })]);
    await fireEvent(nameless.db, "tenant_1", "req_1", { name: "user.created", email: "ada@example.com", data: { first_name: "Ada", last_name: "Byron" } });
    const [sql, params] = nameless.updates()[0]! as [string, unknown[]];
    // A blank name is filled, and a name the contact has is kept.
    expect(sql).toContain("coalesce(nullif(trim(first_name), ''), $3, first_name)");
    expect(sql).toContain("deleted_at is null");
    expect(params).toEqual(["tenant_1", "contact_1", "Ada", "Byron"]);
    expect(emit.mock.calls[0]![1]).toMatchObject({ type: "contact.updated", resourceId: "contact_1", key: "contact_1:contact.updated:ce_1" });
  });

  it("lets every unique index arbitrate, so a second event for a new address neither fails nor emits", async () => {
    emit.mockClear();
    const { db, inserts } = contactDb([], false);
    await expect(fireEvent(db, "tenant_1", "req_1", { name: "user.created", email: "ada@example.com", data: {} })).resolves.toBeTruthy();
    // With a conflict target only the table constraint would arbitrate, and a race on the
    // lower(email) index would raise a unique violation instead.
    expect(inserts()[0]![0]).toMatch(/on conflict do nothing/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("takes a name only when it fits after trimming", async () => {
    const { db, inserts } = contactDb([]);
    await fireEvent(db, "tenant_1", "req_1", { name: "user.created", email: "ada@example.com", data: { first_name: `  ${"a".repeat(120)}  `, last_name: "b".repeat(121) } });
    expect((inserts()[0]![1] as unknown[]).slice(3, 5)).toEqual(["a".repeat(120), null]);
  });

  it("creates no contact for an event with no address", async () => {
    const { db, query } = contactDb([]);
    await fireEvent(db, "tenant_1", "req_1", { name: "cron.tick", email: null, data: {} });
    expect(query.mock.calls.some((call) => call[0].includes("contacts"))).toBe(false);
  });
});
