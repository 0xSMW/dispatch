import { changeControl, controlValue } from "../../testingControls";
// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn } from "../../testing";
import { AutomationEditor } from "./AutomationEditor";
import { Canvas } from "./Canvas";
import {
  configuredPaths, insertStep, keys, moveStep, removeStep, setBranchPaths, setWaitBranches, toGraph, treeIssues, updateNode,
  type Node, type Tree,
} from "./graph";
import { RunDrawer } from "./Runs";
import { StepList, type StepActions, type StepOptions } from "./Steps";
import type { AutomationRunDetail } from "../../types";

const exit = (key: string): Node => ({ key, type: "exit", config: {} });
const branch = (): Node => ({
  key: "split", type: "branch", config: { paths: [
    { key: "seats", label: "Large teams", rule: { type: "rule", field: "event.seats", operator: "gt", value: 10 } },
    { key: "paid", label: "Paid", rule: { type: "rule", field: "event.paid", operator: "eq", value: true } },
  ] }, paths: [
    { key: "seats", label: "Large teams", steps: [exit("leave_large")] },
    { key: "paid", label: "Paid", steps: [exit("leave_paid")] },
    { key: "otherwise", label: "Otherwise", steps: [exit("leave_otherwise")] },
  ],
});
const initial = (): Tree => ({ trigger: "trigger", event: "signup", steps: [
  { key: "audience", type: "filter", config: {
    rule: { type: "rule", field: "contact.activated", operator: "eq", value: false }, scope: "next",
  } }, branch(),
] });
const options: StepOptions = {
  templates: [], segments: [], events: ["signup"], eventName: "signup",
  eventDefinitions: [{ id: "event", name: "signup", schema: { seats: "number", paid: "boolean" }, created_at: "" }],
  contactProperties: [{ object: "contact_property", id: "property", key: "activated", type: "boolean", fallback_value: null, created_at: "", updated_at: "" }],
};

function Builder({ start = initial(), disabled = false, canvas = false }: { start?: Tree; disabled?: boolean; canvas?: boolean }) {
  const [tree, setTree] = useState(start);
  const [view, setView] = useState(canvas ? "canvas" : "list");
  const actions: StepActions = {
    insert: (path, index, type, key) => setTree((tree) => insertStep(tree, path, index, type, key)),
    remove: (path, index) => setTree((tree) => removeStep(tree, path, index)),
    move: (path, index, delta) => setTree((tree) => moveStep(tree, path, index, delta)),
    change: (key, change) => setTree((tree) => updateNode(tree, key, change)),
    waitBranches: (path, index, on) => setTree((tree) => setWaitBranches(tree, path, index, on)),
  };
  return h("div", null,
    h("button", { onClick: () => setView(view === "list" ? "canvas" : "list") }, "Switch view"),
    view === "list"
      ? h(StepList, { nodes: tree.steps, actions: disabled ? undefined : actions, disabled, options, errors: treeIssues(tree) })
      : h(Canvas, { tree, actions: disabled ? undefined : actions, disabled, options, errors: treeIssues(tree) }),
    h("output", { "data-testid": "graph" }, JSON.stringify(toGraph(tree))),
    h("output", { "data-testid": "tree" }, JSON.stringify(tree)),
  );
}
const graph = () => JSON.parse(screen.getByTestId("graph").textContent!);
const tree = () => JSON.parse(screen.getByTestId("tree").textContent!) as Tree;
const pathSettings = (index: number) => within(screen.getByRole("region", { name: `Path ${index} settings` }));

