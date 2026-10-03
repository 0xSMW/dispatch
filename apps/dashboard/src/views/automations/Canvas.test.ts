// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn, type Reply } from "../../testing";
import { AutomationEditor } from "./AutomationEditor";
import { Canvas, type CanvasProps } from "./Canvas";
import { insertStep, keys, toTree, type Graph, type Tree } from "./graph";
import type { RunStep, StepActions } from "./Steps";
import { zeroEmails } from "./EmailMetrics";

// jsdom has no layout engine. React Flow needs these two to mount; with them it renders nodes
// and edges from the sizes and handles `layout()` gives, but nothing is measured, panned, or zoomed.
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class DOMMatrixReadOnly {
  m22 = 1;
}

const graph: Graph = {
  steps: [
    { key: "trigger", type: "trigger", config: { event_name: "user.created" } },
    { key: "welcome", type: "send_email", config: { from: "hi@acme.com", template: { id: "tpl_1", variables: {} } } },
    { key: "pause", type: "delay", config: { duration: "1 day" } },
    { key: "pro", type: "condition", config: { type: "rule", field: "event.plan", operator: "eq", value: "pro" } },
    { key: "upsell", type: "send_email", config: { from: "hi@acme.com", template: { id: "tpl_2" } } },
  ],
  connections: [
    { from: "trigger", to: "welcome", type: "default" },
    { from: "welcome", to: "pause", type: "default" },
    { from: "pause", to: "pro", type: "default" },
    { from: "pro", to: "upsell", type: "condition_met" },
  ],
};
const tree = toTree(graph.steps, graph.connections).tree;

function spies(): StepActions & { [K in keyof StepActions]: ReturnType<typeof vi.fn> } {
  return { insert: vi.fn(), remove: vi.fn(), move: vi.fn(), change: vi.fn(), waitBranches: vi.fn() };
}

function show(props: Partial<CanvasProps> = {}) {
  return render(h(Canvas, { tree, ...props }));
}

