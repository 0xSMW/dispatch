import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signWebhook } from "@dispatchmail/core";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { Dispatch, WebhookVerificationError, type Automation, type AutomationCreate, type AutomationDryRun, type AutomationUpdate, type AutomationStatus, type AutomationReentry, type AutomationTriggerConfig, type AutomationExitReason, type AutomationPreset, type AutomationPresetDetail, type ContactActivity, type ImportColumnMap, type List, type Operator, type PropertyType, type PropertyValue, type Result, type Rule, type SendEmailConfig, type TemplateCreate, type TemplateUpdate } from "./index.js";

const base = "http://localhost:3100";

function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers }
  });
}

function stub(body: unknown = { id: "x" }) {
  const fetch = vi.fn(async () => reply(body));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
}

function request(fetch: ReturnType<typeof stub>, index = 0) {
  const [url, init] = fetch.mock.calls[index] as unknown as [string, RequestInit];
  const headers = init.headers as Headers;
  const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
  return { url, method: init.method, headers, body };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe("automation preset library", () => {
  const preset: AutomationPreset = {
    slug: "newsletter-welcome", name: "Newsletter welcome", stage: "acquisition",
    description: "Welcome a subscriber.", when: "Start on subscription.",
    trigger_config: { type: "topic_subscribed", topic_id: "{{topic_id}}" }, reentry: "once",
    events: [{ name: "stripe.invoice.payment_failed", schema: { AMOUNT: "string", UPDATE_PAYMENT_URL: "string", invoice_id: "string" } }],
    properties: [{ key: "activated", type: "boolean" }],
    steps: [
      { key: "start", type: "trigger", config: { type: "topic_subscribed", topic_id: "{{topic_id}}" } },
      { key: "guard", type: "filter", config: { scope: "following", rule: { type: "rule", field: "event.received_at", operator: "within", value: "7 days" } } },
      { key: "send", type: "send_email", config: { template: "newsletter-welcome", kind: "marketing", variable_mapping: { camelKey: "event.AMOUNT" } } },
      { key: "active", type: "condition", config: { type: "rule", field: "contact.activated", operator: "eq", value: false } },
    ],
    connections: [{ from: "start", to: "guard", type: "default" }, { from: "active", to: "send", type: "condition_not_met" }],
    templates: ["newsletter-welcome"],
  };

  it.each([{ data: [] }, { data: [preset] }])("lists typed wire definitions without a paging query: %j", async ({ data }) => {
    const page = { object: "list", has_more: false, data };
    const fetch = stub(page);
    const result = await new Dispatch({ apiKey: "sk_test" }).templates.library.automations();
    expectTypeOf(result).toEqualTypeOf<Result<List<AutomationPreset>>>();
    expectTypeOf<NonNullable<typeof result.data>["data"][number]["trigger_config"]>().toEqualTypeOf<AutomationTriggerConfig>();
    expect(result.data).toEqual(page);
    expect(request(fetch)).toMatchObject({ method: "GET", url: `${base}/template-library/automations`, body: undefined });
  });

  it("gets a typed object envelope and encodes the entire slug as one segment", async () => {
    const detail: AutomationPresetDetail = { object: "automation_preset", ...preset };
    const fetch = stub(detail);
    const result = await new Dispatch({ apiKey: "sk_test" }).templates.library.automation("newsletter/welcome ?#%");
    expectTypeOf(result).toEqualTypeOf<Result<AutomationPresetDetail>>();
    expectTypeOf(result.data!.object).toEqualTypeOf<"automation_preset">();
    expect(result.data).toEqual(detail);
    expect(JSON.parse(JSON.stringify(result.data))).toEqual(detail);
    expect(request(fetch)).toMatchObject({
      method: "GET", url: `${base}/template-library/automations/newsletter%2Fwelcome%20%3F%23%25`, body: undefined,
    });
  });

  it("returns the existing not_found error for an unknown preset", async () => {
    globalThis.fetch = vi.fn(async () => reply({ name: "not_found", message: "Preset not found" }, { status: 404 }));
    const result = await new Dispatch({ apiKey: "sk_test" }).templates.library.automation("missing");
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ name: "not_found", statusCode: 404, message: "Preset not found" });
  });
});

describe("automation preset installation", () => {
  it.each([false, true])("posts encoded options and preserves the full aggregate (dependencies: %s)", async (dependencies) => {
    const installation = {
      automation: {
        object: "automation", id: "auto_1", name: "Welcome", status: "disabled", version: 1,
        trigger: null, trigger_config: { type: "contact_created" }, reentry: "once",
        steps: [{ key: "trigger", type: "trigger", config: { type: "contact_created" } }],
        connections: [], created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z",
      },
      templates: { created: dependencies ? [{ id: "tpl_1", slug: "welcome" }] : [], reused: dependencies ? [{ id: "tpl_2", slug: "tips" }] : [] },
      events: dependencies ? [{ id: "evt_1", name: "user.activated" }] : [],
      properties: dependencies ? [{ id: "prop_1", key: "activated", type: "boolean" }] : [],
      next_steps: ["Review the automation and its emails", "Enable the automation"], request_id: "req_install",
    };
    const fetch = stub(installation);
    const result = await new Dispatch({ apiKey: "sk_test" }).templates.library.installAutomation("onboarding/drip ?#%", {
      from: "Acme <you@acme.com>", ...(dependencies ? { name: "My onboarding", topicId: "topic_1" } : {}),
    });
    expectTypeOf(result).toEqualTypeOf<Result<import("./index.js").AutomationInstallation>>();
    expect(result.data).toEqual(installation);
    expect(JSON.parse(JSON.stringify(result.data))).toEqual(installation);
    expect(request(fetch)).toMatchObject({
      method: "POST", url: `${base}/template-library/automations/onboarding%2Fdrip%20%3F%23%25/install`,
      body: { from: "Acme <you@acme.com>", ...(dependencies ? { name: "My onboarding", topic_id: "topic_1" } : {}) },
    });
    expect(request(fetch).headers.get("authorization")).toBe("Bearer sk_test");
  });

  it.each([
    [403, "forbidden", "Access denied"], [404, "not_found", "Preset not found"],
    [409, "conflict", "Name already exists"], [422, "validation_error", "Choose a topic"],
  ])("preserves install errors (%s %s)", async (status, name, message) => {
    const body = { name, message, request_id: "req_error" };
    globalThis.fetch = vi.fn(async () => reply(body, { status: status as number, headers: { "x-request-id": "req_error" } }));
    const result = await new Dispatch({ apiKey: "sk_test" }).templates.library.installAutomation("newsletter-welcome", { from: "you@acme.com" });
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ ...body, statusCode: status });
    expect(result.headers?.["x-request-id"]).toBe("req_error");
  });

  it("keeps list event counts and nullable timestamps without requiring them in details", async () => {
    const rows: import("./index.js").Event[] = [
      { id: "evt_0", name: "never", schema: {}, fired_count: 0, last_fired_at: null },
      { id: "evt_1", name: "fired", schema: {}, fired_count: 3, last_fired_at: "2026-10-05T00:00:00Z" },
    ];
    const page = { object: "list", has_more: true, data: rows };
    const fetch = stub(page);
    const client = new Dispatch({ apiKey: "sk_test" });
    const result = await client.events.list({ after: "evt_prev", limit: 2 });
    expectTypeOf(result).toEqualTypeOf<Result<List<import("./index.js").Event>>>();
    expect(result.data).toEqual(page);
    expect(request(fetch).url).toBe(`${base}/events?after=evt_prev&limit=2`);
    const detail: import("./index.js").Event = { id: "evt_0", name: "never", schema: {} };
    stub(detail);
    expect((await client.events.get("evt_0")).data).toEqual(detail);
  });
});

describe("constructor", () => {
  it("reads the key, base URL, and user agent from options or the environment", async () => {
    vi.stubEnv("DISPATCH_API_KEY", "sk_env");
    vi.stubEnv("DISPATCH_BASE_URL", "https://mail.example.com/");
    const fetch = stub();
    await new Dispatch().emails.get("email_1");
    const sent = request(fetch);
    expect(sent.url).toBe("https://mail.example.com/emails/email_1");
    expect(sent.headers.get("authorization")).toBe("Bearer sk_env");
    expect(sent.headers.get("user-agent")).toBe("dispatch-node:0.1.0");
  });

  it("throws when no key is available", () => {
    vi.stubEnv("DISPATCH_API_KEY", "");
    expect(() => new Dispatch()).toThrow("Missing API key");
  });
});

