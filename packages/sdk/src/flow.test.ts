import { signWebhook } from "@dispatchmail/core";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  Dispatch, type AutomationConnection, type AutomationCreate, type AutomationExitReason,
  type AutomationGuard, type AutomationRun, type AutomationRunDetail, type AutomationRunEvent,
  type BranchConfig, type ExitConfig, type FilterConfig, type List, type Result, type Rule,
} from "./index.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

const rule: Rule = { type: "rule", field: "contact.activated", operator: "eq", value: false };
const guard: AutomationGuard = { filter: "audience", rule };
const branch: BranchConfig = { paths: [
  { key: "free", label: "Free", rule: { type: "rule", field: "contact.plan", operator: "eq", value: "free" } },
  { key: "active", label: "Active", rule: { type: "and", rules: [
    { type: "rule", field: "contact.score", operator: "gte", value: 0 },
    { type: "rule", field: "event.isTrial", operator: "eq", value: true },
  ] } },
] };
const connections: AutomationConnection[] = [
  { from: "start", to: "audience" },
  { from: "audience", to: "choose", type: "default" },
  { from: "choose", to: "end", type: "branch", path: "free" },
  { from: "choose", to: "end", type: "branch", path: "active" },
  { from: "choose", to: "end", type: "branch", path: "otherwise" },
];

function stub(body: unknown) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  }));
  globalThis.fetch = fetch as typeof globalThis.fetch;
  return fetch;
}

describe("automation flow contracts", () => {
  it.each(["next", "following"] as const)("preserves %s filters, ordered branches, keyed edges and empty exit configs", async (scope) => {
    const filter: FilterConfig = { rule, scope };
    const exit: ExitConfig = {};
    const input: AutomationCreate = {
      name: "Onboarding", status: "disabled", reentry: "once",
      steps: [
        { key: "start", type: "trigger", config: { type: "contact_created" } },
        { key: "audience", type: "filter", config: filter },
        { key: "choose", type: "branch", config: branch },
        { key: "end", type: "exit", config: exit },
      ],
      connections,
    };
    const fetch = stub({ id: "a1" });
    const client = new Dispatch({ apiKey: "sk_test" });
    await client.automations.create(input);
    await client.automations.update("a/1", input);
    await client.automations.dryRun("a/1", input);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:3100/automations",
      "http://localhost:3100/automations/a%2F1",
      "http://localhost:3100/automations/a%2F1?dry_run=true",
    ]);
    for (const [, init] of fetch.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(JSON.parse(init.body as string)).toEqual(input);
    }
    expectTypeOf<FilterConfig["scope"]>().toEqualTypeOf<"next" | "following">();
    expectTypeOf<AutomationExitReason>().toEqualTypeOf<"completed" | "exit" | "filter" | "stopped" | "stranded">();
  });

  it.each([
    ["running", null], ["failed", null], ["completed", "completed"], ["completed", "exit"],
    ["completed", "filter"], ["cancelled", "stopped"], ["cancelled", "stranded"],
  ] as const)("preserves %s run reasons (%s), saved rules and recorded outputs", async (status, exitReason) => {
    const run: AutomationRunDetail = {
      object: "automation_run", id: "r/1", automation_id: "a/1", status,
      exit_reason: exitReason, guards: [guard], error: status === "failed" ? "Send failed" : null,
      event: { id: "ev1", name: "user.created", email: null, payload: { isTrial: true } },
      created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:01:00Z",
      steps: [
        { key: "choose", type: "branch", status: "completed", started_at: null, completed_at: null, output: { path: "active" }, error: null },
        { key: "send", type: "send_email", status: "completed", started_at: null, completed_at: null, output: { exited: "filter", filter: "audience" }, error: null },
      ],
    };
    const client = new Dispatch({ apiKey: "sk_test" });
    const fetch = stub(run);
    const result = await client.automations.runs.get("a/1", "r/1");
    expectTypeOf(result).toEqualTypeOf<Result<AutomationRunDetail>>();
    expectTypeOf(result.data!.exit_reason).toEqualTypeOf<AutomationExitReason | null>();
    expectTypeOf(result.data!.guards).toEqualTypeOf<AutomationGuard[]>();
    expect(result.data).toEqual(run);
    expect(fetch.mock.calls[0][0]).toBe("http://localhost:3100/automations/a%2F1/runs/r%2F1");
    const listed = { object: "list", has_more: false, data: [run] };
    const listFetch = stub(listed);
    const list = await client.automations.runs.list("a/1", { status });
    expectTypeOf(list).toEqualTypeOf<Result<List<AutomationRun>>>();
    expect(list.data).toEqual(listed);
    expect(listFetch.mock.calls[0][0]).toBe(`http://localhost:3100/automations/a%2F1/runs?status=${status}`);
    stub({ ...run, guards: [] });
    expect((await client.automations.runs.get("a/1", "r/1")).data?.guards).toEqual([]);
  });

  it.each([
    ["automation.run.started", "ready", null],
    ["automation.run.failed", "failed", null],
    ...(["completed", "exit", "filter", "stopped", "stranded"] as const).map((reason) =>
      ["automation.run.completed", reason === "stopped" || reason === "stranded" ? "stopped" : "done", reason] as const),
  ] as const)("verifies %s payloads without losing exit_reason (%s, %s)", (type, state, exitReason) => {
    const data: AutomationRunEvent = {
      automation_id: "a1", run_id: "r1", contact_id: null, state, exit_reason: exitReason,
    };
    const payload = JSON.stringify({ type, data });
    const secret = `whsec_${Buffer.from("flow-contract-test-secret").toString("base64")}`;
    const signed = signWebhook(payload, [secret], "evt1");
    const event = new Dispatch({ apiKey: "sk_test" }).webhooks.verify<{ type: string; data: AutomationRunEvent }>({
      payload, headers: { id: signed.id, timestamp: String(signed.timestamp), signature: signed.signature },
      webhookSecret: secret,
    });
    expect(event).toEqual({ type, data });
    expectTypeOf(event.data.exit_reason).toEqualTypeOf<AutomationExitReason | null>();
  });
});
