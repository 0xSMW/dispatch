// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automations } from "../../../../../packages/templates/library.json";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn } from "../../testing";
import { automationCsv, Automations } from "./Automations";

const rows = [
  { id: "automation_1", name: "Welcome", status: "enabled", trigger: "user.created", run_count: 1204, created_at: "2026-09-01T00:00:00.000Z" },
  { id: "automation_2", name: "Win back", status: "disabled", trigger: "user.idle", run_count: 0, created_at: "2026-09-02T00:00:00.000Z" },
];

function Where() {
  const location = useLocation();
  return h("p", { "data-testid": "location" }, location.pathname);
}

function open(path = "/automations") {
  return render(
    h(
      MemoryRouter,
      { initialEntries: [path] },
      h(SessionProvider, null, h(Routes, null, h(Route, { path: "/automations", element: h(Automations) }), h(Route, { path: "*", element: null })), h(Where)),
    ),
  );
}

describe("Automations", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists automations with the status filter from the URL, run counts, and status", async () => {
    const fetch = mockFetch((url) => ({ body: { object: "list", has_more: false,
      data: new URL(url).pathname === "/automations" ? rows : new URL(url).pathname === "/template-library/automations" ? automations : [] } }));
    open("/automations?status=enabled");
    expect(await screen.findByText("Welcome")).toBeTruthy();
    expect(String(fetch.mock.calls.find(([url]) => new URL(String(url)).pathname === "/automations")![0])).toBe("http://localhost:3100/automations?status=enabled&limit=40");
    expect(screen.getByText("1,204")).toBeTruthy();
    expect(screen.getByText("user.idle")).toBeTruthy();
    expect(screen.getAllByText("enabled").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Start blank" })).toBeTruthy();
    await screen.findByRole("button", { name: automations[0]!.name });
    expect(screen.getAllByRole("button", { name: "Install as automation" })).toHaveLength(6);
    const learn = within(screen.getByRole("navigation", { name: "Learn more" }));
    expect(learn.getByRole("link", { name: "Triggers" }).getAttribute("href")).toContain("automations.md#triggers");
    expect(learn.getByRole("link", { name: "Conditions" }).getAttribute("href")).toContain("automations.md#conditions");
    const recipes = learn.queryByRole("link", { name: "Lifecycle recipes" });
    if (recipes) expect(recipes.getAttribute("href")).toContain("automations/README.md");
  });
  it("displays and exports paused status without treating it as disabled", async () => {
    const paused = { ...rows[0], status: "paused" as const, version: 2, steps: [] };
    const fetch = mockFetch((raw) => ({ body: { object: "list", has_more: false,
      data: new URL(raw).pathname === "/automations" ? [paused] : [] } }));
    open("/automations?status=paused");
    expect(await screen.findByText("Welcome")).toBeTruthy();
    const row = screen.getByText("Welcome").closest("tr")!;
    expect(within(row).getByText("paused")).toBeTruthy();
    expect(screen.getByRole("option", { name: "paused" })).toBeTruthy();
    expect(String(fetch.mock.calls.find(([url]) => new URL(String(url)).pathname === "/automations")![0])).toContain("status=paused");
    expect(automationCsv.find((column) => column.header === "status")!.value(paused)).toBe("paused");
  });

  it.each([
    { status: "enabled", action: "Pause", target: "paused" },
    { status: "paused", action: "Resume", target: "enabled" },
  ])("offers $action and destructive Stop for an $status row", async ({ status, action, target }) => {
    const fetch = mockFetch((raw, init) => init.method === "PATCH"
      ? { body: { ...rows[0], status: target } }
      : { body: { object: "list", has_more: false, data: new URL(raw).pathname === "/automations" ? [{ ...rows[0], status }] : [] } });
    open();
    const row = (await screen.findByText("Welcome")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Stop and cancel runs" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Start" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: action }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const patch = fetch.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(new URL(String(patch[0])).pathname).toBe("/automations/automation_1");
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ status: target });
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each(["enabled", "paused"])("does not expose lifecycle writes to a viewer on a %s row", async (status) => {
    signIn("sess_viewer", ["read"]);
    const fetch = mockFetch((raw) => ({ body: { object: "list", has_more: false,
      data: new URL(raw).pathname === "/automations" ? [{ ...rows[0], status }] : [] } }));
    open();
    const row = (await screen.findByText("Welcome")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Open builder" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "View runs" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Pause|Resume|Stop and cancel runs|Start|Delete|Duplicate/ })).toBeNull();
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH" || init?.method === "POST")).toBe(false);
  });

  it("creates a disabled automation with only its trigger, then opens the builder", async () => {
    const fetch = mockFetch((url, init) => {
      if (init.method === "POST") return { body: { id: "automation_3", name: "Onboarding", status: "disabled", steps: [], created_at: "" } };
      if (new URL(url).pathname === "/events") return { body: { object: "list", has_more: false, data: [{ id: "evdef_1", name: "user.created", schema: {} }] } };
      return { body: { object: "list", has_more: false, data: rows } };
    });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Create automation" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start blank" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: "Onboarding" } });
    fireEvent.change(within(dialog).getByLabelText("Trigger event"), { target: { value: "user.created" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/automations/automation_3/editor"));
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(post[0])).toBe("http://localhost:3100/automations");
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      name: "Onboarding",
      reentry: "every_time",
      steps: [{ key: "trigger", type: "trigger", config: { type: "event", event_name: "user.created" } }],
      connections: [],
    });
  });

  it.each([
    { type: "contact_created" },
    { type: "contact_updated" },
    { type: "topic_subscribed", topic_id: "topic_1" },
    { type: "segment_added", segment_id: "seg_1" },
  ])("creates a $type automation without an event name", async (config) => {
    const fetch = mockFetch((raw, init) => {
      if (init.method === "POST") return { body: { id: "automation_3" } };
      const path = new URL(raw).pathname;
      const data = path === "/automations" ? rows : path === "/topics" ? [{ id: "topic_1", name: "News" }]
        : path === "/segments" ? [{ id: "seg_1", name: "Trials" }] : [];
      return { body: { object: "list", has_more: false, data } };
    });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Create automation" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start blank" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Lifecycle" } });
    fireEvent.change(dialog.getByLabelText("Trigger"), { target: { value: config.type } });
    if ("topic_id" in config) {
      await dialog.findByRole("option", { name: "News" });
      fireEvent.change(dialog.getByLabelText("Topic"), { target: { value: config.topic_id } });
    }
    if ("segment_id" in config) {
      await dialog.findByRole("option", { name: "Trials" });
      fireEvent.change(dialog.getByLabelText("Segment"), { target: { value: config.segment_id } });
    }
    expect(dialog.queryByLabelText("Trigger event")).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: /^Create/ }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/automations/automation_3/editor"));
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      name: "Lifecycle", reentry: "once", steps: [{ key: "trigger", type: "trigger", config }], connections: [],
    });
  });

  it("shows resource names and blocks starting a trigger with a deleted topic", async () => {
    const fetch = mockFetch((raw) => {
      const path = new URL(raw).pathname;
      return { body: { object: "list", has_more: false, data: path === "/automations" ? [
        { ...rows[1], trigger: null, trigger_config: { type: "topic_subscribed", topic_id: "missing" } },
        { ...rows[0], trigger: null, trigger_config: { type: "segment_added", segment_id: "seg_1" } },
      ] : path === "/segments" ? [{ id: "seg_1", name: "Trials" }] : [] } };
    });
    open();
    expect(await screen.findByText("Added to segment: Trials")).toBeTruthy();
    expect(await screen.findByText(/Its topic was deleted/)).toBeTruthy();
    const row = screen.getByText("Win back").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    const start = await screen.findByRole("menuitem", { name: "Start" });
    expect(start).toHaveProperty("disabled", true);
    fireEvent.click(start);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("keeps an explicit creation re-entry choice when the trigger changes", async () => {
    const fetch = mockFetch((_raw, init) => init.method === "POST" ? { body: { id: "automation_3" } } : { body: { object: "list", has_more: false, data: [] } });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Create automation" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start blank" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Lifecycle" } });
    expect(dialog.getByLabelText("Run for each contact")).toHaveProperty("value", "every_time");
    fireEvent.change(dialog.getByLabelText("Trigger"), { target: { value: "contact_created" } });
    expect(dialog.getByLabelText("Run for each contact")).toHaveProperty("value", "once");
    fireEvent.change(dialog.getByLabelText("Run for each contact"), { target: { value: "every_time" } });
    fireEvent.change(dialog.getByLabelText("Trigger"), { target: { value: "contact_updated" } });
    expect(dialog.getByLabelText("Run for each contact")).toHaveProperty("value", "every_time");
    fireEvent.click(dialog.getByRole("button", { name: /^Create/ }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body))).toMatchObject({
      reentry: "every_time", steps: [{ config: { type: "contact_updated" } }],
    });
  });

  it("hides writes from viewers while still showing contact triggers", async () => {
    signIn("sess_viewer", ["read"]);
    mockFetch((raw) => ({ body: { object: "list", has_more: false, data: new URL(raw).pathname === "/automations"
      ? [{ ...rows[1], trigger: null, trigger_config: { type: "contact_created" } }] : [] } }));
    open();
    expect(await screen.findByText("Contact added: Any new contact")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create automation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.queryByRole("menuitem", { name: "Start" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("starts a disabled automation from the row menu", async () => {
    const fetch = mockFetch((_url, init) =>
      init.method === "PATCH" ? { body: { ...rows[1], status: "enabled" } } : { body: { object: "list", has_more: false, data: rows } },
    );
    open();
    const row = (await screen.findByText("Win back")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Start" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const patch = fetch.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(String(patch[0])).toBe("http://localhost:3100/automations/automation_2");
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ status: "enabled" });
  });

  it.each(["enabled", "paused"])("stops a %s automation after confirming its active count and reset choice", async (status) => {
    const fetch = mockFetch((url, init) => {
      if (new URL(url).pathname.endsWith("/runs/metrics")) return { body: { totals: { running: 3 } } };
      return init.method === "POST" ? { body: { ...rows[0], status: "disabled" } } : { body: { object: "list", has_more: false, data: [{ ...rows[0], status }, rows[1]] } };
    });
    open();
    const row = (await screen.findByText("Welcome")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop and cancel runs" }));
    expect(await screen.findByText("3 runs in progress will be cancelled.")).toBeTruthy();
    if (status === "paused") fireEvent.click(screen.getByLabelText("Let cancelled contacts enter again"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(String(fetch.mock.calls.find(([, init]) => init?.method === "POST")![0])).toBe("http://localhost:3100/automations/automation_1/stop");
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body))).toEqual({ reset_reentry: status === "paused" });
  });

  it("selects every row with Cmd+A and opens delete with Backspace", async () => {
    mockFetch(() => ({ body: { object: "list", has_more: false, data: rows } }));
    open();
    await screen.findByText("Welcome");
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("DELETE 2 AUTOMATIONS")).toBeTruthy();
  });

  it("exports the page as CSV", () => {
    expect(automationCsv.map((column) => column.value(rows[0] as never))).toEqual(["automation_1", "Welcome", "enabled", "user.created", 1204, "2026-09-01T00:00:00.000Z"]);
  });
});