describe("transport", () => {
  it.each(["completed", "exit", "filter", "stopped", "stranded", null, undefined] as const)("preserves nullable/legacy contact activity exit_reason %s", async (exit_reason) => {
    const activity: ContactActivity = {
      object: "contact_activity", id: "run_1:completed", type: "automation.run.completed",
      resource_id: "run_1", label: "done", email_id: null, automation_id: "a/1",
      run_id: "run_1", created_at: "2026-10-04T00:00:00Z",
      ...(exit_reason === undefined ? {} : { exit_reason }),
    };
    const page = { object: "list", has_more: true, data: [activity] };
    const fetch = stub(page);
    const result = await new Dispatch({ apiKey: "sk_test" }).contacts.activity("c/1", { after: "run_0:completed", limit: 5 });
    expectTypeOf(result.data!.data[0]!.exit_reason).toEqualTypeOf<AutomationExitReason | null | undefined>();
    expect(result.data).toEqual(page);
    expect(JSON.parse(JSON.stringify(result.data))).toEqual(page);
    expect(request(fetch).url).toBe(`${base}/contacts/c%2F1/activity?after=run_0%3Acompleted&limit=5`);
  });

  it.each([
    { stranded_runs: 3, by_step: { removed: 2, "send/email": 1 } },
    { stranded_runs: 0, by_step: {} },
  ])("previews the ordinary automation update body with a distinct typed response: %j", async (preview) => {
    const client = new Dispatch({ apiKey: "sk_test" });
    const payload: AutomationUpdate = {
      name: "Edited", reentry: "once",
      steps: [
        { key: "start", type: "trigger", config: { type: "contact_updated", field: "activated", from: false, to: true } },
        { key: "send", type: "send_email", config: { template: "welcome", variables: { camelKey: "literal" } } },
      ],
      connections: [{ from: "start", to: "send", type: "default" }],
    };
    const fetch = stub(preview);
    const result = await client.automations.dryRun("a/1", payload);
    expectTypeOf(result).toEqualTypeOf<Result<AutomationDryRun>>();
    expectTypeOf(result.data!.by_step).toEqualTypeOf<Record<string, number>>();
    expect(result.data).toEqual(preview);
    expect(request(fetch)).toMatchObject({
      method: "PATCH", url: `${base}/automations/a%2F1?dry_run=true`, body: payload,
    });
    await client.automations.update("a/1", payload);
    expect(request(fetch, 1)).toMatchObject({
      method: "PATCH", url: `${base}/automations/a%2F1`, body: payload,
    });
    expectTypeOf<Awaited<ReturnType<typeof client.automations.update>>>().toEqualTypeOf<Result<Automation>>();
  });

  it.each([403, 409, 422])("preserves automation dry-run permission and validation errors (%s)", async (status) => {
    const error = { name: status === 409 ? "conflict" : status === 403 ? "forbidden" : "validation_error", statusCode: status, message: "Cannot save this graph" };
    globalThis.fetch = vi.fn(async () => reply(error, { status })) as never;
    const result = await new Dispatch({ apiKey: "sk_test" }).automations.dryRun("a1", { steps: [] });
    expect(result.data).toBeNull();
    expect(result.error).toEqual(error);
  });

  it("preserves pause statuses and graph versions without widening creation choices", async () => {
    expectTypeOf<AutomationCreate["status"]>().toEqualTypeOf<"enabled" | "disabled" | undefined>();
    expectTypeOf<AutomationUpdate["status"]>().toEqualTypeOf<AutomationStatus | undefined>();
    expectTypeOf<AutomationCreate["version"]>().toEqualTypeOf<undefined>();
    expectTypeOf<AutomationUpdate["version"]>().toEqualTypeOf<undefined>();
    const client = new Dispatch({ apiKey: "sk_test" });
    for (const status of ["enabled", "paused", "disabled"] as const) {
      const automation: Automation = {
        id: "a/1", status, version: 4, trigger: null,
        trigger_config: { type: "contact_created" }, reentry: "once",
      };
      const fetch = stub(automation);
      const updated = await client.automations.update("a/1", { status });
      expect(request(fetch)).toMatchObject({
        method: "PATCH", url: `${base}/automations/a%2F1`, body: { status },
      });
      expect(updated.data).toEqual(automation);
      expectTypeOf(updated.data!.status).toEqualTypeOf<AutomationStatus>();
      expectTypeOf(updated.data!.version).toEqualTypeOf<number>();
      expect((await client.automations.get("a/1")).data).toEqual(automation);
      const listFetch = stub({ object: "list", has_more: false, data: [automation] });
      const listed = await client.automations.list({ status });
      expect(request(listFetch).url).toBe(`${base}/automations?status=${status}`);
      expect(listed.data?.data[0]).toEqual(automation);
    }
    for (const enabled of [false, true]) {
      const fetch = stub();
      await client.automations.update("a/1", { enabled });
      expect(request(fetch).body).toEqual({ enabled });
      await client.automations.create({ name: "Legacy", steps: [], enabled });
      expect(request(fetch, 1).body).toEqual({ name: "Legacy", steps: [], enabled });
    }
    const fetch = vi.fn(async () => reply({ name: "conflict", message: "Disabled cannot pause" }, { status: 409 }));
    globalThis.fetch = fetch as never;
    expect((await client.automations.update("a1", { status: "paused" })).error).toMatchObject({ name: "conflict", statusCode: 409 });
  });

  it("creates, retrieves, and cancels typed enrollment jobs without altering their counts", async () => {
    const job = {
      object: "automation_enrollment_job", id: "j/1", automation_id: "a/1", segment_id: null,
      status: "queued", counts: { total: 501, processed: 0, enrolled: 0, skipped: 0, failed: 0 },
      error: null, created_at: "2026-10-03T00:00:00Z", completed_at: null,
    };
    const fetch = vi.fn(async () => reply(job, { status: 202 }));
    globalThis.fetch = fetch as never;
    const client = new Dispatch({ apiKey: "sk_test" });
    const created = await client.automations.enroll("a/1", { all: true }, { idempotencyKey: "enroll-retry" });
    expect(created.data).toEqual(job);
    expectTypeOf(created.data!.counts.enrolled).toEqualTypeOf<number>();
    expectTypeOf(created.data!.segment_id).toEqualTypeOf<string | null>();
    expect(request(fetch as never).body).toEqual({ all: true });
    expect(request(fetch as never).url).toBe(`${base}/automations/a%2F1/enroll`);
    expect(request(fetch as never).headers.get("idempotency-key")).toBe("enroll-retry");
    await client.automations.enroll("a/1", { segmentId: "s/1" });
    expect(request(fetch as never, 1).body).toEqual({ segment_id: "s/1" });
    expect((await client.automations.getEnrollmentJob("a/1", "j/1")).data).toEqual(job);
    expect(request(fetch as never, 2)).toMatchObject({
      method: "GET", url: `${base}/automations/a%2F1/enroll-jobs/j%2F1`, body: undefined,
    });
    stub({ ...job, status: "cancelled" });
    expect((await client.automations.cancelEnrollmentJob("a/1", "j/1")).data?.status).toBe("cancelled");
  });

  it("cancels a contact import using DELETE and returns its state", async () => {
    const imported = { object: "contact_import", id: "i/1", status: "cancelled", trigger_automations: true };
    const fetch = stub(imported);
    const result = await new Dispatch({ apiKey: "sk_test" }).contacts.imports.cancel("i/1");
    expect(result.data).toEqual(imported);
    expect(request(fetch)).toMatchObject({ method: "DELETE", url: `${base}/contacts/imports/i%2F1`, body: undefined });
  });
  it.each([undefined, false, true])("preserves the optional stop reset flag: %s", async (resetReentry) => {
    const fetch = stub({ object: "automation", id: "a1", stopped: 2 });
    const client = new Dispatch({ apiKey: "sk_test" });
    const result = resetReentry === undefined
      ? await client.automations.stop("a/1")
      : await client.automations.stop("a/1", { resetReentry });
    const sent = request(fetch);
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(`${base}/automations/a%2F1/stop`);
    expect(sent.body).toEqual(resetReentry === undefined ? {} : { reset_reentry: resetReentry });
    expect(result.data?.stopped).toBe(2);
  });

  it("preserves contact trigger configs, primitive transitions, and reentry", async () => {
    const configs: AutomationTriggerConfig[] = [
      { type: "event", event_name: "user.created" },
      { type: "contact_created" },
      { type: "contact_updated" },
      { type: "contact_updated", field: "unsubscribed", from: false, to: true },
      { type: "contact_updated", field: "properties.score", from: 0, to: 42.5 },
      { type: "contact_updated", field: "properties.last_active_at", from: null, to: "2026-10-03T09:30:00+02:00" },
      { type: "contact_updated", field: "first_name", from: "Ada", to: null },
      { type: "topic_subscribed", topic_id: "topic_1" },
      { type: "segment_added", segment_id: "segment_1" },
    ];
    const client = new Dispatch({ apiKey: "sk_test" });
    for (const config of configs) {
      const automation: Automation = { id: "a1", status: "disabled", version: 0, trigger: config.type === "event" ? config.event_name : null, trigger_config: config, reentry: "every_time" };
      const fetch = stub(automation);
      const steps = [{ key: "start", type: "trigger", config }];
      const created = await client.automations.create({ name: "Contacts", steps, reentry: "every_time" });
      expectTypeOf(created.data!.trigger).toEqualTypeOf<string | null>();
      expectTypeOf(created.data!.trigger_config).toEqualTypeOf<AutomationTriggerConfig>();
      expectTypeOf(created.data!.reentry).toEqualTypeOf<AutomationReentry>();
      expect(created.data).toEqual(automation);
      expect(request(fetch).body).toEqual({ name: "Contacts", steps, reentry: "every_time" });
      await client.automations.update("a1", { steps, reentry: "once" });
      expect(request(fetch, 1).body).toEqual({ steps, reentry: "once" });
      expect((await client.automations.get("a1")).data).toEqual(automation);
      expect((await client.automations.duplicate("a1")).data).toEqual(automation);
      stub({ object: "list", has_more: false, data: [automation] });
      const list = await client.automations.list();
      expectTypeOf(list.data!.data[0]!.trigger).toEqualTypeOf<string | null>();
      expect(list.data?.data[0]).toEqual(automation);
    }
    const fetch = stub();
    const steps = [{ key: "start", type: "trigger", config: { event_name: "user.created" } }];
    await client.automations.create({ name: "Legacy", trigger: "user.created", steps });
    expect(request(fetch).body).toEqual({ name: "Legacy", trigger: "user.created", steps });
  });

  it("preserves typed property fallbacks, date imports, rules, and literal send mappings", async () => {
    const fetch = stub({ id: "prop_1", object: "contact_property", key: "activated", type: "boolean", fallback_value: false });
    const client = new Dispatch({ apiKey: "sk_test" });
    const created = await client.contactProperties.create({ key: "activated", type: "boolean", fallbackValue: false });
    expectTypeOf(created.data!.type).toEqualTypeOf<PropertyType>();
    expectTypeOf(created.data!.fallback_value).toEqualTypeOf<PropertyValue>();
    expect(request(fetch).body).toEqual({ key: "activated", type: "boolean", fallback_value: false });
    await client.contactProperties.update({ id: "prop_1", fallbackValue: null });
    expect(request(fetch, 1).body).toEqual({ fallback_value: null });
    await client.contactProperties.create({ key: "last_active_at", type: "date", fallbackValue: "2026-10-03T09:30:00+02:00" });
    expect(request(fetch, 2).body.fallback_value).toBe("2026-10-03T09:30:00+02:00");

    const columnMap: ImportColumnMap = { properties: { last_active_at: { column: "Last active", type: "date" } } };
    await client.contacts.imports.create({ file: "email,Last active\na@example.com,2026-10-03\n", columnMap });
    const form = request(fetch, 3).body as FormData;
    expect(JSON.parse(String(form.get("column_map")))).toEqual(columnMap);

    const config: SendEmailConfig = { template: { id: "template_1", variables: { PLAN: "contact.plan", camelKey: false } }, variable_mapping: { PLAN: "contact.plan", WHEN: "event.received_at" } };
    const rule: Rule = { type: "rule", field: "event.received_at", operator: "within", value: "2 days" };
    expectTypeOf<Operator>().extract<"not_contains" | "within" | "not_within">().toEqualTypeOf<"not_contains" | "within" | "not_within">();
    await client.automations.create({ name: "Typed", steps: [{ key: "send", type: "send_email", config }, { key: "condition", type: "condition", config: rule }] });
    expect(request(fetch, 4).body.steps).toEqual([{ key: "send", type: "send_email", config }, { key: "condition", type: "condition", config: rule }]);
  });

  it("exposes typed sandbox flags on send, batch, list, and mixed detail responses", async () => {
    const client = new Dispatch({ apiKey: "sk_test" });
    const sent = { id: "email_1", sandbox: true };
    stub(sent);
    const send = await client.emails.send({ from: "a@acme.com", to: "test@example.com", text: "Hi", subject: "Test" });
    expectTypeOf(send.data!.sandbox).toEqualTypeOf<boolean>();
    expect(send.data).toEqual(sent);
    stub({ data: [sent] });
    expect((await client.batch.send([{ from: "a@acme.com", to: "test@example.com", text: "Hi", subject: "Test" }])).data?.data[0]?.sandbox).toBe(true);
    const email = { object: "email", id: "email_1", sandbox: true, last_event: "delivered", recipients: [{ email: "test@example.com", kind: "to", status: "delivered", sandbox: true }] };
    stub({ object: "list", has_more: false, data: [email] });
    const page = await client.emails.list();
    expectTypeOf(page.data!.data[0]!.sandbox).toEqualTypeOf<boolean>();
    expectTypeOf(page.data!.data[0]!.recipients[0]!.sandbox).toEqualTypeOf<boolean>();
    expect(page.data?.data[0]).toEqual(email);

    const recipients = [
      { id: "rcpt_1", email: "test@example.com", kind: "cc", sandbox: true, status: "delivered", created_at: "2026-10-03T10:00:00Z" },
      { id: "rcpt_2", email: "ada@acme.com", kind: "to", sandbox: false, status: "delivered", created_at: "2026-10-03T10:00:00Z" },
    ];
    stub({ ...email, sandbox: false, recipients });
    const detail = await client.emails.get("email_1");
    expectTypeOf(detail.data!.recipients[0]!.sandbox).toEqualTypeOf<boolean>();
    expect(detail.data?.sandbox).toBe(false);
    expect(detail.data?.recipients).toEqual(recipients);
    expect(detail.data?.last_event).toBe("delivered");
  });

  it("forwards automation and step metric filters", async () => {
    const fetch = stub({ object: "metrics", data: [] });
    await new Dispatch({ apiKey: "sk_test" }).emails.metrics({ dimensions: ["step"], automationId: ["automation_1"] });
    const url = new URL(request(fetch).url);
    expect(url.searchParams.get("dimensions")).toBe("step");
    expect(url.searchParams.get("automation_id")).toBe("automation_1");
  });

  it("preserves recipient-specific marketing results on single and batch sends", async () => {
    const result = { id: "email_1", sandbox: true, emails: [{ id: "email_1", to: "ada@example.com", sandbox: true }, { id: "email_2", to: "bob@dispatch-fixture.net", sandbox: false }] };
    stub(result);
    const client = new Dispatch({ apiKey: "sk_test" });
    const body = { from: "a@example.com", to: ["ada@example.com", "bob@dispatch-fixture.net"], subject: "News", text: "Hi", topicId: "topic_1" };
    const sent = await client.emails.send(body);
    expectTypeOf(sent.data!.emails![0]!.sandbox).toEqualTypeOf<boolean>();
    expect(sent.data?.emails).toEqual(result.emails);
    stub({ data: [result] });
    expect((await client.batch.send([body])).data?.data[0]?.emails).toEqual(result.emails);
  });

  it("returns data, a null error, and the response headers", async () => {
    globalThis.fetch = vi.fn(async () => reply({ id: "email_1" }, { headers: { "x-request-id": "req_1" } })) as never;
    const result = await new Dispatch({ apiKey: "sk_test" }).emails.send({ from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Yo" });
    expect(result).toMatchObject({ data: { id: "email_1" }, error: null });
    expect(result.headers?.["x-request-id"]).toBe("req_1");
  });

  it("returns the API error without throwing", async () => {
    globalThis.fetch = vi.fn(async () =>
      reply({ name: "validation_error", statusCode: 422, message: "Invalid `to` field.", request_id: "req_2" }, { status: 422 })
    ) as never;
    const result = await new Dispatch({ apiKey: "sk_test" }).domains.get("domain_1");
    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ name: "validation_error", statusCode: 422, message: "Invalid `to` field." });
    expect(result.headers).not.toBeNull();
  });

  it("fills in an error body when the response is not JSON", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" })) as never;
    const result = await new Dispatch({ apiKey: "sk_test" }).logs.list();
    expect(result.error).toEqual({ name: "application_error", statusCode: 502, message: "Bad Gateway" });
  });

  it("turns a network failure into application_error with a null status", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as never;
    const result = await new Dispatch({ apiKey: "sk_test" }).emails.list();
    expect(result).toEqual({
      data: null,
      error: { name: "application_error", statusCode: null, message: "Unable to fetch data. The request could not be resolved." },
      headers: null
    });
  });

  it("sends the idempotency key on emails.send", async () => {
    const fetch = stub({ id: "email_1" });
    await new Dispatch({ apiKey: "sk_test" }).emails.send(
      { from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Yo" },
      { idempotencyKey: "idem-1" }
    );
    expect(request(fetch).headers.get("idempotency-key")).toBe("idem-1");
  });

  it("sends the idempotency key and validation mode on batch.send", async () => {
    const fetch = stub({ data: [{ id: "email_1" }] });
    await new Dispatch({ apiKey: "sk_test" }).batch.send(
      [{ from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Yo", scheduledAt: "in 1 hour" }],
      { idempotencyKey: "idem-2", batchValidation: "permissive" }
    );
    const sent = request(fetch);
    expect(sent.url).toBe(`${base}/emails/batch`);
    expect(sent.headers.get("idempotency-key")).toBe("idem-2");
    expect(sent.headers.get("x-batch-validation")).toBe("permissive");
    expect(sent.body).toEqual([{ from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Yo", scheduled_at: "in 1 hour" }]);
  });

  it("calls /health without authorization, and /setup with the key that production needs", async () => {
    const fetch = stub({ ok: true });
    const client = new Dispatch({ apiKey: "sk_test" });
    await client.health();
    await client.setup.get();
    expect(request(fetch, 0).headers.get("authorization")).toBeNull();
    expect(request(fetch, 1).url).toBe(`${base}/setup`);
    expect(request(fetch, 1).headers.get("authorization")).toBe("Bearer sk_test");
  });

  it("does not spread a string error body into numbered keys", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify("oops"), { status: 500, statusText: "Internal Server Error" })) as never;
    const result = await new Dispatch({ apiKey: "sk_test" }).logs.list();
    expect(result.error).toEqual({ name: "application_error", statusCode: 500, message: "Internal Server Error" });
  });
});

describe("template tracking", () => {
  const createCases: Array<{ tracking: string; input: TemplateCreate; body: { name: string; track?: boolean } }> = [
    { tracking: "true", input: { name: "Welcome", track: true }, body: { name: "Welcome", track: true } },
    { tracking: "false", input: { name: "Welcome", track: false }, body: { name: "Welcome", track: false } },
    { tracking: "omitted", input: { name: "Welcome" }, body: { name: "Welcome" } }
  ];
  const updateCases: Array<{ tracking: string; input: TemplateUpdate; body: { subject: string; track?: boolean } }> = [
    { tracking: "true", input: { subject: "Welcome back", track: true }, body: { subject: "Welcome back", track: true } },
    { tracking: "false", input: { subject: "Welcome back", track: false }, body: { subject: "Welcome back", track: false } },
    { tracking: "omitted", input: { subject: "Welcome back" }, body: { subject: "Welcome back" } }
  ];

  it.each(createCases)("preserves $tracking tracking in template create request JSON", async ({ input, body }) => {
    const fetch = stub({ id: "template_1" });
    await new Dispatch({ apiKey: "sk_test" }).templates.create(input);
    const sent = request(fetch);
    expect(sent.url).toBe(`${base}/templates`);
    expect(sent.method).toBe("POST");
    expect(sent.body).toEqual(body);
    expect(Object.hasOwn(sent.body, "track")).toBe(Object.hasOwn(body, "track"));
  });

  it.each(updateCases)("preserves $tracking tracking in template update request JSON", async ({ input, body }) => {
    const fetch = stub({ id: "template_1" });
    await new Dispatch({ apiKey: "sk_test" }).templates.update("welcome", input);
    const sent = request(fetch);
    expect(sent.url).toBe(`${base}/templates/welcome`);
    expect(sent.method).toBe("PATCH");
    expect(sent.body).toEqual(body);
    expect(Object.hasOwn(sent.body, "track")).toBe(Object.hasOwn(body, "track"));
  });
});

describe("camelCase inputs", () => {
  it("maps top-level and attachment keys to snake_case and leaves user data alone", async () => {
    const fetch = stub({ id: "email_1" });
    await new Dispatch({ apiKey: "sk_test" }).emails.send({
      from: "Acme <hello@example.com>",
      to: ["b@example.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      replyTo: "help@example.com",
      scheduledAt: "tomorrow at 9am",
      topicId: "topic_1",
      variables: { firstName: "Ada" },
      headers: { "X-Entity-Ref-ID": "123" },
      attachments: [{ filename: "a.png", content: "aGk=", contentType: "image/png", contentId: "logo" }]
    });
    expect(request(fetch).body).toEqual({
      from: "Acme <hello@example.com>",
      to: ["b@example.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      reply_to: "help@example.com",
      scheduled_at: "tomorrow at 9am",
      topic_id: "topic_1",
      variables: { firstName: "Ada" },
      headers: { "X-Entity-Ref-ID": "123" },
      attachments: [{ filename: "a.png", content: "aGk=", content_type: "image/png", content_id: "logo" }]
    });
  });

  it("maps the keys of template variable declarations, so a fallback is not dropped", async () => {
    const fetch = stub({ id: "template_1" });
    const client = new Dispatch({ apiKey: "sk_test" });
    await client.templates.create({
      name: "Welcome",
      html: "<p>{{{NAME}}}</p>",
      variables: [{ key: "NAME", type: "string", fallbackValue: "there" }, "PLAN"]
    } as never);
    expect((request(fetch).body as { variables: unknown }).variables).toEqual([{ key: "NAME", type: "string", fallback_value: "there" }, "PLAN"]);
    await client.templates.update("welcome", { variables: [{ key: "NAME", fallbackValue: null }] } as never);
    expect((request(fetch, 1).body as { variables: unknown }).variables).toEqual([{ key: "NAME", fallback_value: null }]);
  });

  it("reaches the newer routes: audience, run metrics, a draft render, and list filters", async () => {
    const fetch = stub({ object: "list", has_more: false, data: [] });
    const client = new Dispatch({ apiKey: "sk_test" });
    await client.broadcasts.audience("b_1");
    await client.automations.runs.metrics("a_1", { startDate: "2026-10-01" });
    await client.templates.render("welcome", { NAME: "Ada" }, { draft: true });
    await client.templates.list({ q: "wel", status: "draft" });
    await client.contacts.list({ q: "ada", subscribed: false });
    await client.logs.list({ emailId: "email_1" });
    await client.automations.duplicate("a_1", { name: "Copy" });
    await client.apiKeys.get("key_1");
    expect(request(fetch, 0).url).toBe(`${base}/broadcasts/b_1/audience`);
    expect(request(fetch, 1).url).toBe(`${base}/automations/a_1/runs/metrics?start_date=2026-10-01`);
    expect(request(fetch, 2).body).toEqual({ variables: { NAME: "Ada" }, draft: true });
    expect(request(fetch, 3).url).toBe(`${base}/templates?q=wel&status=draft`);
    expect(request(fetch, 4).url).toBe(`${base}/contacts?q=ada&subscribed=false`);
    expect(request(fetch, 5).url).toBe(`${base}/logs?email_id=email_1`);
    expect(request(fetch, 6).body).toEqual({ name: "Copy" });
    expect(request(fetch, 7).url).toBe(`${base}/api-keys/key_1`);
  });

  it("maps list filters to snake_case query parameters", async () => {
    const fetch = stub({ object: "list", has_more: false, data: [] });
    const client = new Dispatch({ apiKey: "sk_test" });
    await client.emails.metrics({ startDate: "2026-07-01", metrics: ["sent", "open_rate"], domainId: ["d1", "d2"] });
    await client.broadcasts.recipients("b_1", { type: "bounced", bounceType: "Permanent", limit: 10, after: "r_1" });
    await client.logs.list({ status: "4xx", from: "2026-09-01", to: "2026-09-30" });
    expect(request(fetch, 0).url).toBe(`${base}/emails/metrics?start_date=2026-07-01&metrics=sent&metrics=open_rate&domain_id=d1&domain_id=d2`);
    expect(request(fetch, 1).url).toBe(`${base}/broadcasts/b_1/recipients?type=bounced&bounce_type=Permanent&limit=10&after=r_1`);
    expect(request(fetch, 2).url).toBe(`${base}/logs?status=4xx&start_date=2026-09-01&end_date=2026-09-30`);
  });
});

type Case = [string, (client: Dispatch) => Promise<Result<unknown>>, string, string, unknown?];

const cases: Case[] = [
  ["emails.create", (c) => c.emails.create({ from: "a@x.com", to: "b@x.com", subject: "S", text: "T" }), "POST", "/emails"],
  ["emails.list", (c) => c.emails.list({ limit: 5, status: "bounced" }), "GET", "/emails?limit=5&status=bounced"],
  ["emails.update", (c) => c.emails.update({ id: "e1", scheduledAt: "in 1 hour" }), "PATCH", "/emails/e1", { scheduled_at: "in 1 hour" }],
  ["emails.cancel", (c) => c.emails.cancel("e1"), "POST", "/emails/e1/cancel"],
  ["emails.share", (c) => c.emails.share("e1", { expiresIn: "10m" }), "POST", "/emails/e1/share", { expires_in: "10m" }],
  ["emails.retry", (c) => c.emails.retry("e1"), "POST", "/emails/e1/retry"],
  ["emails.events", (c) => c.emails.events("e1", { limit: 2 }), "GET", "/emails/e1/events?limit=2"],
  ["emails.jobs.list", (c) => c.emails.jobs.list({ email_id: "e1" }), "GET", "/email-jobs?email_id=e1"],
  ["emails.jobs.get", (c) => c.emails.jobs.get("job_1"), "GET", "/email-jobs/job_1"],
  ["emails.attachments.list", (c) => c.emails.attachments.list({ emailId: "e1", limit: 3 }), "GET", "/emails/e1/attachments?limit=3"],
  ["emails.attachments.get", (c) => c.emails.attachments.get({ emailId: "e1", id: "att_1" }), "GET", "/emails/e1/attachments/att_1"],
  ["emails.receiving.list", (c) => c.emails.receiving.list(), "GET", "/emails/receiving"],
  ["emails.receiving.get", (c) => c.emails.receiving.get("r1", { htmlFormat: "cid" }), "GET", "/emails/receiving/r1?html_format=cid"],
  ["emails.receiving.simulate", (c) => c.emails.receiving.simulate({ from: "a@x.com", to: "b@x.com", subject: "S", text: "T" }), "POST", "/emails/receiving/simulate"],
  ["emails.receiving.attachments.list", (c) => c.emails.receiving.attachments.list({ emailId: "r1" }), "GET", "/emails/receiving/r1/attachments"],
  ["emails.receiving.attachments.get", (c) => c.emails.receiving.attachments.get({ emailId: "r1", id: "a1" }), "GET", "/emails/receiving/r1/attachments/a1"],
  ["domains.create", (c) => c.domains.create({ name: "example.com", customReturnPath: "bounce", openTracking: true }), "POST", "/domains", { name: "example.com", custom_return_path: "bounce", open_tracking: true }],
  ["domains.list", (c) => c.domains.list(), "GET", "/domains"],
  ["domains.update", (c) => c.domains.update({ id: "d1", clickTracking: true, tls: "enforced" }), "PATCH", "/domains/d1", { click_tracking: true, tls: "enforced" }],
  ["domains.remove", (c) => c.domains.remove("d1"), "DELETE", "/domains/d1"],
  ["domains.verify", (c) => c.domains.verify("d1"), "POST", "/domains/d1/verify"],
  ["domains.doctor", (c) => c.domains.doctor("d1"), "GET", "/domains/d1/doctor"],
  ["domains.publishRoute53", (c) => c.domains.publishRoute53("d1"), "POST", "/domains/d1/publish-route53"],
  ["apiKeys.create", (c) => c.apiKeys.create({ name: "ci", permission: "sending_access", domainId: "d1" }), "POST", "/api-keys", { name: "ci", permission: "sending_access", domain_id: "d1" }],
  ["apiKeys.list", (c) => c.apiKeys.list(), "GET", "/api-keys"],
  ["apiKeys.update", (c) => c.apiKeys.update("k1", { name: "renamed" }), "PATCH", "/api-keys/k1", { name: "renamed" }],
  ["apiKeys.remove", (c) => c.apiKeys.remove("k1"), "DELETE", "/api-keys/k1"],
  ["webhooks.create", (c) => c.webhooks.create({ endpoint: "https://x.com/h", events: ["all"] }), "POST", "/webhooks", { endpoint: "https://x.com/h", events: ["all"] }],
  ["webhooks.get", (c) => c.webhooks.get("w1"), "GET", "/webhooks/w1"],
  ["webhooks.list", (c) => c.webhooks.list(), "GET", "/webhooks"],
  ["webhooks.update", (c) => c.webhooks.update("w1", { status: "disabled" }), "PATCH", "/webhooks/w1", { status: "disabled" }],
  ["webhooks.remove", (c) => c.webhooks.remove("w1"), "DELETE", "/webhooks/w1"],
  ["webhooks.rotateSigningSecret", (c) => c.webhooks.rotateSigningSecret("w1"), "POST", "/webhooks/w1/signing-secret/rotate"],
  ["webhooks.test", (c) => c.webhooks.test(), "POST", "/webhooks/test"],
  ["webhooks.events.list", (c) => c.webhooks.events.list("w1", { after: "ev_1" }), "GET", "/webhooks/w1/events?after=ev_1"],
  ["webhooks.events.get", (c) => c.webhooks.events.get("w1", "ev_1"), "GET", "/webhooks/w1/events/ev_1"],
  ["webhooks.events.attempts", (c) => c.webhooks.events.attempts("w1", "ev_1"), "GET", "/webhooks/w1/events/ev_1/attempts"],
  ["webhooks.events.replay", (c) => c.webhooks.events.replay("w1", "ev_1"), "POST", "/webhooks/w1/events/ev_1/replay"],
  ["templates.get", (c) => c.templates.get("welcome"), "GET", "/templates/welcome"],
  ["templates.list", (c) => c.templates.list({ limit: 2 }), "GET", "/templates?limit=2"],
  ["templates.update", (c) => c.templates.update("welcome", { replyTo: "help@x.com" }), "PATCH", "/templates/welcome", { reply_to: "help@x.com" }],
  ["templates.remove", (c) => c.templates.remove("welcome"), "DELETE", "/templates/welcome"],
  ["templates.publish", (c) => c.templates.publish("welcome", { versionId: "v1" }), "POST", "/templates/welcome/publish", { version_id: "v1" }],
  ["templates.duplicate", (c) => c.templates.duplicate("welcome"), "POST", "/templates/welcome/duplicate", {}],
  ["templates.render", (c) => c.templates.render("welcome", { NAME: "Ada" }), "POST", "/templates/welcome/render", { variables: { NAME: "Ada" } }],
  ["templates.versions.list", (c) => c.templates.versions.list("welcome"), "GET", "/templates/welcome/versions"],
  ["templates.versions.create", (c) => c.templates.versions.create("welcome", { subject: "Hi" }), "POST", "/templates/welcome/versions", { subject: "Hi" }],
  ["templates.library.list", (c) => c.templates.library.list(), "GET", "/template-library"],
  ["templates.library.get", (c) => c.templates.library.get("password-reset"), "GET", "/template-library/password-reset"],
  ["templates.library.install", (c) => c.templates.library.install("password-reset"), "POST", "/template-library/password-reset/install", {}],
  ["contacts.create", (c) => c.contacts.create({ email: "ada@x.com", firstName: "Ada", segments: [{ id: "s1" }] }), "POST", "/contacts", { email: "ada@x.com", first_name: "Ada", segments: [{ id: "s1" }] }],
  ["contacts.list", (c) => c.contacts.list({ segment_id: "s1" }), "GET", "/contacts?segment_id=s1"],
  ["contacts.get", (c) => c.contacts.get("ada@x.com"), "GET", "/contacts/ada%40x.com"],
  ["contacts.update", (c) => c.contacts.update({ email: "ada@x.com", lastName: "Lovelace", properties: { planTier: "pro" } }), "PATCH", "/contacts/ada%40x.com", { last_name: "Lovelace", properties: { planTier: "pro" } }],
  ["contacts.remove", (c) => c.contacts.remove("c1"), "DELETE", "/contacts/c1"],
  ["contacts.activity", (c) => c.contacts.activity("c1", { limit: 5 }), "GET", "/contacts/c1/activity?limit=5"],
  ["contacts.segments.list", (c) => c.contacts.segments.list({ contactId: "c1" }), "GET", "/contacts/c1/segments"],
  ["contacts.segments.add", (c) => c.contacts.segments.add({ contactId: "c1", segmentId: "s1" }), "POST", "/contacts/c1/segments/s1"],
  ["contacts.segments.remove", (c) => c.contacts.segments.remove({ email: "ada@x.com", segmentId: "s1" }), "DELETE", "/contacts/ada%40x.com/segments/s1"],
  ["contacts.topics.list", (c) => c.contacts.topics.list({ id: "c1" }), "GET", "/contacts/c1/topics"],
  ["contacts.topics.update", (c) => c.contacts.topics.update({ id: "c1", topics: [{ id: "t1", subscription: "opt_out" }] }), "PATCH", "/contacts/c1/topics", { topics: [{ id: "t1", subscription: "opt_out" }] }],
  ["contacts.imports.list", (c) => c.contacts.imports.list({ status: "completed" }), "GET", "/contacts/imports?status=completed"],
  ["contacts.imports.get", (c) => c.contacts.imports.get("imp_1"), "GET", "/contacts/imports/imp_1"],
  ["contactProperties.create", (c) => c.contactProperties.create({ key: "plan", type: "string", fallbackValue: "free" }), "POST", "/contact-properties", { key: "plan", type: "string", fallback_value: "free" }],
  ["contactProperties.list", (c) => c.contactProperties.list(), "GET", "/contact-properties"],
  ["contactProperties.get", (c) => c.contactProperties.get("p1"), "GET", "/contact-properties/p1"],
  ["contactProperties.update", (c) => c.contactProperties.update({ id: "p1", fallbackValue: "trial" }), "PATCH", "/contact-properties/p1", { fallback_value: "trial" }],
  ["contactProperties.remove", (c) => c.contactProperties.remove("p1"), "DELETE", "/contact-properties/p1"],
  ["segments.create", (c) => c.segments.create({ name: "VIP" }), "POST", "/segments", { name: "VIP" }],
  ["segments.list", (c) => c.segments.list(), "GET", "/segments"],
  ["segments.get", (c) => c.segments.get("s1"), "GET", "/segments/s1"],
  ["segments.update", (c) => c.segments.update("s1", { name: "VIPs" }), "PATCH", "/segments/s1", { name: "VIPs" }],
  ["segments.remove", (c) => c.segments.remove("s1"), "DELETE", "/segments/s1"],
  ["segments.contacts", (c) => c.segments.contacts("s1", { limit: 1 }), "GET", "/segments/s1/contacts?limit=1"],
  ["topics.create", (c) => c.topics.create({ name: "News", defaultSubscription: "opt_out" }), "POST", "/topics", { name: "News", default_subscription: "opt_out" }],
  ["topics.list", (c) => c.topics.list(), "GET", "/topics"],
  ["topics.get", (c) => c.topics.get("t1"), "GET", "/topics/t1"],
  ["topics.update", (c) => c.topics.update({ id: "t1", visibility: "public" }), "PATCH", "/topics/t1", { visibility: "public" }],
  ["topics.remove", (c) => c.topics.remove("t1"), "DELETE", "/topics/t1"],
  ["suppressions.add", (c) => c.suppressions.add({ email: "x@x.com" }), "POST", "/suppressions", { email: "x@x.com" }],
  ["suppressions.list", (c) => c.suppressions.list({ origin: "bounce" }), "GET", "/suppressions?origin=bounce"],
  ["suppressions.get", (c) => c.suppressions.get("x@x.com"), "GET", "/suppressions/x%40x.com"],
  ["suppressions.remove", (c) => c.suppressions.remove("sup_1"), "DELETE", "/suppressions/sup_1"],
  ["suppressions.batchAdd", (c) => c.suppressions.batchAdd(["a@x.com", "b@x.com"]), "POST", "/suppressions/batch/add", { emails: ["a@x.com", "b@x.com"] }],
  ["suppressions.batchRemove", (c) => c.suppressions.batchRemove({ ids: ["sup_1"] }), "POST", "/suppressions/batch/remove", { ids: ["sup_1"] }],
  ["broadcasts.create", (c) => c.broadcasts.create({ name: "News", from: "a@x.com", subject: "S", html: "<p/>", segmentId: "s1", previewText: "P" }), "POST", "/broadcasts", { name: "News", from: "a@x.com", subject: "S", html: "<p/>", segment_id: "s1", preview_text: "P" }],
  ["broadcasts.send", (c) => c.broadcasts.send("b1", { scheduledAt: "in 1 hour" }), "POST", "/broadcasts/b1/send", { scheduled_at: "in 1 hour" }],
  ["broadcasts.list", (c) => c.broadcasts.list(), "GET", "/broadcasts"],
  ["broadcasts.get", (c) => c.broadcasts.get("b1"), "GET", "/broadcasts/b1"],
  ["broadcasts.update", (c) => c.broadcasts.update("b1", { replyTo: "r@x.com" }), "PATCH", "/broadcasts/b1", { reply_to: "r@x.com" }],
  ["broadcasts.remove", (c) => c.broadcasts.remove("b1"), "DELETE", "/broadcasts/b1"],
  ["broadcasts.cancel", (c) => c.broadcasts.cancel("b1"), "POST", "/broadcasts/b1/cancel"],
  ["broadcasts.duplicate", (c) => c.broadcasts.duplicate("b1"), "POST", "/broadcasts/b1/duplicate", {}],
  ["broadcasts.clickedLinks", (c) => c.broadcasts.clickedLinks("b1"), "GET", "/broadcasts/b1/clicked-links"],
  ["broadcasts.pause", (c) => c.broadcasts.pause("b1"), "POST", "/broadcasts/b1/pause"],
  ["broadcasts.resume", (c) => c.broadcasts.resume("b1"), "POST", "/broadcasts/b1/resume"],
  ["automations.create", (c) => c.automations.create({ name: "Welcome", steps: [{ key: "start", type: "trigger", config: { event_name: "user.created" } }], connections: [] }), "POST", "/automations"],
  ["automations.list", (c) => c.automations.list({ status: "enabled" }), "GET", "/automations?status=enabled"],
  ["automations.get", (c) => c.automations.get("a1"), "GET", "/automations/a1"],
  ["automations.update", (c) => c.automations.update("a1", { status: "enabled" }), "PATCH", "/automations/a1", { status: "enabled" }],
  ["automations.remove", (c) => c.automations.remove("a1"), "DELETE", "/automations/a1"],
  ["automations.duplicate", (c) => c.automations.duplicate("a1"), "POST", "/automations/a1/duplicate"],
  ["automations.stop", (c) => c.automations.stop("a1"), "POST", "/automations/a1/stop"],
  ["automations.cancelEnrollmentJob", (c) => c.automations.cancelEnrollmentJob("a/1", "j/1"), "DELETE", "/automations/a%2F1/enroll-jobs/j%2F1"],
  ["automations.runs.list", (c) => c.automations.runs.list("a1", { status: "running,failed" }), "GET", "/automations/a1/runs?status=running%2Cfailed"],
  ["automations.runs.get", (c) => c.automations.runs.get("a1", "run_1"), "GET", "/automations/a1/runs/run_1"],
  ["events.send", (c) => c.events.send({ event: "user.created", contactId: "c1", payload: { planTier: "pro" } }), "POST", "/events/send", { event: "user.created", contact_id: "c1", payload: { planTier: "pro" } }],
  ["events.create", (c) => c.events.create({ name: "user.created", schema: { plan: "string" } }), "POST", "/events", { name: "user.created", schema: { plan: "string" } }],
  ["events.get", (c) => c.events.get("user.created"), "GET", "/events/user.created"],
  ["events.list", (c) => c.events.list(), "GET", "/events"],
  ["events.update", (c) => c.events.update("user.created", { schema: { plan: "number" } }), "PATCH", "/events/user.created", { schema: { plan: "number" } }],
  ["events.remove", (c) => c.events.remove("user.created"), "DELETE", "/events/user.created"],
  ["events.fired.list", (c) => c.events.fired.list({ limit: 3 }), "GET", "/fired-events?limit=3"],
  ["events.fired.get", (c) => c.events.fired.get("ev_1"), "GET", "/fired-events/ev_1"],
  ["logs.get", (c) => c.logs.get("log_1"), "GET", "/logs/log_1"],
  ["logs.export", (c) => c.logs.export(), "GET", "/logs/export"],
  ["brand.get", (c) => c.brand.get(), "GET", "/brand"],
  ["settings.get", (c) => c.settings.get(), "GET", "/settings"],
  ["settings.update", (c) => c.settings.update({ importTriggerAutomations: true, sandboxDomains: ["qa.test"] }), "PATCH", "/settings", { import_trigger_automations: true, sandbox_domains: ["qa.test"] }],
  ["brand.update", (c) => c.brand.update({ productName: "Acme", logoUrl: null }), "PATCH", "/brand", { product_name: "Acme", logo_url: null }],
  ["usage.get", (c) => c.usage.get(), "GET", "/usage"],
  ["system.get", (c) => c.system.get(), "GET", "/system"],
  ["timeline.list", (c) => c.timeline.list({ limit: 2 }), "GET", "/timeline?limit=2"],
  ["auditLogs.list", (c) => c.auditLogs.list({ action: "api_key.created" }), "GET", "/audit-logs?action=api_key.created"],
  ["users.list", (c) => c.users.list(), "GET", "/users"],
  ["users.create", (c) => c.users.create({ email: "u@x.com", name: "U" }), "POST", "/users", { email: "u@x.com", name: "U" }],
  ["users.update", (c) => c.users.update("u1", { active: false }), "PATCH", "/users/u1", { active: false }],
  ["users.remove", (c) => c.users.remove("u1"), "DELETE", "/users/u1"],
  ["roles.create", (c) => c.roles.create({ name: "ops", permissions: ["full"] }), "POST", "/roles"],
  ["roles.update", (c) => c.roles.update("r1", { name: "ops2" }), "PATCH", "/roles/r1"],
  ["memberships.create", (c) => c.memberships.create({ userId: "u1", roleId: "r1" }), "POST", "/memberships", { user_id: "u1", role_id: "r1" }],
  ["memberships.remove", (c) => c.memberships.remove("m1"), "DELETE", "/memberships/m1"],
  ["sessions.list", (c) => c.sessions.list(), "GET", "/sessions"],
  ["sessions.remove", (c) => c.sessions.remove("sess_1"), "DELETE", "/sessions/sess_1"],
  ["me.get", (c) => c.me.get(), "GET", "/me"],
  ["links.check", (c) => c.links.check(["https://example.com"]), "POST", "/links/check", { urls: ["https://example.com"] }]
];

describe("resource methods", () => {
  it.each(cases)("%s calls the unprefixed route", async (_name, call, method, path, body) => {
    const fetch = stub({ id: "x" });
    const result = await call(new Dispatch({ apiKey: "sk_test" }));
    expect(result.error).toBeNull();
    const sent = request(fetch);
    expect(sent.method).toBe(method);
    expect(sent.url).toBe(`${base}${path}`);
    expect(sent.url).not.toContain("/v1/");
    if (body !== undefined) expect(sent.body).toEqual(body);
  });

  it("posts sessions without authorization", async () => {
    const fetch = stub({ id: "sess_1" });
    await new Dispatch({ apiKey: "sk_test" }).sessions.create({ email: "a@x.com", password: "a long private password" });
    const sent = request(fetch);
    expect(sent.url).toBe(`${base}/sessions`);
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.body).toEqual({ email: "a@x.com", password: "a long private password" });
  });

  it("creates and publishes a template through the chained call", async () => {
    const fetch = vi.fn(async (url: string) =>
      reply(url.endsWith("/publish") ? { object: "template", id: "tpl_1", status: "published" } : { object: "template", id: "tpl_1", status: "draft" })
    );
    globalThis.fetch = fetch as never;
    const client = new Dispatch({ apiKey: "sk_test" });
    const created = await client.templates.create({ name: "Welcome", html: "<p>Hi</p>" });
    expect(created.data).toMatchObject({ status: "draft" });
    const published = await client.templates.create({ name: "Welcome", html: "<p>Hi</p>" }).publish();
    expect(published.data).toMatchObject({ status: "published" });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([`${base}/templates`, `${base}/templates`, `${base}/templates/tpl_1/publish`]);
  });

  it("skips the publish call when create fails", async () => {
    const fetch = vi.fn(async () => reply({ name: "validation_error", statusCode: 422, message: "no" }, { status: 422 }));
    globalThis.fetch = fetch as never;
    const result = await new Dispatch({ apiKey: "sk_test" }).templates.create({ name: "Welcome" }).publish();
    expect(result.error?.name).toBe("validation_error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("forwards a received email through POST /emails", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/attachments?limit=100")
        ? reply({ object: "list", has_more: false, data: [] })
        : url.includes("/emails/receiving/")
          ? reply({ object: "email", id: "r1", subject: "Invoice", html: "<p>Due</p>", text: "Due" })
          : reply({ id: "email_9" })
    );
    globalThis.fetch = fetch as never;
    const result = await new Dispatch({ apiKey: "sk_test" }).emails.receiving.forward({ emailId: "r1", to: "ops@x.com", from: "bot@x.com" });
    expect(result.data).toEqual({ id: "email_9" });
    const sent = request(fetch as never, 2);
    expect(sent.url).toBe(`${base}/emails`);
    expect(sent.body).toEqual({ from: "bot@x.com", to: "ops@x.com", subject: "Fwd: Invoice", html: "<p>Due</p>", text: "Due" });
  });

  it("carries the attachments along, inline images included", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://files.example/logo") return new Response("PNGDATA");
      if (url.endsWith("/attachments?limit=100")) {
        return reply({
          object: "list",
          has_more: false,
          data: [{ id: "a1", filename: "logo.png", content_type: "image/png", content_id: "logo", download_url: "https://files.example/logo" }]
        });
      }
      if (url.includes("/emails/receiving/")) return reply({ object: "email", id: "r1", subject: "Logo", html: '<img src="cid:logo">' });
      return reply({ id: "email_9" });
    });
    globalThis.fetch = fetch as never;
    await new Dispatch({ apiKey: "sk_test" }).emails.receiving.forward({ emailId: "r1", to: "ops@x.com", from: "bot@x.com" });
    // The download carries no API key: the signed URL is its own credential.
    expect(fetch.mock.calls[2]).toEqual(["https://files.example/logo"]);
    expect(request(fetch as never, 3).body).toEqual({
      from: "bot@x.com",
      to: "ops@x.com",
      subject: "Fwd: Logo",
      html: '<img src="cid:logo">',
      attachments: [{ filename: "logo.png", content: Buffer.from("PNGDATA").toString("base64"), content_type: "image/png", content_id: "logo" }]
    });
  });

  it("stops when an attachment cannot be downloaded, and sends nothing", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://files.example/gone") return new Response("no", { status: 403 });
      if (url.endsWith("/attachments?limit=100")) return reply({ object: "list", has_more: false, data: [{ id: "a1", filename: "a.pdf", download_url: "https://files.example/gone" }] });
      return reply({ object: "email", id: "r1", subject: "Hi", text: "x" });
    });
    globalThis.fetch = fetch as never;
    const result = await new Dispatch({ apiKey: "sk_test" }).emails.receiving.forward({ emailId: "r1", to: "ops@x.com", from: "bot@x.com" });
    expect(result.error).toEqual({ name: "application_error", statusCode: 403, message: "Could not download the attachment a.pdf" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("returns the lookup error when the received email is missing", async () => {
    const fetch = vi.fn(async () => reply({ name: "not_found", statusCode: 404, message: "Received email not found" }, { status: 404 }));
    globalThis.fetch = fetch as never;
    const result = await new Dispatch({ apiKey: "sk_test" }).emails.receiving.forward({ emailId: "r1", to: "ops@x.com", from: "bot@x.com" });
    expect(result.error?.name).toBe("not_found");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uploads a contact import as multipart form data", async () => {
    const fetch = stub({ object: "contact_import", id: "imp_1" });
    await new Dispatch({ apiKey: "sk_test" }).contacts.imports.create({
      file: "email\nada@x.com\n",
      columnMap: { email: { column: "email", type: "string" } },
      onConflict: "skip"
    });
    const sent = request(fetch);
    expect(sent.url).toBe(`${base}/contacts/imports`);
    expect(sent.headers.get("content-type")).toBeNull();
    const form = sent.body as FormData;
    expect(form.get("on_conflict")).toBe("skip");
    expect(JSON.parse(String(form.get("column_map")))).toEqual({ email: { column: "email", type: "string" } });
    expect(await (form.get("file") as Blob).text()).toBe("email\nada@x.com\n");
  });

  it.each([undefined, false, true])("preserves the optional import automation flag: %s", async (triggerAutomations) => {
    // Omission must let the API resolve a tenant default, not send the SDK's own default.
    const imported = { object: "contact_import", id: "imp_1", trigger_automations: triggerAutomations ?? true };
    const fetch = stub(imported);
    const client = new Dispatch({ apiKey: "sk_test" });
    const created = await client.contacts.imports.create({
      file: "email\nada@x.com\n",
      ...(triggerAutomations === undefined ? {} : { triggerAutomations })
    });
    const sent = request(fetch);
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(`${base}/contacts/imports`);
    expect(sent.headers.get("content-type")).toBeNull();
    const form = sent.body as FormData;
    expect(form.has("trigger_automations")).toBe(triggerAutomations !== undefined);
    expect(form.get("trigger_automations")).toBe(triggerAutomations === undefined ? null : String(triggerAutomations));
    expect(await (form.get("file") as Blob).text()).toBe("email\nada@x.com\n");
    expectTypeOf(created.data!.trigger_automations).toEqualTypeOf<boolean>();
    expect(created.data).toEqual(imported);

    const detail = await client.contacts.imports.get("imp_1");
    expectTypeOf(detail.data!.trigger_automations).toEqualTypeOf<boolean>();
    expect(detail.data).toEqual(imported);
    expect(request(fetch, 1).url).toBe(`${base}/contacts/imports/imp_1`);
    const listFetch = stub({ object: "list", has_more: false, data: [imported] });
    const list = await client.contacts.imports.list();
    expectTypeOf(list.data!.data[0]!.trigger_automations).toEqualTypeOf<boolean>();
    expect(list.data?.data[0]).toEqual(imported);
    expect(request(listFetch).url).toBe(`${base}/contacts/imports`);
  });

  it("returns missing_required_field instead of throwing when a contact is not named", async () => {
    const fetch = stub();
    const result = await new Dispatch({ apiKey: "sk_test" }).contacts.segments.add({ segmentId: "s1" });
    expect(result.error).toMatchObject({ name: "missing_required_field", statusCode: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("webhooks.verify", () => {
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const payload = JSON.stringify({ type: "email.sent", data: { email_id: "email_1" } });

  it("accepts a payload signed by the server's signer", () => {
    const signed = signWebhook(payload, [secret], "msg_1");
    const event = new Dispatch({ apiKey: "sk_test" }).webhooks.verify({
      payload,
      headers: { id: signed.id, timestamp: String(signed.timestamp), signature: signed.signature },
      webhookSecret: secret
    });
    expect(event).toEqual({ type: "email.sent", data: { email_id: "email_1" } });
  });

  it("accepts any matching signature during a secret rotation", () => {
    const signed = signWebhook(payload, ["whsec_b2xkc2VjcmV0b2xkc2VjcmV0", secret], "msg_2");
    const client = new Dispatch({ apiKey: "sk_test" });
    expect(() =>
      client.webhooks.verify({ payload, headers: { id: "msg_2", timestamp: String(signed.timestamp), signature: signed.signature }, webhookSecret: secret })
    ).not.toThrow();
  });

  it("throws on a tampered payload", () => {
    const signed = signWebhook(payload, [secret], "msg_3");
    const client = new Dispatch({ apiKey: "sk_test" });
    expect(() =>
      client.webhooks.verify({
        payload: payload.replace("email_1", "email_2"),
        headers: { id: "msg_3", timestamp: String(signed.timestamp), signature: signed.signature },
        webhookSecret: secret
      })
    ).toThrow(WebhookVerificationError);
  });

  it("throws on a stale timestamp", () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    const signed = signWebhook(payload, [secret], "msg_4", old);
    const client = new Dispatch({ apiKey: "sk_test" });
    expect(() =>
      client.webhooks.verify({ payload, headers: { id: "msg_4", timestamp: String(old), signature: signed.signature }, webhookSecret: secret })
    ).toThrow("Message timestamp too old");
  });
});

describe("react", () => {
  it("renders a react node into html and drops react from every content method", async () => {
    vi.resetModules();
    vi.doMock("@react-email/render", () => ({ render: async () => "<p>Rendered</p>" }));
    const { Dispatch: Fresh } = await import("./index.js");
    const fetch = stub({ id: "x" });
    const client = new Fresh({ apiKey: "sk_test" });
    await client.emails.send({ from: "a@x.com", to: "b@x.com", subject: "Hi", react: { type: "welcome" } });
    await client.batch.send([
      { from: "a@x.com", to: "b@x.com", subject: "Hi", react: { type: "one" } },
      { from: "a@x.com", to: "c@x.com", subject: "Hi", text: "plain" }
    ]);
    await client.templates.create({ name: "Welcome", react: { type: "welcome" } });
    await client.templates.update("welcome", { react: { type: "welcome" } });
    await client.broadcasts.create({ name: "News", from: "a@x.com", subject: "Hi", segmentId: "s1", react: { type: "news" } });
    await client.broadcasts.update("b1", { react: { type: "news" } });
    const bodies = fetch.mock.calls.map((_, index) => request(fetch, index).body);
    expect(JSON.stringify(bodies)).not.toContain("react");
    expect(bodies[0].html).toBe("<p>Rendered</p>");
    expect(bodies[1][0].html).toBe("<p>Rendered</p>");
    expect(bodies[1][1]).toEqual({ from: "a@x.com", to: "c@x.com", subject: "Hi", text: "plain" });
    for (const body of bodies.slice(2)) expect(body.html).toBe("<p>Rendered</p>");
    expect(fetch.mock.calls.map((_, index) => request(fetch, index).url)).toEqual([
      `${base}/emails`,
      `${base}/emails/batch`,
      `${base}/templates`,
      `${base}/templates/welcome`,
      `${base}/broadcasts`,
      `${base}/broadcasts/b1`
    ]);
  });

  it("rejects with the install message when neither renderer is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-render-"));
    try {
      await writeFile(join(dir, "render.ts"), await readFile(new URL("./render.ts", import.meta.url), "utf8"));
      await writeFile(
        join(dir, "run.mjs"),
        `const { render } = await import("./render.ts");
try {
  await render({ type: "welcome" });
  console.error("rendered");
  process.exit(2);
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
`
      );
      const result = spawnSync(process.execPath, ["--experimental-strip-types", "run.mjs"], { cwd: dir, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(
        "Failed to render React component. Install `react-email`, or `@react-email/render`, in your project."
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets a renderer failure through", async () => {
    vi.resetModules();
    vi.doMock("@react-email/render", () => ({
      render: async () => {
        throw new Error("bad element");
      }
    }));
    const { render } = await import("./render.js");
    await expect(render({ type: "welcome" })).rejects.toThrow("bad element");
  });
});
