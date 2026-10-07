// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn, type Reply } from "../../testing";
import { AutomationEditor } from "./AutomationEditor";

const automation = {
  id: "automation_1", name: "Welcome", status: "paused", version: 2,
  steps: [
    { key: "trigger", type: "trigger", config: { type: "event", event_name: "user.created" } },
    { key: "wait", type: "delay", config: { duration: "2 days" } },
    { key: "send", type: "send_email", config: { from: "hi@acme.com", template: "tpl_1" } },
  ],
  connections: [
    { from: "trigger", to: "wait", type: "default" },
    { from: "wait", to: "send", type: "default" },
  ],
  created_at: "2026-09-01T00:00:00.000Z",
};

function open(query = "?view=list") {
  const router = createMemoryRouter([{
    element: h(SessionProvider, null, h(Outlet)),
    children: [{ path: "/automations/:id/editor", element: h(AutomationEditor) }],
  }], { initialEntries: [`/automations/automation_1/editor${query}`] });
  render(h(RouterProvider, { router }));
}

function api(overrides: (url: URL, init: RequestInit) => Reply | Promise<Reply> | undefined = () => undefined) {
  return mockFetch((raw, init) => {
    const url = new URL(raw);
    const custom = overrides(url, init);
    if (custom) return custom;
    if (url.pathname === "/automations/automation_1") {
      if (url.searchParams.get("dry_run")) return { body: { stranded_runs: 0, by_step: {} } };
      return { body: { ...automation, ...(init.method === "PATCH" ? JSON.parse(String(init.body)) : {}) } };
    }
    const data = url.pathname === "/templates" ? [{ id: "tpl_1", name: "Welcome" }]
      : url.pathname === "/events" ? [{ id: "event_1", name: "user.created", schema: {} }] : [];
    return { body: { object: "list", has_more: false, data } };
  });
}

type Fetch = ReturnType<typeof api>;
const writes = (fetch: Fetch) => fetch.mock.calls.filter(([, init]) => init?.method === "PATCH");
const saves = (fetch: Fetch) => writes(fetch).filter(([raw]) => !new URL(String(raw)).searchParams.has("dry_run"));
const body = (call: Fetch["mock"]["calls"][number]) => JSON.parse(String(call[1]?.body));

