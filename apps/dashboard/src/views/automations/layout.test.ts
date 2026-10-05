import { describe, expect, it } from "vitest";
import { branching, projectRun, toGraph, toTree, type Graph, type ListPath, type Node, type Tree } from "./graph";
import {
  branchGap,
  columnGap,
  endHeight,
  endWidth,
  layout,
  locate,
  measure,
  nodeHeight,
  nodeWidth,
  rowGap,
  runFocus,
  slotId,
  type CanvasEdge,
  type CanvasNode,
  type Slot,
  type StepNode,
} from "./layout";
import type { RunStep } from "./Steps";

const tree = (graph: Graph) => toTree(graph.steps, graph.connections).tree;

const linear: Graph = {
  steps: [
    { key: "start", type: "trigger", config: { event_name: "user.created" } },
    { key: "welcome", type: "send_email", config: { from: "a@b.co", template: { id: "tpl_1", variables: {} } } },
    { key: "pause", type: "delay", config: { duration: "1 day" } },
  ],
  connections: [
    { from: "start", to: "welcome", type: "default" },
    { from: "welcome", to: "pause", type: "default" },
  ],
};

// A condition whose True branch holds a wait with event and timeout branches, and an empty False branch.
const nested: Graph = {
  steps: [
    { key: "start", type: "trigger", config: { event_name: "user.created" } },
    { key: "pro", type: "condition", config: { type: "rule", field: "event.plan", operator: "eq", value: "pro" } },
    { key: "nudge", type: "send_email", config: { from: "a@b.co", template: { id: "tpl_1" } } },
    { key: "upgrade", type: "wait_for_event", config: { event_name: "user.upgraded", timeout: "3 days" } },
    { key: "thanks", type: "send_email", config: { from: "a@b.co", template: { id: "tpl_2" } } },
    { key: "tag", type: "add_to_segment", config: { segment_id: "seg_1" } },
    { key: "drop", type: "contact_delete", config: {} },
  ],
  connections: [
    { from: "start", to: "pro", type: "default" },
    { from: "pro", to: "nudge", type: "condition_met" },
    { from: "nudge", to: "upgrade", type: "default" },
    { from: "upgrade", to: "thanks", type: "event_received" },
    { from: "upgrade", to: "tag", type: "timeout" },
    { from: "tag", to: "drop", type: "default" },
  ],
};

const byId = (nodes: CanvasNode[], id: string) => nodes.find((node) => node.id === id)!;
const edge = (edges: CanvasEdge[], source: string, target: string) => edges.find((item) => item.source === source && item.target === target);

/** Every place the list's "+" buttons insert: before each step, and at the end of a list that does not end in a branch. */
function listSlots(tree: Tree): Slot[] {
  const slots: Slot[] = [];
  const walk = (list: Node[], path: ListPath) => {
    list.forEach((node, index) => {
      slots.push({ path, index });
      for (const [branch, children] of Object.entries(node.branches ?? {})) {
        if (branching(node)) walk(children ?? [], [...path, { key: node.key, branch: branch as never }]);
      }
    });
    const last = list.at(-1);
    if (!(last && branching(last))) slots.push({ path, index: list.length });
  };
  walk(tree.steps, []);
  return slots;
}

function canvasSlots(nodes: CanvasNode[], edges: CanvasEdge[]): Slot[] {
  return [
    ...edges.flatMap((item) => (item.data?.slot ? [item.data.slot] : [])),
    ...nodes.flatMap((node) => (node.type === "end" && node.data.slot ? [node.data.slot] : [])),
  ];
}

