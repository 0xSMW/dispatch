// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { callAt, h, mockFetch, signIn } from "../../testing";
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
    const fetch = mockFetch(() => ({ body: { object: "list", has_more: false, data: rows } }));
    open("/automations?status=enabled");
    expect(await screen.findByText("Welcome")).toBeTruthy();
    expect(callAt(fetch).url).toBe("http://localhost:3100/automations?status=enabled&limit=40");
    expect(screen.getByText("1,204")).toBeTruthy();
    expect(screen.getByText("user.idle")).toBeTruthy();
    expect(screen.getAllByText("enabled").length).toBeGreaterThan(0);
    const learn = within(screen.getByRole("navigation", { name: "Learn more" }));
    expect(learn.getByRole("link", { name: "Triggers" }).getAttribute("href")).toContain("automations.md#triggers");
    expect(learn.getByRole("link", { name: "Conditions" }).getAttribute("href")).toContain("automations.md#conditions");
    expect(learn.queryByRole("link", { name: "Lifecycle recipes" })).toBeNull();
  });

  it("creates a disabled automation with only its trigger, then opens the builder", async () => {
    const fetch = mockFetch((url, init) => {
      if (init.method === "POST") return { body: { id: "automation_3", name: "Onboarding", status: "disabled", steps: [], created_at: "" } };
      if (new URL(url).pathname === "/events") return { body: { object: "list", has_more: false, data: [{ id: "evdef_1", name: "user.created", schema: {} }] } };
      return { body: { object: "list", has_more: false, data: rows } };
    });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Create automation" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: "Onboarding" } });
    fireEvent.change(within(dialog).getByLabelText("Trigger event"), { target: { value: "user.created" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/automations/automation_3/editor"));
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(post[0])).toBe("http://localhost:3100/automations");
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      name: "Onboarding",
      steps: [{ key: "trigger", type: "trigger", config: { event_name: "user.created" } }],
      connections: [],
    });
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

  it("stops an enabled automation after confirming", async () => {
    const fetch = mockFetch((_url, init) =>
      init.method === "POST" ? { body: { ...rows[0], status: "disabled" } } : { body: { object: "list", has_more: false, data: rows } },
    );
    open();
    const row = (await screen.findByText("Welcome")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(String(fetch.mock.calls.find(([, init]) => init?.method === "POST")![0])).toBe("http://localhost:3100/automations/automation_1/stop");
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
