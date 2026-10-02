// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn, type Reply } from "../../testing";
import { AutomationEditor } from "./AutomationEditor";
import { keys } from "./graph";

// New steps get a random key suffix. Tests count instead, so keys can be named.
beforeEach(() => {
  let next = 0;
  vi.spyOn(keys, "suffix").mockImplementation(() => String(++next));
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

  it("adds a delay into a branch and saves the graph with PATCH", async () => {
    const fetch = api((url, init) =>
      url.pathname === "/automations/automation_1" && init.method === "PATCH" ? { body: { ...automation, ...JSON.parse(String(init.body)) } } : undefined,
    );
    open();
    const branch = await screen.findByRole("region", { name: "False branch of pro" });
    fireEvent.click(within(branch).getByRole("button", { name: "Add step" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Time delay" }));
    expect(await screen.findByRole("article", { name: "Step delay_1" })).toBeTruthy();
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

  it("explains a 409 conflict: stop the automation first", async () => {
    api((url, init) =>
      init.method === "PATCH"
        ? { status: 409, body: { name: "conflict", statusCode: 409, message: "Disable the automation before changing its steps" } }
        : undefined,
    );
    open();
    const card = await screen.findByRole("article", { name: "Step welcome" });
    fireEvent.change(within(card).getByLabelText("Subject"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByText(/Stop it first, or duplicate it/, { selector: ".alert" });
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
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
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
