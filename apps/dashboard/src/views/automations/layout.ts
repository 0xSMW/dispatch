// The canvas view of the automation tree: where each node sits, and the
// nodes and edges React Flow draws. Pure, so it runs and is tested without a browser. Only types
// come from @xyflow/react, so importing this file does not pull the library into the main bundle.
import type { Edge as FlowEdge, Node as FlowNode, NodeHandle } from "@xyflow/react";
import { branchLabels, branchesOf, branching, type Branch, type ListPath, type Node, type Tree } from "./graph";
import type { RunStep } from "./Steps";

// Node boxes have a fixed size so the layout needs no measuring. `styles/canvas.css` uses the same numbers.
export const nodeWidth = 248;
export const nodeHeight = 100;
export const endWidth = 132;
export const endHeight = 54;
/** Vertical space between a step and the next one in its list. */
export const rowGap = 56;
/** Vertical space under a branching step, where the edges turn and carry their labels. */
export const branchGap = 112;
/** Horizontal space between two branches. */
export const columnGap = 40;

/** Where an insert goes: before `index` in the list at `path`, as `StepActions.insert` takes it. */
export type Slot = { path: ListPath; index: number };

export type StepData = {
  node: Node;
  path: ListPath;
  index: number;
  list: Node[];
  /** How many field errors the step has. */
  issues: number;
  /** Run view: the step's status in that run. */
  status: string | null;
  error: string | null;
};
export type TriggerData = { key: string; event: string; issues: number; status: string | null };
/** The end of a list: a "+" while editing, "End" when read-only. */
export type EndData = { slot: Slot | null; label: string };
export type LinkData = { label?: string; branch?: Branch; slot?: Slot; addLabel?: string };

export type StepNode = FlowNode<StepData, "step">;
export type TriggerNode = FlowNode<TriggerData, "trigger">;
export type EndNode = FlowNode<EndData, "end">;
export type CanvasNode = StepNode | TriggerNode | EndNode;
export type CanvasEdge = FlowEdge<LinkData, "link">;

export type LayoutOptions = {
  /** Puts a "+" on each edge and at the end of each list. */
  editable: boolean;
  errors?: Record<string, Record<string, string>>;
  /** Run view: each step's result by key. Steps missing from it are `not_started`. */
  run?: Map<string, RunStep>;
};

/** The id of the end node of the list at `path`. */
export function endId(path: ListPath) {
  return `end:${path.map((hop) => `${hop.key}.${hop.branch}`).join("/") || "main"}`;
}

/** The id React Flow uses for an edge's "+" and for the end node's "+". */
export function slotId(slot: Slot) {
  return `${endId(slot.path)}@${slot.index}`;
}

// Handles sit at the top and bottom center of each box. Given up front, React Flow can draw
// edges before it has measured anything, which is also what lets the edges render under jsdom.
function handles(width: number, height: number): NodeHandle[] {
  return [
    { type: "target", position: "top" as NodeHandle["position"], x: width / 2 - 0.5, y: 0, width: 1, height: 1 },
    { type: "source", position: "bottom" as NodeHandle["position"], x: width / 2 - 0.5, y: height - 1, width: 1, height: 1 },
  ];
}

/** How wide a list is drawn: one column, or its branches side by side when it ends in a branch. */
export function measure(list: Node[]): number {
  let width = nodeWidth;
  for (const node of list) {
    const branches = branchesOf(node);
    if (!branches.length) continue;
    const inner = branches.reduce((sum, branch) => sum + measure(node.branches?.[branch] ?? []), 0) + columnGap * (branches.length - 1);
    width = Math.max(width, inner);
  }
  return width;
}

function branchName(node: Node, branch: Branch) {
  if (branch === "event_received") return String(node.config.event_name ?? "").trim() || branchLabels.event_received;
  return branchLabels[branch];
}

/**
 * Lays the tree out top to bottom: the trigger at the top center, each list as a column under
 * the step before it, and a branching step's lists side by side under it.
 */