beforeEach(() => {
  let next = 0;
  vi.spyOn(keys, "suffix").mockImplementation(() => String(++next));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("flow control editors", () => {
  it("shows ordered labeled lanes with Otherwise last and explicit terminal Exit cards", () => {
    render(h(Builder));
    expect(screen.getAllByRole("region", { name: /branch of split/ }).map((section) => section.getAttribute("aria-label")))
      .toEqual(["Large teams branch of split", "Paid branch of split", "Otherwise branch of split"]);
    for (const key of ["leave_large", "leave_paid", "leave_otherwise"]) {
      expect(within(screen.getByRole("article", { name: `Step ${key}` })).getByText("Exit")).toBeTruthy();
    }
    expect(graph().connections.filter((edge: { from: string }) => edge.from.startsWith("leave"))).toEqual([]);
    expect(screen.getAllByRole("button", { name: "Add step" })).toHaveLength(5); // Before Filter, Branch and each Exit, not after a terminal.
  });

  it("edits typed Filter scope and ordered path rules through the shared editor without wire metadata", () => {
    render(h(Builder));
    const filter = within(screen.getByRole("article", { name: "Step audience" }));
    changeControl(filter.getByLabelText("Check"), { target: { value: "following" } });
    changeControl(filter.getByLabelText("Value"), { target: { value: "true" } });
    expect(graph().steps[1].config).toEqual({
      rule: { type: "rule", field: "contact.activated", operator: "eq", value: true }, scope: "following",
    });
    changeControl(pathSettings(1).getByLabelText("Value"), { target: { value: "24.5" } });
    expect(graph().steps[2].config.paths[0].rule.value).toBe(24.5);
    changeControl(pathSettings(2).getByLabelText("Value"), { target: { value: "false" } });
    expect(graph().steps[2].config.paths[1].rule.value).toBe(false);
    expect(screen.getByTestId("graph").textContent).not.toMatch(/ruleTypes|drafts/);
  });

  it("keeps permanent path keys, descendants and manual types through rename, reorder and view switches", async () => {
    render(h(Builder));
    changeControl(pathSettings(1).getByLabelText("Field"), { target: { value: "event.unknown" } });
    changeControl(pathSettings(1).getByLabelText("Type"), { target: { value: "date" } });
    changeControl(pathSettings(1).getByLabelText("Operator"), { target: { value: "within" } });
    changeControl(pathSettings(1).getByLabelText("Duration"), { target: { value: "7 days" } });
    changeControl(pathSettings(1).getByLabelText("Path label"), { target: { value: "Recent <script>not markup</script>" } });
    fireEvent.click(pathSettings(1).getByRole("button", { name: "Move path 1 down" }));
    expect(configuredPaths(tree().steps[1]!).map((path) => path.key)).toEqual(["paid", "seats"]);
    expect(tree().steps[1]!.paths?.[1]?.steps[0]?.key).toBe("leave_large");
    expect(controlValue(pathSettings(2).getByLabelText("Type"))).toBe("date");
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch view" }));
    fireEvent.click(await screen.findByRole("button", { name: "Step split" }));
    expect(controlValue(pathSettings(2).getByLabelText("Type"))).toBe("date");
    expect(controlValue(pathSettings(2).getByLabelText("Duration"))).toBe("7 days");
    expect(graph().steps[2].config.paths[1]).toEqual({
      key: "seats", label: "Recent <script>not markup</script>",
      rule: { type: "rule", field: "event.unknown", operator: "within", value: "7 days" },
    });
    expect(screen.getByTestId("graph").textContent).not.toMatch(/ruleTypes|drafts/);
  });

  it("adds and removes empty paths within the 2..10 limit, preserving Otherwise", () => {
    render(h(Builder));
    expect(pathSettings(1).getByRole("button", { name: "Remove path 1" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Add path" }));
    const added = configuredPaths(tree().steps[1]!)[2]!.key;
    expect(added).not.toBe("otherwise");
    const edge = graph().connections.find((edge: { path?: string }) => edge.path === added);
    expect(graph().steps.find((step: { key: string }) => step.key === edge.to).type).toBe("exit");
    fireEvent.click(pathSettings(3).getByRole("button", { name: "Remove path 3" }));
    expect(configuredPaths(tree().steps[1]!)).toHaveLength(2);
    for (let index = 0; index < 8; index++) fireEvent.click(screen.getByRole("button", { name: "Add path" }));
    expect(screen.getByRole("button", { name: "Add path" })).toHaveProperty("disabled", true);
    expect(tree().steps[1]!.paths?.at(-1)?.steps[0]?.key).toBe("leave_otherwise");
  });

  it("requires confirmation before removing a path with work and removes only that lane", () => {
    const start = initial();
    start.steps[1] = setBranchPaths(start.steps[1]!, [...configuredPaths(start.steps[1]!), {
      key: "third", label: "Third", rule: { type: "rule", field: "event.paid", operator: "eq", value: false },
    }]);
    const withWork = insertStep(start, [{ key: "split", branch: "third" }], 0, "delay", "pause");
    render(h(Builder, { start: withWork }));
    fireEvent.click(pathSettings(3).getByRole("button", { name: "Remove path 3" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(graph().steps.some((step: { key: string }) => step.key === "pause")).toBe(true);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Cancel/ }));
    expect(configuredPaths(tree().steps[1]!)).toHaveLength(3);
    fireEvent.click(pathSettings(3).getByRole("button", { name: "Remove path 3" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Remove path/ }));
    expect(graph().steps.some((step: { key: string }) => step.key === "pause")).toBe(false);
    expect(graph().steps.some((step: { key: string }) => step.key === "leave_large")).toBe(true);
  });

  it("supports insertion inside Otherwise in the canvas and keeps Exit terminal", async () => {
    render(h(Builder, { canvas: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Add step at the start of Otherwise branch of split" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const panel = within(await screen.findByRole("region", { name: "Step filter_1 settings" }));
    changeControl(panel.getByLabelText("Choose field"), { target: { value: "event.paid" } });
    changeControl(panel.getByLabelText("Value"), { target: { value: "false" } });
    changeControl(panel.getByLabelText("Check"), { target: { value: "following" } });
    expect(graph().connections).toContainEqual({ from: "split", to: "filter_1", type: "branch", path: "otherwise" });
    expect(graph().connections).toContainEqual({ from: "filter_1", to: "leave_otherwise", type: "default" });
    expect(screen.queryByRole("button", { name: "Add step at the end of Otherwise branch of split" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch view" }));
    expect(controlValue(within(screen.getByRole("article", { name: "Step filter_1" })).getByLabelText("Value"))).toBe("false");
  });

  it("adds an explicit Exit from the list picker only at a safe endpoint, then edits it on the canvas", async () => {
    render(h(Builder, { start: { trigger: "trigger", event: "signup", steps: [{ key: "pause", type: "delay", config: { duration: "2 days" } }] } }));
    fireEvent.click(screen.getAllByRole("button", { name: "Add step" })[0]!);
    expect(screen.getByRole("menuitem", { name: /^Exit/ })).toHaveProperty("disabled", true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(screen.getAllByRole("button", { name: "Add step" })[1]!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Exit" }));
    expect(screen.getByRole("article", { name: "Step exit_1" })).toBeTruthy();
    expect(graph().steps.at(-1)).toEqual({ key: "exit_1", type: "exit", config: {} });
    expect(graph().connections.at(-1)).toEqual({ from: "pause", to: "exit_1", type: "default" });
    fireEvent.click(screen.getByRole("button", { name: "Switch view" }));
    fireEvent.click(await screen.findByRole("button", { name: "Step exit_1" }));
    const panel = within(screen.getByRole("region", { name: "Step exit_1 settings" }));
    expect(panel.getByText("End this run here. No following step runs.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add step at the end" })).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "Remove step" }));
    expect(graph().steps.some((step: { key: string }) => step.key === "exit_1")).toBe(false);
  });

  it.each([false, true])("disables new rule, scope and lane controls for viewers in canvas=%s", async (canvas) => {
    render(h(Builder, { disabled: true, canvas }));
    if (canvas) fireEvent.click(await screen.findByRole("button", { name: "Step split" }));
    else await screen.findByRole("article", { name: "Step split" });
    for (const control of document.querySelectorAll("input, select")) expect(control).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Add path" })).toHaveProperty("disabled", true);
    expect(pathSettings(1).getByRole("button", { name: "Move path 1 down" })).toHaveProperty("disabled", true);
    expect(screen.queryAllByRole("button", { name: /^Add step/ })).toHaveLength(0);
    if (canvas) {
      fireEvent.click(screen.getByRole("button", { name: "Step audience" }));
      expect(screen.getByLabelText("Check")).toHaveProperty("disabled", true);
    }
    expect(graph()).toEqual(toGraph(initial()));
  });
});

describe("flow control editor and run integration", () => {
  function openEditor(path = "/automations/automation/editor") {
    const router = createMemoryRouter([{ element: h(SessionProvider, null, h(Outlet)),
      children: [{ path: "/automations/:id/editor", element: h(AutomationEditor) }],
    }], { initialEntries: [path] });
    render(h(RouterProvider, { router }));
  }
  const list = (data: unknown[] = []) => ({ body: { object: "list", has_more: false, data } });

  it("previews and saves a paused flow with ordered branch connections and permanent keys", async () => {
    signIn();
    const row = { id: "automation", name: "Onboarding", status: "paused", version: 3, reentry: "once", created_at: "", ...toGraph(initial()) };
    const fetch = mockFetch((raw, init) => {
      const url = new URL(raw);
      if (url.pathname === "/automations/automation") {
        if (url.searchParams.get("dry_run") === "true") return { body: { stranded_runs: 0, by_step: {} } };
        return { body: { ...row, ...(init.method === "PATCH" ? JSON.parse(String(init.body)) : {}) } };
      }
      if (url.pathname === "/events") return list(options.eventDefinitions);
      if (url.pathname === "/contact-properties") return list(options.contactProperties);
      return list();
    });
    openEditor("/automations/automation/editor?view=list");
    changeControl(await screen.findByLabelText("Check"), { target: { value: "following" } });
    changeControl(pathSettings(1).getByLabelText("Path label"), { target: { value: "Enterprise" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2));
    const requests = fetch.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(new URL(String(requests[0]![0])).searchParams.get("dry_run")).toBe("true");
    const body = JSON.parse(String(requests[1]![1]!.body));
    expect(body.steps.map((step: { key: string }) => step.key)).toEqual(row.steps.map((step) => step.key));
    expect(body.connections).toEqual(row.connections);
    expect(body.steps[1].config.scope).toBe("following");
    expect(body.steps[2].config.paths[0]).toMatchObject({ key: "seats", label: "Enterprise" });
    expect(body.reentry).toBe("once");
    expect(body.status).toBeUndefined();
  });

  it("shows a filter failure from a saved guard and the chosen branch label in the run drawer", async () => {
    signIn();
    const run: AutomationRunDetail = {
      id: "run", status: "completed", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:01:00Z",
      exit_reason: "filter", guards: [{ filter: "audience", rule: { type: "rule", field: "contact.activated", operator: "eq", value: false } }],
      steps: [
        { key: "split", type: "branch", status: "completed", output: { path: "paid" } },
        { key: "leave_paid", type: "exit", status: "completed", output: { exited: "filter", filter: "audience" } },
      ],
    };
    mockFetch(() => ({ body: run }));
    render(h(SessionProvider, null, h(MemoryRouter, null, h(RunDrawer, {
      automationId: "automation", runId: "run", tree: initial(), onClose: () => undefined, options,
    }))));
    expect(await screen.findByText("Left at the Filter step: Activated is not false (audience).")).toBeTruthy();
    expect(screen.getByText("Took the Paid path.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
    fireEvent.click(await screen.findByRole("button", { name: "Step split" }));
    expect(screen.getByText("Took the Paid path.")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^Add step/ })).toHaveLength(0);
  });
});