describe("layout", () => {
  it("stacks a list under the trigger, centered, with an end marker", () => {
    const { nodes, edges } = layout(tree(linear), { editable: true });
    expect(nodes.map((node) => [node.id, node.type, node.position])).toEqual([
      ["start", "trigger", { x: -nodeWidth / 2, y: 0 }],
      ["welcome", "step", { x: -nodeWidth / 2, y: nodeHeight + rowGap }],
      ["pause", "step", { x: -nodeWidth / 2, y: 2 * (nodeHeight + rowGap) }],
      ["end:main", "end", { x: -endWidth / 2, y: 3 * (nodeHeight + rowGap) }],
    ]);
    expect(edges.map((item) => item.id)).toEqual(["start->welcome", "welcome->pause", "pause->end:main"]);
    expect(edges.map((item) => item.data?.slot)).toEqual([{ path: [], index: 0 }, { path: [], index: 1 }, undefined]);
    expect(edges.map((item) => item.data?.addLabel)).toEqual(["Add step after the trigger", "Add step after welcome", undefined]);
    expect(byId(nodes, "end:main").data).toEqual({ slot: { path: [], index: 2 }, label: "Add step at the end", exit: false });
  });

  it("gives every node a fixed size and top and bottom handles, so edges draw before measuring", () => {
    const { nodes } = layout(tree(linear), { editable: true });
    const step = byId(nodes, "welcome");
    expect([step.width, step.height]).toEqual([nodeWidth, nodeHeight]);
    expect(step.handles).toEqual([
      { type: "target", position: "top", x: nodeWidth / 2 - 0.5, y: 0, width: 1, height: 1 },
      { type: "source", position: "bottom", x: nodeWidth / 2 - 0.5, y: nodeHeight - 1, width: 1, height: 1 },
    ]);
    expect([byId(nodes, "end:main").width, byId(nodes, "end:main").height]).toEqual([endWidth, endHeight]);
  });

  it("puts branches side by side under their step, with labeled edges", () => {
    const { nodes, edges } = layout(tree(nested), { editable: true });
    const pro = byId(nodes, "pro");
    const top = pro.position.y + nodeHeight + branchGap;
    const trueWidth = measure(tree(nested).steps[0]!.branches!.condition_met!);
    expect(trueWidth).toBe(2 * nodeWidth + columnGap);
    const left = -(trueWidth + columnGap + nodeWidth) / 2;
    expect(byId(nodes, "nudge").position).toEqual({ x: left + trueWidth / 2 - nodeWidth / 2, y: top });
    expect(byId(nodes, "end:pro.condition_not_met").position).toEqual({ x: left + trueWidth + columnGap + nodeWidth / 2 - endWidth / 2, y: top });

    expect(edge(edges, "pro", "nudge")?.data).toMatchObject({ label: "True", branch: "condition_met" });
    expect(edge(edges, "pro", "end:pro.condition_not_met")?.data).toMatchObject({ label: "False", branch: "condition_not_met" });
    // A wait labels its edges with the event name and "Timed out".
    expect(edge(edges, "upgrade", "thanks")?.data).toMatchObject({ label: "user.upgraded", branch: "event_received" });
    expect(edge(edges, "upgrade", "tag")?.data).toMatchObject({ label: "Timed out", branch: "timeout" });
    expect(edge(edges, "upgrade", "thanks")?.data?.addLabel).toBe("Add step at the start of Event received branch of upgrade");
    expect(byId(nodes, "end:pro.condition_not_met").data).toMatchObject({ label: "Add step to False branch of pro" });
    expect(byId(nodes, "end:pro.condition_met/upgrade.timeout").data).toMatchObject({ label: "Add step at the end of Timed out branch of upgrade" });
  });

  it("labels a wait's first edge Event received while it has no event name", () => {
    const graph: Graph = {
      steps: [
        { key: "start", type: "trigger", config: { event_name: "a" } },
        { key: "wait", type: "wait_for_event", config: { event_name: "" } },
        { key: "next", type: "delay", config: { duration: "1 hour" } },
      ],
      connections: [
        { from: "start", to: "wait", type: "default" },
        { from: "wait", to: "next", type: "event_received" },
      ],
    };
    const { edges } = layout(tree(graph), { editable: false });
    expect(edge(edges, "wait", "next")?.data?.label).toBe("Event received");
    expect(edge(edges, "wait", "end:wait.timeout")?.data?.label).toBe("Timed out");
  });

  it("draws one edge per connection the list would save, plus one into each end marker", () => {
    for (const graph of [linear, nested]) {
      const shape = tree(graph);
      const { edges } = layout(shape, { editable: true });
      const steps = edges.filter((item) => !item.target.startsWith("end:"));
      const saved = toGraph(shape);
      // Empty legacy lanes draw an Exit end marker and serialize an explicit Exit target.
      const exits = new Set(saved.steps.filter((step) => step.type === "exit").map((step) => step.key));
      const connections = saved.connections.filter((edge) => !exits.has(edge.to));
      expect(steps.map((item) => ({ from: item.source, to: item.target, type: item.data?.branch ?? "default" }))).toEqual(
        expect.arrayContaining(connections),
      );
      expect(steps).toHaveLength(connections.length);
    }
  });

  it("offers a + at exactly the places the list does", () => {
    for (const graph of [linear, nested]) {
      const shape = tree(graph);
      const { nodes, edges } = layout(shape, { editable: true });
      const ids = (slots: Slot[]) => slots.map(slotId).sort();
      expect(ids(canvasSlots(nodes, edges))).toEqual(ids(listSlots(shape)));
    }
    const empty: Tree = { trigger: "start", event: "", steps: [] };
    const { nodes, edges } = layout(empty, { editable: true });
    expect(canvasSlots(nodes, edges)).toEqual([{ path: [], index: 0 }]);
  });

  it("has no + anywhere when read-only", () => {
    const { nodes, edges } = layout(tree(nested), { editable: false });
    expect(canvasSlots(nodes, edges)).toEqual([]);
    expect(nodes.filter((node) => node.type === "end").every((node) => node.data.slot === null)).toBe(true);
  });

  it("never overlaps two boxes", () => {
    const { nodes } = layout(tree(nested), { editable: true });
    const boxes = nodes.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y, w: node.width!, h: node.height! }));
    for (const a of boxes) {
      for (const b of boxes) {
        if (a.id === b.id) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("counts errors per node and marks the trigger's", () => {
    const { nodes } = layout(tree(linear), { editable: true, errors: { welcome: { from: "Required.", template: "Choose a template." }, start: { event_name: "Enter the event." } } });
    expect((byId(nodes, "welcome") as StepNode).data.issues).toBe(2);
    expect((byId(nodes, "pause") as StepNode).data.issues).toBe(0);
    expect(byId(nodes, "start").data).toMatchObject({ issues: 1 });
  });

  it("tints each step by its status in a run, and not_started for steps the run never reached", () => {
    const run = new Map<string, RunStep>([
      ["pro", { key: "pro", type: "condition", status: "completed" }],
      ["nudge", { key: "nudge", type: "send_email", status: "failed", error: "Template not found" }],
    ]);
    const { nodes } = layout(tree(nested), { editable: false, run });
    const status = (id: string) => (byId(nodes, id) as StepNode).data.status;
    expect([status("pro"), status("nudge"), status("upgrade")]).toEqual(["completed", "failed", "not_started"]);
    expect((byId(nodes, "nudge") as StepNode).data.error).toBe("Template not found");
    expect(byId(nodes, "start").data).toMatchObject({ status: "completed" });
    expect((byId(layout(tree(nested), { editable: false }).nodes, "pro") as StepNode).data.status).toBeNull();
  });

  it.each([true, false])("uses display-key shared Exit projection for run tint and focus (condition %s)", (taken) => {
    const shape = toTree([
      { key: "start", type: "trigger" },
      { key: "condition", type: "condition" },
      { key: "end", type: "exit" },
    ], [
      { from: "start", to: "condition" },
      { from: "condition", to: "end", type: "condition_met" },
      { from: "condition", to: "end", type: "condition_not_met" },
    ]).tree;
    const exit: RunStep = { key: "end", type: "exit", status: "completed", output: { exited: "exit" } };
    const raw = new Map<string, RunStep>([
      ["condition", { type: "condition", status: "completed", output: { result: taken } }],
      ["end", exit],
    ]);
    const run = projectRun(shape, raw);
    const { nodes } = layout(shape, { editable: false, run });
    const reached = taken ? "end" : "end_lane";
    const skipped = taken ? "end_lane" : "end";
    expect((byId(nodes, reached) as StepNode).data.status).toBe("completed");
    expect((byId(nodes, skipped) as StepNode).data.status).toBe("not_started");
    expect(runFocus(shape, run)).toBe(reached);
    expect(locate(shape, reached)?.path).toEqual([{ key: "condition", branch: taken ? "condition_met" : "condition_not_met" }]);
    expect(run.get(reached)).toBe(exit);
    expect([...raw.keys()]).toEqual(["condition", "end"]);
  });
});

describe("locate and runFocus", () => {
  it("finds a step's list, path, and index", () => {
    const shape = tree(nested);
    const found = locate(shape, "tag")!;
    expect(found.path).toEqual([
      { key: "pro", branch: "condition_met" },
      { key: "upgrade", branch: "timeout" },
    ]);
    expect(found.index).toBe(0);
    expect(found.list.map((node) => node.key)).toEqual(["tag", "drop"]);
    expect(locate(shape, "missing")).toBeNull();
  });

  it("opens a run on its failed step, else the last step it reached", () => {
    const shape = tree(nested);
    const done = new Map<string, RunStep>([
      ["pro", { key: "pro", type: "condition", status: "completed" }],
      ["nudge", { key: "nudge", type: "send_email", status: "completed" }],
    ]);
    expect(runFocus(shape, done)).toBe("nudge");
    done.set("pro", { key: "pro", type: "condition", status: "failed", error: "Bad rule" });
    expect(runFocus(shape, done)).toBe("pro");
    expect(runFocus(shape, new Map())).toBeNull();
  });
});
