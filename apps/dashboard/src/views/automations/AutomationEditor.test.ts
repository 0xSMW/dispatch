// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn, type Reply } from "../../testing";
import { AutomationEditor } from "./AutomationEditor";
import { keys, type TriggerConfig } from "./graph";

// New steps get a random key suffix. Tests count instead, so keys can be named.
beforeEach(() => {
  let next = 0;
  vi.spyOn(keys, "suffix").mockImplementation(() => String(++next));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
});

const automation = {
  object: "automation",
  id: "automation_1",
  name: "Welcome",
  status: "disabled",
  trigger: "user.created",
  steps: [
    { key: "trigger", type: "trigger", config: { event_name: "user.created" } },
    { key: "welcome", type: "send_email", config: { from: "hi@acme.com", template: { id: "tpl_1", variables: {} } } },
    { key: "pro", type: "condition", config: { type: "rule", field: "event.plan", operator: "eq", value: "pro" } },
  ],
  connections: [
    { from: "trigger", to: "welcome", type: "default" },
    { from: "welcome", to: "pro", type: "default" },
  ],
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

const list = (data: unknown[]) => ({ body: { object: "list", has_more: false, data } });

function Where() {
  const location = useLocation();
  return h("p", { "data-testid": "location" }, `${location.pathname}${location.search}`);
}

// A data router, because the editor's leave guard uses `useBlocker`.
function open(path = "/automations/automation_1/editor") {
  const router = createMemoryRouter(
    [
      {
        element: h(SessionProvider, null, h(Outlet), h(Where)),
        children: [
          { path: "/automations/:id/editor", element: h(AutomationEditor) },
          { path: "*", element: h("p", null, "Elsewhere") },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(h(RouterProvider, { router }));
  return router;
}

function api(overrides: (url: URL, init: RequestInit) => Reply | undefined = () => undefined) {
  return mockFetch((raw, init) => {
    const url = new URL(raw);
    const custom = overrides(url, init);
    if (custom) return custom;
    if (url.pathname === "/templates") return list([{ id: "tpl_1", name: "Welcome", alias: "welcome" }]);
    if (url.pathname === "/segments") return list([{ id: "seg_1", name: "Trials" }]);
    if (url.pathname === "/events") return list([{ id: "evdef_1", name: "user.created", schema: {} }]);
    if (url.pathname === "/automations/automation_1") return { body: automation };
    return list([]);
  });
}

describe("AutomationEditor", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });
  it("uses a status-only update when resuming a clean paused graph", async () => {
    const fetch = api((url, init) => url.pathname === "/automations/automation_1" ? {
      body: { ...automation, status: init.method === "PATCH" ? "enabled" : "paused", version: 2 },
    } : undefined);
    open();
    const resume = await screen.findByRole("button", { name: "Resume" }) as HTMLButtonElement;
    await waitFor(() => expect(resume.disabled).toBe(false));
    fireEvent.click(resume);
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body))).toEqual({ status: "enabled" });
  });

  it.each(["", "?view=canvas"])("offers enrollment for an enabled native flow in the %s builder", async (query) => {
    const config = { type: "contact_created" };
    api((url) => url.pathname === "/automations/automation_1" ? { body: {
      ...automation, status: "enabled", trigger_config: config,
      steps: [{ key: "trigger", type: "trigger", config }], connections: [],
    } } : undefined);
    open(`/automations/automation_1/editor${query}`);
    fireEvent.click(await screen.findByRole("button", { name: "Enroll contacts" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Audience")).toBeTruthy();
    expect(within(dialog).getByText("This can send emails immediately.")).toBeTruthy();
  });

  it("opens an existing enrollment job from the URL for viewers without write controls", async () => {
    signIn("sess_viewer", ["read"]);
    api((url) => url.pathname.endsWith("/enroll-jobs/job_1") ? { body: {
      object: "automation_enrollment_job", id: "job_1", automation_id: "automation_1", segment_id: null,
      status: "in_progress", counts: { total: 10, processed: 3, enrolled: 2, skipped: 1, failed: 0 }, error: null,
      created_at: "", completed_at: null,
    } } : undefined);
    open("/automations/automation_1/editor?view=canvas&enroll_job=job_1");
    await screen.findByText("in progress");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Enroll contacts|Cancel enrollment/ })).toBeNull();
    expect(screen.queryByLabelText("Audience")).toBeNull();
  });

  it("renders the graph as cards, with the condition's branches nested", async () => {
    api();
    open();
    expect(await screen.findByRole("article", { name: "Step welcome" })).toBeTruthy();
    expect(screen.getByLabelText("Event")).toHaveProperty("value", "user.created");
    const card = screen.getByRole("article", { name: "Step pro" });
    expect(within(card).getByLabelText("Field")).toHaveProperty("value", "event.plan");
    expect(screen.getByRole("region", { name: "True branch of pro" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "False branch of pro" })).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("loads and saves native contact change bounds without requiring an event", async () => {
    const config = { type: "contact_updated", field: "unsubscribed", from: false, to: true };
    const fetch = api((url, init) => {
      if (url.pathname === "/automations/automation_1") return { body: { ...automation, trigger: null, trigger_config: config,
        steps: [{ key: "trigger", type: "trigger", config }], connections: [], ...(init.method === "PATCH" ? JSON.parse(String(init.body)) : {}),
      } };
      return undefined;
    });
    open();
    const card = within(await screen.findByRole("article", { name: "Trigger" }));
    expect(card.getByText("Contact changes")).toBeTruthy();
    expect(card.getByLabelText("From")).toHaveProperty("value", "false");
    expect(card.getByLabelText("To")).toHaveProperty("value", "true");
    expect(card.queryByLabelText("Event")).toBeNull();
    fireEvent.change(card.getByLabelText("To"), { target: { value: "false" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body)).steps).toEqual([
      { key: "trigger", type: "trigger", config: { ...config, to: false } },
    ]);
  });

  it.each(["once", "every_time"])("keeps stored %s re-entry when changing an existing trigger and persists it", async (reentry) => {
    const fetch = api((url, init) => url.pathname === "/automations/automation_1" ? { body: {
      ...automation, reentry, steps: [automation.steps[0]], connections: [],
      ...(init.method === "PATCH" ? JSON.parse(String(init.body)) : {}),
    } } : undefined);
    open();
    const selector = await screen.findByLabelText("Run for each contact");
    expect(selector).toHaveProperty("value", reentry);
    fireEvent.change(screen.getByRole("combobox", { name: "Trigger" }), { target: { value: "contact_created" } });
    expect(selector).toHaveProperty("value", reentry);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body))).toMatchObject({
      reentry, steps: [{ key: "trigger", type: "trigger", config: { type: "contact_created" } }],
    });
  });

  it("tracks re-entry edits as dirty, saves them, and keeps a newer choice while a save is in flight", async () => {
    let release!: (reply: Reply) => void;
    const pending = new Promise<Reply>((resolve) => { release = resolve; });
    const fetch = mockFetch((raw, init) => {
      if (init.method === "PATCH") return pending;
      if (new URL(raw).pathname === "/automations/automation_1") return { body: { ...automation, reentry: "every_time" } };
      return list([]);
    });
    open();
    const selector = await screen.findByLabelText("Run for each contact");
    fireEvent.change(selector, { target: { value: "once" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body));
    expect(body.reentry).toBe("once");
    fireEvent.change(selector, { target: { value: "every_time" } });
    release({ body: { ...automation, ...body } });
    await screen.findByText("Unsaved changes");
    expect(selector).toHaveProperty("value", "every_time");
  });

  it("edits the same re-entry value in the canvas trigger panel and saves it", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
    const fetch = api((url, init) => url.pathname === "/automations/automation_1" ? { body: {
      ...automation, reentry: "once", ...(init.method === "PATCH" ? JSON.parse(String(init.body)) : {}),
    } } : undefined);
    open("/automations/automation_1/editor?view=canvas");
    fireEvent.click(await screen.findByRole("button", { name: "Trigger" }));
    const panel = within(screen.getByRole("region", { name: "Trigger settings" }));
    expect(panel.getByLabelText("Run for each contact")).toHaveProperty("value", "once");
    fireEvent.change(panel.getByLabelText("Run for each contact"), { target: { value: "every_time" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body)).reentry).toBe("every_time");
  });

  it.each([
    { type: "topic_subscribed", topic_id: "missing" },
    { type: "segment_added", segment_id: "missing" },
  ] as TriggerConfig[])("warns about a deleted $type resource and blocks Start until it is replaced", async (config) => {
    const fetch = api((url, init) => {
      if (url.pathname === "/topics") return list([{ id: "topic_1", name: "News" }]);
      if (url.pathname === "/automations/automation_1") return { body: {
        ...automation, trigger: null, trigger_config: config, steps: [{ key: "trigger", type: "trigger", config }], connections: [],
        ...(init.method === "PATCH" ? JSON.parse(String(init.body)) : {}),
      } };
      return undefined;
    });
    open();
    expect(await screen.findByText(/Its (topic|segment) was deleted/)).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toHaveProperty("disabled", true);
    fireEvent.click(start);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.change(screen.getByLabelText(config.type === "topic_subscribed" ? "Topic" : "Segment"), {
      target: { value: config.type === "topic_subscribed" ? "topic_1" : "seg_1" },
    });
    await waitFor(() => expect(start).toHaveProperty("disabled", false));
    fireEvent.click(start);
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body)).status).toBe("enabled");
  });

  it("shows contact triggers read-only to viewers", async () => {
    signIn("sess_viewer", ["read"]);
    const config = { type: "contact_updated", field: "unsubscribed", from: false, to: true };
    const fetch = api((url) => url.pathname === "/automations/automation_1" ? { body: {
      ...automation, trigger: null, steps: [{ key: "trigger", type: "trigger", config }], connections: [],
    } } : undefined);
    open();
    const card = within(await screen.findByRole("article", { name: "Trigger" }));
    for (const control of card.getAllByRole("combobox")) expect(control).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "s", metaKey: true });
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("loads typed field sources and saves boolean rules and additive send mappings", async () => {
    const fetch = api((url, init) => {
      if (url.pathname === "/events") return list([{ id: "e1", name: "user.created", schema: { plan: "string", active: "boolean", seats: "number" } }]);
      if (url.pathname === "/contact-properties") return list([{ id: "p1", key: "renewed", type: "date", fallback_value: null }]);
      if (url.pathname === "/topics") return list([{ id: "topic_news", name: "News" }]);
      if (init.method === "PATCH") return { body: { ...automation, ...JSON.parse(String(init.body)) } };
      return undefined;
    });
    open();
    const rule = await screen.findByRole("article", { name: "Step pro" });
    await within(rule).findByRole("option", { name: "renewed (date)" });
    expect(within(rule).getByRole("option", { name: "active (boolean)" })).toBeTruthy();
    fireEvent.change(within(rule).getByLabelText("Choose field"), { target: { value: "event.active" } });
    fireEvent.change(within(rule).getByLabelText("Value"), { target: { value: "true" } });
    const send = screen.getByRole("article", { name: "Step welcome" });
    fireEvent.click(within(send).getByRole("button", { name: "Add mapping" }));
    fireEvent.change(within(send).getByLabelText("Variable name"), { target: { value: "plan" } });
    fireEvent.change(within(send).getByLabelText("Choose context field"), { target: { value: "event.plan" } });
    fireEvent.change(within(send).getByLabelText("Variables"), { target: { value: '{"plan":"literal","paid":false}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body));
    expect(body.steps[1].config).toMatchObject({ variable_mapping: { plan: "event.plan" }, template: { id: "tpl_1", variables: { plan: "literal", paid: false } } });
    expect(body.steps[2].config).toEqual({ type: "rule", field: "event.active", operator: "eq", value: true });
    expect(JSON.stringify(body)).not.toContain("ruleTypes");
    expect(fetch.mock.calls.some(([raw]) => new URL(String(raw)).pathname === "/contact-properties")).toBe(true);
  });

  it("loads email counts once for all send steps and refreshes only when the date range changes", async () => {
    const fetch = api((url) => {
      if (url.pathname === "/automations/automation_1") return { body: {
        ...automation,
        steps: [automation.steps[0], automation.steps[1], { key: "follow", type: "send_email", config: { from: "hi@acme.com", template: "tpl_1" } }],
        connections: [{ from: "trigger", to: "welcome", type: "default" }, { from: "welcome", to: "follow", type: "default" }],
      } };
      if (url.pathname === "/emails/metrics") return { body: { data: [
        { automation_id: "automation_1", automation_step: "welcome", sent: 4, opened: 2, clicked: 1 },
      ] } };
      return undefined;
    });
    open();
    const card = await screen.findByRole("article", { name: "Step welcome" });
    expect(await within(card).findByText("4 sent · 2 opened · 1 clicked")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Step follow" })).getByText("0 sent · 0 opened · 0 clicked")).toBeTruthy();
    const requests = () => fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/emails/metrics");
    expect(requests()).toHaveLength(1);
    expect(new URL(String(requests()[0]![0])).searchParams.get("automation_id")).toBe("automation_1");
    expect(new URL(String(requests()[0]![0])).searchParams.get("start_date")).toBe("1970-01-01T00:00:00.000Z");
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "7d" } });
    await waitFor(() => expect(requests()).toHaveLength(2));
  });

  it("warns when a marketing template has no body link and clears the warning for transactional sends", async () => {
    api((url) => {
      if (url.pathname === "/topics") return list([{ id: "topic_1", name: "News" }]);
      if (url.pathname === "/templates/tpl_1") return { body: { published_version_id: "v1", current_version_id: "v1", html: "<p>Hello</p>", text: null } };
      return undefined;
    });
    open();
    const card = await screen.findByRole("article", { name: "Step welcome" });
    const topic = within(card).getByLabelText("Topic");
    fireEvent.change(topic, { target: { value: "topic_1" } });
    expect(await within(card).findByText(/This email has no unsubscribe link/)).toBeTruthy();
    fireEvent.change(topic, { target: { value: "" } });
    await waitFor(() => expect(within(card).queryByText(/This email has no unsubscribe link/)).toBeNull());
  });

  it("checks the published version rather than an unpublished draft for the warning", async () => {
    api((url) => {
      if (url.pathname === "/topics") return list([{ id: "topic_1", name: "News" }]);
      if (url.pathname === "/templates/tpl_1") return { body: {
        published_version_id: "v1", current_version_id: "v2", html: "{{{UNSUBSCRIBE_URL}}}", text: null,
      } };
      if (url.pathname === "/templates/tpl_1/versions") return list([{ id: "v1", html: "<p>Published without link</p>", text: null }]);
      return undefined;
    });
    open();
    const card = await screen.findByRole("article", { name: "Step welcome" });
    fireEvent.change(within(card).getByLabelText("Topic"), { target: { value: "topic_1" } });
    expect(await within(card).findByText(/This email has no unsubscribe link/)).toBeTruthy();
  });

  it("adds a delay into a branch and saves the graph with PATCH", async () => {
    const fetch = api((url, init) =>
      url.pathname === "/automations/automation_1" && init.method === "PATCH" ? { body: { ...automation, ...JSON.parse(String(init.body)) } } : undefined,
    );
    open();
    const branch = await screen.findByRole("region", { name: "False branch of pro" });
    fireEvent.click(within(branch).getByRole("button", { name: "Add step" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Time delay" }));
    expect(await screen.findByRole("article", { name: "Step delay_1" })).toBeTruthy();
    expect(screen.getByText('Examples: "2 days", "1 hour". Up to 30 days.')).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const patch = fetch.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(String(patch[0])).toBe("http://localhost:3100/automations/automation_1");
    const body = JSON.parse(String(patch[1]!.body));
    expect(body.name).toBe("Welcome");
    expect(body.steps.map((step: { key: string }) => step.key)).toEqual(["trigger", "welcome", "pro", "delay_1"]);
    expect(body.steps[3]).toEqual({ key: "delay_1", type: "delay", config: { duration: "1 hour" } });
    expect(body.connections).toEqual([
      { from: "trigger", to: "welcome", type: "default" },
      { from: "welcome", to: "pro", type: "default" },
      { from: "pro", to: "delay_1", type: "condition_not_met" },
    ]);
    expect(body.status).toBeUndefined();
  });

  it("shows field errors on the card and does not save while a step is invalid", async () => {
    const fetch = api();
    open();
    const card = await screen.findByRole("article", { name: "Step welcome" });
    fireEvent.change(within(card).getByLabelText(/From/), { target: { value: "not an address" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(card).findByText("Use email@domain or Name <email@domain>.")).toBeTruthy();
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("keeps text typed while a save is in flight, and asks before leaving with unsaved steps", async () => {
    let release: (reply: Reply) => void = () => undefined;
    const held = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const fetch = mockFetch((url, init) => {
      const path = new URL(url).pathname;
      if (init.method === "PATCH") return held;
      if (path === "/automations/automation_1") return { body: automation };
      return { body: { object: "list", has_more: false, data: [] } };
    });
    const router = open();
    const card = await screen.findByRole("article", { name: "Step welcome" });
    fireEvent.change(within(card).getByLabelText("Subject"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    // Typed after the request left. The response holds the older subject.
    fireEvent.change(within(card).getByLabelText("Subject"), { target: { value: "Hello again" } });
    const stored = { ...automation, steps: automation.steps.map((step) => (step.key === "welcome" ? { ...step, config: { ...step.config, subject: "Hello" } } : step)) };
    release({ body: stored });
    await screen.findByText("Unsaved changes");
    expect((within(card).getByLabelText("Subject") as HTMLInputElement).value).toBe("Hello again");

    void router.navigate("/automations");
    expect(await screen.findByText("Leave without saving?")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/automations/automation_1/editor");
  });

  it.each(["Disable the automation before changing its steps", "Pause or stop the automation before changing its steps"])
  ("explains the enabled graph conflict %s: pause first to keep runs", async (message) => {
    api((url, init) =>
      init.method === "PATCH"
        ? { status: 409, body: { name: "conflict", statusCode: 409, message } }
        : undefined,
    );
    open();
    const card = await screen.findByRole("article", { name: "Step welcome" });
    fireEvent.change(within(card).getByLabelText("Subject"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByText(/Pause it first to keep its runs, or duplicate it/, { selector: ".alert" });
    expect(alert).toBeTruthy();
  });

  it("puts API validation issues on the step cards their paths name, and the rest in the banner", async () => {
    api((_url, init) =>
      init.method === "PATCH"
        ? {
            status: 400,
            body: {
              name: "validation_error",
              statusCode: 400,
              message: "Template not found",
              path: "steps.1.config.template.id",
              issues: [
                { path: "steps.1.config.template.id", message: "Template not found" },
                { path: "steps.2.config.operator", message: "Unknown operator" },
                { path: "steps.1.config.headers", message: "Too many headers" },
                { path: "connections", message: "Connections form a cycle" },
              ],
            },
          }
        : undefined,
    );
    open();
    const card = await screen.findByRole("article", { name: "Step welcome" });
    fireEvent.change(within(card).getByLabelText("Subject"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(card).findByText("Template not found")).toBeTruthy();
    expect(within(card).getByText("headers: Too many headers")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Step pro" })).getByText("Unknown operator")).toBeTruthy();
    expect(screen.getByText("connections: Connections form a cycle", { selector: ".alert" })).toBeTruthy();
  });

  it("starts the automation by saving with status enabled", async () => {
    const fetch = api((url, init) =>
      init.method === "PATCH" ? { body: { ...automation, status: "enabled" } } : undefined,
    );
    open();
    await screen.findByRole("article", { name: "Step welcome" });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const patch = () => fetch.mock.calls.find(([, init]) => init?.method === "PATCH");
    await waitFor(() => expect(patch()).toBeTruthy());
    expect(JSON.parse(String(patch()![1]!.body)).status).toBe("enabled");
    expect(await screen.findByText(/Enabled automations cannot be edited/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop and cancel runs" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByLabelText("Event")).toHaveProperty("disabled", true);
  });

  it("lists runs with a status filter and opens a run with each step's status and output", async () => {
    const fetch = api((url) => {
      if (url.pathname === "/automations/automation_1/runs") {
        return list([
          {
            object: "automation_run",
            id: "run_1",
            automation_id: "automation_1",
            status: "completed",
            event: { id: "evt_1", name: "user.created", email: "ada@example.com" },
            error: null,
            created_at: "2026-09-02T10:00:00.000Z",
            updated_at: "2026-09-02T10:00:03.000Z",
          },
        ]);
      }
      if (url.pathname === "/automations/automation_1/runs/run_1") {
        return {
          body: {
            object: "automation_run",
            id: "run_1",
            status: "completed",
            event: { id: "evt_1", name: "user.created", email: "ada@example.com", payload: { plan: "free" } },
            error: null,
            created_at: "2026-09-02T10:00:00.000Z",
            updated_at: "2026-09-02T10:00:03.000Z",
            steps: [
              { key: "welcome", type: "send_email", status: "completed", started_at: "2026-09-02T10:00:01.000Z", completed_at: "2026-09-02T10:00:02.000Z", output: { email_id: "email_9" }, error: null },
              { key: "pro", type: "condition", status: "completed", started_at: "2026-09-02T10:00:02.000Z", completed_at: "2026-09-02T10:00:02.000Z", output: { result: false }, error: null },
            ],
          },
        };
      }
      return undefined;
    });
    open("/automations/automation_1/editor?tab=runs&status=completed");
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    const runsCall = fetch.mock.calls.map(([url]) => new URL(String(url))).find((url) => url.pathname.endsWith("/runs"))!;
    expect(runsCall.searchParams.get("status")).toBe("completed");
    expect(screen.getByText("3.0s")).toBeTruthy();

    fireEvent.click(screen.getByText("ada@example.com"));
    const drawer = await screen.findByRole("dialog");
    const welcome = await within(drawer).findByRole("article", { name: "Step welcome" });
    expect(welcome.className).toContain("tint success");
    expect(within(welcome).getByText(/email_9/)).toBeTruthy();
    expect(within(drawer).getByText(/"plan"/)).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toContain("run=run_1");
  });

  it("filters runs by date range", async () => {
    const fetch = api();
    open("/automations/automation_1/editor?tab=runs&range=custom&start=2026-09-01&end=2026-09-02");
    await screen.findByText("No runs");
    const runsCall = fetch.mock.calls.map(([url]) => new URL(String(url))).find((url) => url.pathname.endsWith("/runs"))!;
    expect(runsCall.searchParams.get("start_date")).toBe(new Date(2026, 8, 1).toISOString());
    expect(runsCall.searchParams.get("end_date")).toBe(new Date(new Date(2026, 8, 3).getTime() - 1).toISOString());
    expect(screen.getByLabelText("Date range")).toBeTruthy();
  });

  it("shows run shares and a runs-per-day chart on the Metrics tab", async () => {
    const fetch = api((url) =>
      url.pathname === "/automations/automation_1/runs/metrics"
        ? {
            body: {
              object: "automation_run_metrics",
              automation_id: "automation_1",
              total: 8,
              totals: { running: 1, completed: 6, failed: 1, cancelled: 0 },
              data: [
                { date: "2026-09-01", running: 0, completed: 4, failed: 1, cancelled: 0 },
                { date: "2026-09-03", running: 1, completed: 2, failed: 0, cancelled: 0 },
              ],
            },
          }
        : undefined,
    );
    open("/automations/automation_1/editor?tab=metrics&range=7d");
    const stats = await screen.findByLabelText("Runs by status");
    expect(within(stats).getByText("75%")).toBeTruthy();
    expect(within(stats).getAllByText("12.5%")).toHaveLength(2);
    expect(within(stats).getByText("6 of 8 runs")).toBeTruthy();
    const call = fetch.mock.calls.map(([url]) => new URL(String(url))).find((url) => url.pathname.endsWith("/runs/metrics"))!;
    expect(call.searchParams.get("start_date")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Runs per day by status" })).toBeTruthy();
  });
});