export function layout(tree: Tree, { editable, errors = {}, run }: LayoutOptions): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const count = (key: string) => Object.keys(errors[key] ?? {}).length;

  nodes.push({
    id: tree.trigger,
    type: "trigger",
    position: { x: -nodeWidth / 2, y: 0 },
    width: nodeWidth,
    height: nodeHeight,
    handles: handles(nodeWidth, nodeHeight),
    data: { key: tree.trigger, event: tree.event, issues: count(tree.trigger), status: run ? "completed" : null },
  });

  const link = (source: string, target: string, data: LinkData) =>
    edges.push({ id: `${source}->${target}`, source, target, type: "link", data });

  /**
   * Places `list` centered on `center`, starting at `top`. `from` is the node above its first
   * entry, with the branch label when the list is a branch.
   */
  const place = (list: Node[], path: ListPath, center: number, top: number, from: { id: string; branch?: Branch; label?: string; name: string }) => {
    let y = top;
    let previous = from;
    for (const [index, node] of list.entries()) {
      const result = run?.get(node.key);
      nodes.push({
        id: node.key,
        type: "step",
        position: { x: center - nodeWidth / 2, y },
        width: nodeWidth,
        height: nodeHeight,
        handles: handles(nodeWidth, nodeHeight),
        data: {
          node,
          path,
          index,
          list,
          issues: count(node.key),
          status: run ? (result?.status ?? "not_started") : null,
          error: result?.error ?? null,
        },
      });
      const slot = { path, index };
      link(previous.id, node.key, {
        label: previous.label,
        branch: previous.branch,
        ...(editable ? { slot, addLabel: index === 0 && path.length ? `Add step at the start of ${previous.name}` : `Add step after ${previous.name}` } : {}),
      });
      const branches = branchesOf(node);
      if (branches.length) {
        const widths = branches.map((branch) => measure(node.branches?.[branch] ?? []));
        let left = center - (widths.reduce((sum, width) => sum + width, 0) + columnGap * (branches.length - 1)) / 2;
        for (const [at, branch] of branches.entries()) {
          const width = widths[at]!;
          const label = branchName(node, branch);
          place(node.branches?.[branch] ?? [], [...path, { key: node.key, branch }], left + width / 2, y + nodeHeight + branchGap, {
            id: node.key,
            branch,
            label,
            name: `${branchLabels[branch]} branch of ${node.key}`,
          });
          left += width + columnGap;
        }
        return;
      }
      previous = { id: node.key, name: node.key };
      y += nodeHeight + rowGap;
    }

    // The list ends without a branch, so it gets an end marker: the "+" that appends to it.
    const id = endId(path);
    const empty = list.length === 0;
    const where = path.length ? `${branchLabels[path.at(-1)!.branch]} branch of ${path.at(-1)!.key}` : "";
    nodes.push({
      id,
      type: "end",
      position: { x: center - endWidth / 2, y },
      width: endWidth,
      height: endHeight,
      handles: handles(endWidth, endHeight),
      data: {
        slot: editable ? { path, index: list.length } : null,
        label: !path.length ? "Add step at the end" : empty ? `Add step to ${where}` : `Add step at the end of ${where}`,
      },
    });
    link(previous.id, id, { label: previous.label, branch: previous.branch });
  };

  place(tree.steps, [], 0, nodeHeight + rowGap, { id: tree.trigger, name: "the trigger" });
  return { nodes, edges };
}

/** Finds a step and the list it sits in, for the side panel. */
export function locate(tree: Tree, key: string): { node: Node; path: ListPath; index: number; list: Node[] } | null {
  const walk = (list: Node[], path: ListPath): ReturnType<typeof locate> => {
    for (const [index, node] of list.entries()) {
      if (node.key === key) return { node, path, index, list };
      for (const branch of branchesOf(node)) {
        const found = walk(node.branches?.[branch] ?? [], [...path, { key: node.key, branch }]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(tree.steps, []);
}

/** The step a run view opens on: the first one with an error, else the last one the run reached. */
export function runFocus(tree: Tree, run: Map<string, RunStep>): string | null {
  let last: string | null = null;
  let failed: string | null = null;
  const walk = (list: Node[]) => {
    for (const node of list) {
      const result = run.get(node.key);
      if (result) {
        if (!failed && (result.error || result.status === "failed")) failed = node.key;
        last = node.key;
      }
      if (branching(node)) for (const branch of branchesOf(node)) walk(node.branches?.[branch] ?? []);
    }
  };
  walk(tree.steps);
  return failed ?? last;
}