describe("Paused automation editing", () => {
  beforeEach(() => {
    signIn();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
  });
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it.each(["list", "canvas"])("allows editing and step controls in the paused %s builder", async (view) => {
    api();
    open(`?view=${view}`);
    expect(await screen.findByText("Paused. Runs hold their place. New triggers are not started.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop and cancel runs" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Name")).toHaveProperty("disabled", false);
    if (view === "canvas") fireEvent.click(await screen.findByRole("button", { name: "Step wait" }));
    const card = view === "canvas"
      ? screen.getByRole("region", { name: "Step wait settings" })
      : screen.getByRole("article", { name: "Step wait" });
    expect(within(card).getByLabelText("Duration")).toHaveProperty("disabled", false);
    expect(within(card).getByRole("button", { name: "Remove step" })).toBeTruthy();
    fireEvent.change(within(card).getByLabelText("Duration"), { target: { value: "3 days" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
  });

  it.each(["list", "canvas"])("keeps a viewer's paused %s builder read-only", async (view) => {
    signIn("sess_viewer", ["read"]);
    const fetch = api();
    open(`?view=${view}`);
    await screen.findByText("Paused. Runs hold their place. New triggers are not started.");
    expect(screen.queryByRole("button", { name: /^(Save|Resume|Pause|Stop and cancel runs)$/ })).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveProperty("disabled", true);
    if (view === "canvas") fireEvent.click(await screen.findByRole("button", { name: "Step wait" }));
    const card = view === "canvas"
      ? screen.getByRole("region", { name: "Step wait settings" })
      : screen.getByRole("article", { name: "Step wait" });
    expect(within(card).getByLabelText("Duration")).toHaveProperty("disabled", true);
    expect(within(card).queryByRole("button", { name: "Remove step" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add step" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "s", metaKey: true });
    expect(writes(fetch)).toHaveLength(0);
  });

  it("pauses an enabled automation without saving or cancelling its graph", async () => {
    const fetch = api((url, init) => url.pathname === "/automations/automation_1"
      ? { body: { ...automation, status: init.method === "PATCH" ? "paused" : "enabled" } } : undefined);
    open();
    const notice = await screen.findByText(/Pause it to change its steps while keeping runs/);
    expect(screen.getByLabelText("Name")).toHaveProperty("disabled", true);
    fireEvent.click(within(notice.closest("[role=status]")!).getByRole("button", { name: "Pause" }));
    await screen.findByText("Paused. Runs hold their place. New triggers are not started.");
    expect(writes(fetch)).toHaveLength(1);
    expect(body(writes(fetch)[0]!)).toEqual({ status: "paused" });
    expect(screen.getByLabelText("Name")).toHaveProperty("disabled", false);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each(["Save", "Resume"])("previews removed steps before %s and saves only after confirmation", async (action) => {
    const fetch = api((url) => url.searchParams.get("dry_run") === "true"
      ? { body: { stranded_runs: 12, by_step: { wait: 12 } } } : undefined);
    open();
    const card = await screen.findByRole("article", { name: "Step wait" });
    fireEvent.click(within(card).getByRole("button", { name: "Remove step" }));
    fireEvent.click(screen.getByRole("button", { name: action }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("12 runs are waiting at steps you removed or changed. They will stop.")).toBeTruthy();
    expect(saves(fetch)).toHaveLength(0);
    expect(writes(fetch)).toHaveLength(1);
    expect(body(writes(fetch)[0]!).steps.map((step: { key: string }) => step.key)).toEqual(["trigger", "send"]);
    fireEvent.click(within(dialog).getByRole("button", { name: action === "Resume" ? /^Save and resume/ : /^Save changes/ }));
    await waitFor(() => expect(saves(fetch)).toHaveLength(1));
    expect(body(saves(fetch)[0]!)).toEqual(body(writes(fetch)[0]!));
    expect(body(saves(fetch)[0]!).status).toBe(action === "Resume" ? "enabled" : undefined);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    if (action === "Resume") {
      expect(await screen.findByText("enabled")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    } else {
      expect(screen.getByText("paused")).toBeTruthy();
      expect(screen.getByText("Saved")).toBeTruthy();
    }
  });

  it.each(["Save", "Resume"])("saves directly after a zero-impact preview on %s", async (action) => {
    const fetch = api();
    open();
    const card = await screen.findByRole("article", { name: "Step wait" });
    fireEvent.change(within(card).getByLabelText("Duration"), { target: { value: "4 days" } });
    fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(writes(fetch)).toHaveLength(2));
    expect(new URL(String(writes(fetch)[0]![0])).searchParams.get("dry_run")).toBe("true");
    expect(body(writes(fetch)[1]!)).toEqual(body(writes(fetch)[0]!));
    expect(body(writes(fetch)[1]!).steps[1].config).toEqual({ duration: "4 days" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["Save", "Resume"])("retains paused draft impact confirmation across immersive inspector dismissal before %s", async (action) => {
    const fetch = api((url) => url.searchParams.has("dry_run")
      ? { body: { stranded_runs: 2, by_step: { wait: 2 } } } : undefined);
    open("");
    fireEvent.click(await screen.findByRole("button", { name: "Step wait" }));
    const panel = screen.getByRole("region", { name: "Step wait settings" });
    fireEvent.click(within(panel).getByRole("button", { name: "Remove step" }));
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByRole("article", { name: "Step wait" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    await screen.findByText("No runs yet");
    fireEvent.click(screen.getByRole("tab", { name: "Builder" }));
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
    fireEvent.click(await screen.findByRole("button", { name: "Step send" }));
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(document.querySelector(".canvasPanel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: action }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("2 runs are waiting at steps you removed or changed. They will stop.")).toBeTruthy();
    expect(writes(fetch)).toHaveLength(1);
    expect(saves(fetch)).toHaveLength(0);
    expect(body(writes(fetch)[0]!).steps.map((step: { key: string }) => step.key)).toEqual(["trigger", "send"]);
    fireEvent.click(within(dialog).getByRole("button", { name: action === "Resume" ? /^Save and resume/ : /^Save changes/ }));
    await waitFor(() => expect(saves(fetch)).toHaveLength(1));
    expect(body(saves(fetch)[0]!)).toEqual(body(writes(fetch)[0]!));
    expect(body(saves(fetch)[0]!).status).toBe(action === "Resume" ? "enabled" : undefined);
  });

  it("cancels the stranded-run confirmation without saving", async () => {
    const fetch = api((url) => url.searchParams.has("dry_run") ? { body: { stranded_runs: 3, by_step: { wait: 3 } } } : undefined);
    open();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saves(fetch)).toHaveLength(0);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it.each([0, 3])("discards a preview reporting %i runs if the draft changed while it loaded", async (count) => {
    let release!: (reply: Reply) => void;
    const pending = new Promise<Reply>((resolve) => { release = resolve; });
    const fetch = api((url) => url.searchParams.has("dry_run") ? pending : undefined);
    open();
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "First draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(fetch)).toHaveLength(1));
    fireEvent.change(name, { target: { value: "Newer draft" } });
    release({ body: { stranded_runs: count, by_step: count ? { wait: count } : {} } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false));
    expect(saves(fetch)).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(name).toHaveProperty("value", "Newer draft");
  });

  it.each(["name", "step", "reentry"])("invalidates an open confirmation when the %s changes", async (field) => {
    const fetch = api((url) => url.searchParams.has("dry_run") ? { body: { stranded_runs: 3, by_step: { wait: 3 } } } : undefined);
    open();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "First draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("dialog");
    const control = field === "name" ? screen.getByLabelText("Name")
      : field === "step" ? screen.getByLabelText("Duration") : screen.getByLabelText("Run for each contact");
    fireEvent.change(control, { target: { value: field === "name" ? "Newer draft" : field === "step" ? "5 days" : "once" } });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saves(fetch)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("dialog");
    expect(writes(fetch)).toHaveLength(2);
    expect(saves(fetch)).toHaveLength(0);
  });

  it.each(["preview", "save"])("preserves permanent-key conflicts from the %s", async (phase) => {
    const message = 'Step key "wait" was previously used for delay and cannot be used for send_email';
    const fetch = api((url, init) => init.method === "PATCH" && url.searchParams.has("dry_run") === (phase === "preview")
      ? { status: 409, body: { name: "conflict", statusCode: 409, message } } : undefined);
    open();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", message);
    expect(saves(fetch)).toHaveLength(phase === "preview" ? 0 : 1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stops a paused automation with the active count and explicit re-entry reset", async () => {
    const fetch = api((url, init) => url.pathname.endsWith("/runs/metrics")
      ? { body: { total: 1000, totals: { running: 4, completed: 996, failed: 0, cancelled: 0 } } }
      : url.pathname.endsWith("/stop") && init.method === "POST" ? { body: { ...automation, status: "disabled" } } : undefined);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Stop and cancel runs" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText("4 runs in progress will be cancelled.")).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText("Let cancelled contacts enter again"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Stop and cancel runs/ }));
    await screen.findByRole("button", { name: "Start" });
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(new URL(String(post[0])).pathname).toBe("/automations/automation_1/stop");
    expect(body(post)).toEqual({ reset_reentry: true });
  });

  it("shows the stranded reason in the existing run error alert", async () => {
    const message = "Its next step was removed or changed while the automation was paused";
    api((url) => url.pathname.endsWith("/runs/run_1") ? { body: {
      id: "run_1", status: "cancelled", error: message, email: "ada@example.com",
      created_at: automation.created_at, updated_at: automation.created_at, steps: [],
    } } : undefined);
    open("?tab=runs&run=run_1");
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByRole("alert")).toHaveProperty("textContent", message);
  });
});