beforeEach(() => {
  // New steps get a random key suffix. Tests count instead, so keys can be named.
  let next = 0;
  vi.spyOn(keys, "suffix").mockImplementation(() => String(++next));
  vi.stubGlobal("ResizeObserver", ResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixReadOnly);
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("Canvas", () => {
  it("shows shared email counts in builder and run nodes without loading metrics per node", async () => {
    const options = { templates: [], segments: [], events: [], emailCounts: { welcome: { ...zeroEmails, sent: 4, opened: 2, clicked: 1 } } };
    const view = show({ actions: spies(), options });
    const node = await screen.findByRole("button", { name: "Step welcome" });
    expect(within(node).getByText("4 sent · 2 opened · 1 clicked")).toBeTruthy();
    view.rerender(h(Canvas, { tree, options, run: new Map([["welcome", { key: "welcome", type: "send_email", status: "completed" }]]) }));
    expect(within(screen.getByRole("button", { name: "Step welcome" })).getByText("4 sent · 2 opened · 1 clicked")).toBeTruthy();
  });

  it("draws the trigger, each step, branch labels, and an end marker per open list", async () => {
    show({ actions: spies() });
    expect(await screen.findByRole("button", { name: "Trigger" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trigger" }).className).toContain("nopan");
    for (const key of ["welcome", "pause", "pro", "upsell"]) expect(screen.getByRole("button", { name: `Step ${key}` })).toBeTruthy();
    expect(screen.getByText("True")).toBeTruthy();
    expect(screen.getByText("False")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add step to False branch of pro" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add step to False branch of pro" }).className).toContain("nopan");
    expect(screen.getByRole("button", { name: "Add step at the end of True branch of pro" })).toBeTruthy();
    expect(screen.getAllByText("The run ends here.")).toHaveLength(2);
    // The main list ends in a branch, so it has no end marker, as in the list.
    expect(screen.queryByRole("button", { name: "Add step at the end" })).toBeNull();
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(6);
    expect(document.querySelector(".react-flow__background")).toBeTruthy();
  });

  it("opens the grouped picker from an edge and inserts through StepActions.insert", async () => {
    const actions = spies();
    const view = show({ actions });
    fireEvent.click(await screen.findByRole("button", { name: "Add step after welcome" }));
    const picker = screen.getByRole("region", { name: "Add a step" });
    expect(within(picker).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["Messages", "Flow control", "Audience"]);
    expect(within(within(picker).getByRole("group", { name: "Flow control" })).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Time delay",
      "Wait for event",
      "True/false branch",
    ]);
    expect(within(within(picker).getByRole("group", { name: "Audience" })).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Update contact",
      "Delete contact",
      "Add to segment",
    ]);
    fireEvent.click(within(picker).getByRole("button", { name: "Time delay" }));
    expect(actions.insert).toHaveBeenCalledWith([], 1, "delay", "delay_1");

    // The parent applies the insert; the panel opens on the new step.
    view.rerender(h(Canvas, { tree: insertStep(tree, [], 1, "delay", "delay_1"), actions }));
    const panel = await screen.findByRole("region", { name: "Step delay_1 settings" });
    expect(within(panel).getByText('Examples: "2 days", "1 hour". Up to 30 days.')).toBeTruthy();
    expect(within(panel).getByLabelText(/Duration/)).toHaveProperty("value", "1 hour");
  });

  it("inserts into a branch from its end marker", async () => {
    const actions = spies();
    show({ actions });
    fireEvent.click(await screen.findByRole("button", { name: "Add step to False branch of pro" }));
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    expect(actions.insert).toHaveBeenCalledWith([{ key: "pro", branch: "condition_not_met" }], 0, "send_email", "send_email_1");
  });

  it("opens a step's form in the side panel and edits, moves, and removes it through StepActions", async () => {
    const actions = spies();
    show({ actions, options: { templates: [{ value: "tpl_1", label: "Welcome" }], segments: [], events: [] } });
    const delay = await screen.findByRole("button", { name: "Step pause" });
    expect(delay.className).toContain("nopan");
    fireEvent.click(delay);
    const panel = screen.getByRole("region", { name: "Step pause settings" });
    fireEvent.change(within(panel).getByLabelText(/Duration/), { target: { value: "2 hours" } });
    expect(actions.change).toHaveBeenCalledWith("pause", expect.any(Function));
    const change = actions.change.mock.calls[0]![1] as (node: Tree["steps"][number]) => Tree["steps"][number];
    expect(change(tree.steps[1]!).config.duration).toBe("2 hours");

    fireEvent.click(within(panel).getByRole("button", { name: "Move up" }));
    expect(actions.move).toHaveBeenCalledWith([], 1, -1);
    // The step above a branch cannot move down past it, as in the list.
    expect(within(panel).getByRole("button", { name: "Move down" })).toHaveProperty("disabled", true);
    fireEvent.click(within(panel).getByRole("button", { name: "Remove step" }));
    expect(actions.remove).toHaveBeenCalledWith([], 1, tree.steps[1]);

    fireEvent.click(screen.getByRole("button", { name: "Step upsell" }));
    const upsell = screen.getByRole("region", { name: "Step upsell settings" });
    fireEvent.click(within(upsell).getByRole("button", { name: "Remove step" }));
    expect(actions.remove).toHaveBeenLastCalledWith([{ key: "pro", branch: "condition_met" }], 0, tree.steps[2]!.branches!.condition_met![0]);
  });

  it("edits the trigger event in the panel", async () => {
    const onEvent = vi.fn();
    show({ actions: spies(), onEvent, errors: { trigger: { event_name: "Enter the event that starts this automation." } } });
    const trigger = await screen.findByRole("button", { name: "Trigger" });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(trigger);
    const panel = screen.getByRole("region", { name: "Trigger settings" });
    expect(within(panel).getByText("Enter the event that starts this automation.")).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText("Event"), { target: { value: "user.signed_up" } });
    expect(onEvent).toHaveBeenCalledWith("user.signed_up");
  });

  it("marks steps with errors and shows them on the fields once selected", async () => {
    show({ actions: spies(), errors: { welcome: { from: "Use email@domain or Name <email@domain>.", _step: "headers: Too many headers" } } });
    const node = await screen.findByRole("button", { name: "Step welcome" });
    expect(node.getAttribute("aria-invalid")).toBe("true");
    expect(node.className).toContain("invalid");
    expect(screen.getByRole("button", { name: "Step pause" }).getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(node);
    const panel = screen.getByRole("region", { name: "Step welcome settings" });
    expect(within(panel).getByText("Use email@domain or Name <email@domain>.")).toBeTruthy();
    expect(within(panel).getByText("headers: Too many headers")).toBeTruthy();
  });

  it.each([
    { config: { type: "contact_created" }, label: "Contact added", summary: "Any new contact" },
    { config: { type: "contact_updated", field: "unsubscribed", from: false, to: true }, label: "Contact changes", summary: "unsubscribed: false → true" },
    { config: { type: "topic_subscribed", topic_id: "topic_1" }, label: "Subscribed to topic", summary: "News" },
    { config: { type: "segment_added", segment_id: "seg_1" }, label: "Added to segment", summary: "Trials" },
  ])("draws the shared $label label and summary in the canvas and panel", async ({ config, label, summary }) => {
    const contactTree = toTree([{ key: "trigger", type: "trigger", config }]).tree;
    const onTrigger = vi.fn();
    show({ tree: contactTree, actions: spies(), onTrigger, options: {
      templates: [], events: [], segments: [{ value: "seg_1", label: "Trials" }], topics: [{ value: "topic_1", label: "News" }],
    } });
    const trigger = await screen.findByRole("button", { name: "Trigger" });
    expect(within(trigger).getByText(label)).toBeTruthy();
    expect(within(trigger).getByText(summary)).toBeTruthy();
    fireEvent.click(trigger);
    const panel = within(screen.getByRole("region", { name: "Trigger settings" }));
    expect(panel.getByText(label)).toBeTruthy();
    fireEvent.change(panel.getByLabelText("Trigger"), { target: { value: "contact_created" } });
    expect(onTrigger).toHaveBeenCalledWith({ type: "contact_created" });
  });

  it("shows each condition its own number when the selection moves between two of them", async () => {
    const nested = toTree(
      [
        { key: "trigger", type: "trigger", config: { event_name: "user.created" } },
        { key: "big", type: "condition", config: { type: "rule", field: "event.seats", operator: "gt", value: 5 } },
        { key: "huge", type: "condition", config: { type: "rule", field: "event.seats", operator: "gt", value: 100 } },
      ],
      [
        { from: "trigger", to: "big", type: "default" },
        { from: "big", to: "huge", type: "condition_met" },
      ],
    ).tree;
    show({ tree: nested, actions: spies() });
    fireEvent.click(await screen.findByRole("button", { name: "Step big" }));
    expect(within(screen.getByRole("region", { name: "Step big settings" })).getByLabelText("Value")).toHaveProperty("value", "5");
    // The panel is rebuilt for the next step. It used to keep the first one's number in the field.
    fireEvent.click(screen.getByRole("button", { name: "Step huge" }));
    const panel = screen.getByRole("region", { name: "Step huge settings" });
    expect(within(panel).getByLabelText("Value")).toHaveProperty("value", "100");
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });

  it("counts the trigger's issues as it counts a step's", async () => {
    show({ actions: spies(), errors: { trigger: { event_name: "Enter the event that starts this automation.", _step: "Unknown event" } } });
    const node = await screen.findByRole("button", { name: "Trigger" });
    expect(node.getAttribute("aria-invalid")).toBe("true");
    expect(within(node).getByTitle("2 issues")).toBeTruthy();
  });

  it("is read-only without actions or when disabled: no +, no move or remove, fields disabled", async () => {
    for (const props of [{}, { actions: spies(), disabled: true }]) {
      const view = show(props);
      await screen.findByRole("button", { name: "Step welcome" });
      expect(screen.queryAllByRole("button", { name: /^Add step/ })).toHaveLength(0);
      expect(screen.getAllByText("End").length).toBeGreaterThan(0);
      expect(screen.getAllByText("The run ends here.").length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("button", { name: "Step welcome" }));
      const panel = screen.getByRole("region", { name: "Step welcome settings" });
      expect(within(panel).queryByRole("button", { name: "Remove step" })).toBeNull();
      expect(within(panel).getByLabelText(/From/)).toHaveProperty("disabled", true);
      fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
      expect(within(screen.getByRole("region", { name: "Trigger settings" })).getByLabelText("Event")).toHaveProperty("disabled", true);
      view.unmount();
    }
  });

  it("tints each node by its run status and opens on the failed step's error and output", async () => {
    const run = new Map<string, RunStep>([
      ["welcome", { key: "welcome", type: "send_email", status: "completed", output: { email_id: "email_9" } }],
      ["pause", { key: "pause", type: "delay", status: "completed" }],
      ["pro", { key: "pro", type: "condition", status: "failed", error: "Rule could not be read" }],
    ]);
    show({ run, stacked: true });
    const welcome = await screen.findByRole("button", { name: "Step welcome" });
    expect(welcome.className).toContain("tint success");
    expect(screen.getByRole("button", { name: "Step pro" }).className).toContain("tint danger");
    expect(screen.getByRole("button", { name: "Step upsell" }).className).toContain("tint skipped");
    expect(screen.queryAllByRole("button", { name: /^Add step/ })).toHaveLength(0);

    const panel = screen.getByRole("region", { name: "Step pro settings" });
    expect(within(panel).getByRole("alert").textContent).toBe("Rule could not be read");
    fireEvent.click(welcome);
    expect(within(screen.getByRole("region", { name: "Step welcome settings" })).getByText(/email_9/)).toBeTruthy();
  });
});

// The whole editor with the canvas switched on, through the same save path the list uses.

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

function api(overrides: (url: URL, init: RequestInit) => Reply | undefined = () => undefined) {
  return mockFetch((raw, init) => {
    const url = new URL(raw);
    const custom = overrides(url, init);
    if (custom) return custom;
    if (url.pathname === "/automations/automation_1") return { body: automation };
    return list([]);
  });
}

function open(path: string) {
  const router = createMemoryRouter(
    [{ element: h(SessionProvider, null, h(Outlet)), children: [{ path: "/automations/:id/editor", element: h(AutomationEditor) }] }],
    { initialEntries: [path] },
  );
  render(h(RouterProvider, { router }));
}

describe("AutomationEditor on the canvas", () => {
  beforeEach(() => signIn());

  it("shares manual date types and send mappings across list and canvas without wire metadata", async () => {
    const fetch = api((url, init) => init.method === "PATCH" ? { body: { ...automation, ...JSON.parse(String(init.body)) } } : undefined);
    open("/automations/automation_1/editor");
    const card = await screen.findByRole("article", { name: "Step pro" });
    fireEvent.change(within(card).getByLabelText("Type"), { target: { value: "date" } });
    fireEvent.change(within(card).getByLabelText("Value"), { target: { value: "2026-10-04" } });
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
    fireEvent.click(await screen.findByRole("button", { name: "Step pro" }));
    const condition = screen.getByRole("region", { name: "Step pro settings" });
    expect(within(condition).getByLabelText("Type")).toHaveProperty("value", "date");
    fireEvent.change(within(condition).getByLabelText("Operator"), { target: { value: "within" } });
    fireEvent.change(within(condition).getByLabelText("Duration"), { target: { value: "2 days" } });
    fireEvent.click(screen.getByRole("button", { name: "Step welcome" }));
    const send = screen.getByRole("region", { name: "Step welcome settings" });
    fireEvent.click(within(send).getByRole("button", { name: "Add mapping" }));
    fireEvent.change(within(send).getByLabelText("Variable name"), { target: { value: "received" } });
    fireEvent.change(within(send).getByLabelText("Choose context field"), { target: { value: "event.received_at" } });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(await within(screen.getByRole("article", { name: "Step welcome" })).findByLabelText("Context field")).toHaveProperty("value", "event.received_at");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body));
    expect(body.steps[1].config.variable_mapping).toEqual({ received: "event.received_at" });
    expect(body.steps[2].config).toEqual({ type: "rule", field: "event.plan", operator: "within", value: "2 days" });
    expect(JSON.stringify(body)).not.toContain("ruleTypes");
  });

  it("keeps typed rule and mapping controls disabled for viewers", async () => {
    signIn("sess_test", ["read"]);
    api();
    open("/automations/automation_1/editor?view=canvas");
    fireEvent.click(await screen.findByRole("button", { name: "Step pro" }));
    const condition = screen.getByRole("region", { name: "Step pro settings" });
    for (const field of condition.querySelectorAll("select, input")) expect(field).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Step welcome" }));
    expect(within(screen.getByRole("region", { name: "Step welcome settings" })).getByRole("button", { name: "Add mapping" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("switches between List and Canvas and saves the same graph the list test saves", async () => {
    const fetch = api((url, init) =>
      url.pathname === "/automations/automation_1" && init.method === "PATCH" ? { body: { ...automation, ...JSON.parse(String(init.body)) } } : undefined,
    );
    open("/automations/automation_1/editor");
    await screen.findByRole("article", { name: "Step welcome" });
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));

    fireEvent.click(await screen.findByRole("button", { name: "Add step to False branch of pro" }));
    fireEvent.click(screen.getByRole("button", { name: "Time delay" }));
    expect(await screen.findByRole("region", { name: "Step delay_1 settings" })).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body));
    expect(body.steps.map((step: { key: string }) => step.key)).toEqual(["trigger", "welcome", "pro", "delay_1"]);
    expect(body.steps[3]).toEqual({ key: "delay_1", type: "delay", config: { duration: "1 hour" } });
    expect(body.connections).toEqual([
      { from: "trigger", to: "welcome", type: "default" },
      { from: "welcome", to: "pro", type: "default" },
      { from: "pro", to: "delay_1", type: "condition_not_met" },
    ]);

    // Back to the list: the same draft, with the new step on its card.
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(await screen.findByRole("article", { name: "Step delay_1" })).toBeTruthy();
  });

  it("marks invalid nodes after a blocked save and shows the errors on the selected step", async () => {
    const fetch = api();
    open("/automations/automation_1/editor?view=canvas");
    fireEvent.click(await screen.findByRole("button", { name: "Step welcome" }));
    const panel = screen.getByRole("region", { name: "Step welcome settings" });
    fireEvent.change(within(panel).getByLabelText(/From/), { target: { value: "not an address" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await within(panel).findByText("Use email@domain or Name <email@domain>.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Step welcome" }).getAttribute("aria-invalid")).toBe("true");
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("is read-only on the canvas once enabled", async () => {
    api((url, init) => (url.pathname === "/automations/automation_1" && !init.method ? { body: { ...automation, status: "enabled" } } : undefined));
    open("/automations/automation_1/editor?view=canvas");
    await screen.findByText(/Enabled automations cannot be edited/);
    fireEvent.click(await screen.findByRole("button", { name: "Step welcome" }));
    expect(screen.queryAllByRole("button", { name: /^Add step/ })).toHaveLength(0);
    expect(within(screen.getByRole("region", { name: "Step welcome settings" })).getByLabelText(/From/)).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Remove step" })).toBeNull();
  });

  it("shows the stored JSON, not a canvas, for a graph the tree cannot hold", async () => {
    const broken = { ...automation, steps: [...automation.steps, { key: "orphan", type: "delay", config: { duration: "1 hour" } }] };
    api((url, init) => (url.pathname === "/automations/automation_1" && !init.method ? { body: broken } : undefined));
    open("/automations/automation_1/editor?view=canvas");
    expect(await screen.findByText(/without losing steps/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Canvas" })).toBeNull();
    expect(document.querySelector(".react-flow")).toBeNull();
  });

  it("offers the canvas in the run drawer, tinted by the run", async () => {
    api((url) => {
      if (url.pathname === "/automations/automation_1/runs/run_1") {
        return {
          body: {
            object: "automation_run",
            id: "run_1",
            status: "failed",
            event: { id: "evt_1", name: "user.created", email: "ada@example.com", payload: {} },
            error: "Template not found",
            created_at: "2026-09-02T10:00:00.000Z",
            updated_at: "2026-09-02T10:00:03.000Z",
            steps: [{ key: "welcome", type: "send_email", status: "failed", started_at: "2026-09-02T10:00:01.000Z", completed_at: null, output: {}, error: "Template tpl_1 not found" }],
          },
        };
      }
      return undefined;
    });
    open("/automations/automation_1/editor?tab=runs&run=run_1");
    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByRole("article", { name: "Step welcome" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Canvas" }));
    const node = await within(drawer).findByRole("button", { name: "Step welcome" });
    expect(node.className).toContain("tint danger");
    expect(within(drawer).getByRole("button", { name: "Step pro" }).className).toContain("tint skipped");
    const panel = within(drawer).getByRole("region", { name: "Step welcome settings" });
    expect(within(panel).getByText("Template tpl_1 not found")).toBeTruthy();
  });
});
