import { beforeEach, describe, expect, it, vi } from "vitest";
import { contextFields } from "../../lib/rules";
import type { AutomationRunDetail } from "../../types";
import {
  allKeys, branchSteps, branchesOf, canMove, configuredPaths, descendants, describe as summary, insertStep, keys, listAt,
  placeIssues, removeStep, setBranchPaths, stepIssues, stepLabels, toGraph, toTree, treeIssues, updateNode,
  type Node, type Rule, type Tree,
} from "./graph";
import { branchGap, columnGap, layout, locate, measure, nodeHeight, nodeWidth, rowGap, runFocus } from "./layout";
import { runReason } from "./reasons";

const rule = (value: unknown = "free"): Rule => ({ type: "rule", field: "contact.plan", operator: "eq", value });
const empty = (): Tree => ({ trigger: "trigger", event: "signup", steps: [] });
function branched(count = 2): Tree {
  const tree = insertStep(empty(), [], 0, "branch", "split");
  return updateNode(tree, "split", (node) => setBranchPaths(node, Array.from({ length: count }, (_, index) => ({
    key: `path_${index + 1}`, label: `Plan ${index + 1}`, rule: rule(index + 1),
  }))));
}

beforeEach(() => {
  let next = 0;
  vi.spyOn(keys, "suffix").mockImplementation(() => String(++next));
});

describe("flow control graph", () => {
  it("uses the shared Delay, Condition, Branch, Filter and Exit names", () => {
    expect(["delay", "condition", "branch", "filter", "exit"].map((type) => stepLabels[type as keyof typeof stepLabels]))
      .toEqual(["Delay", "Condition", "Branch", "Filter", "Exit"]);
    expect(summary({ key: "delay", type: "delay", config: { duration: "2 days" } })).toBe("Wait 2 days");
    expect(summary({ key: "filter", type: "filter", config: { rule: rule(), scope: "following" } }))
      .toBe('Plan is "free" · all following steps');
    expect(summary(branched(3).steps[0]!)).toBe("Plan 1 / Plan 2 / Plan 3 / Otherwise");
    expect(summary({ key: "exit", type: "exit", config: {} })).toBe("The run ends here");
  });

  it("round trips ordered paths and Otherwise with exactly one path connection each", () => {
    const tree = branched();
    const graph = toGraph(tree);
    expect(graph.steps[1]?.config).toEqual({ paths: [
      { key: "path_1", label: "Plan 1", rule: rule(1) }, { key: "path_2", label: "Plan 2", rule: rule(2) },
    ] });
    expect(graph.connections.filter((edge) => edge.from === "split").map((edge) => [edge.type, edge.path]))
      .toEqual([["branch", "path_1"], ["branch", "path_2"], ["branch", "otherwise"]]);
    const read = toTree(graph.steps, graph.connections);
    expect(read.problem).toBeNull();
    expect(read.tree.steps[0]?.paths?.map((path) => [path.key, path.label, path.steps[0]?.type]))
      .toEqual([["path_1", "Plan 1", "exit"], ["path_2", "Plan 2", "exit"], ["otherwise", "Otherwise", "exit"]]);
    expect(toGraph(read.tree)).toEqual(graph);
    expect(graph.connections.some((edge) => graph.steps.find((step) => step.key === edge.from)?.type === "exit")).toBe(false);
  });

  it("writes empty legacy condition, wait, branch and trigger lanes as real exits with stable valid keys", () => {
    const long = "x".repeat(60);
    const nodes: Node[] = [
      { key: "condition", type: "condition", config: rule() },
      { key: "wait", type: "wait_for_event", config: { event_name: "paid", timeout: "1 day" }, branches: {} },
      { key: long, type: "branch", config: { paths: [
        { key: "condition_met", label: "First", rule: rule() }, { key: "second", label: "Second", rule: rule() },
      ] }, paths: [] },
    ];
    for (const steps of [[], ...nodes.map((node) => [node])]) {
      const tree = { ...empty(), steps };
      const graph = toGraph(tree);
      const exits = graph.steps.filter((step) => step.type === "exit");
      expect(exits.length).toBeGreaterThan(0);
      expect(exits.every((step) => /^[A-Za-z0-9_-]{1,60}$/.test(step.key) && Object.keys(step.config).length === 0)).toBe(true);
      expect(toGraph(tree)).toEqual(graph);
      const read = toTree(graph.steps, graph.connections);
      expect(read.problem).toBeNull();
      expect(toGraph(read.tree)).toEqual(graph);
    }
  });

  it("takes the remaining list into the first lane and creates explicit exits in other lanes", () => {
    const base = insertStep(empty(), [], 0, "delay", "pause");
    const tree = insertStep(base, [], 0, "branch", "split");
    const node = tree.steps[0]!;
    expect(branchSteps(node, "path_1").map((child) => child.key)).toEqual(["pause"]);
    expect(branchSteps(node, "path_2")[0]?.type).toBe("exit");
    expect(branchSteps(node, "otherwise")[0]?.type).toBe("exit");
    expect(tree.steps).toHaveLength(1);
  });

  it("inserts, updates, locates and removes through paths nested under paths", () => {
    let tree = branched();
    const path = [{ key: "split", branch: "path_2" }];
    tree = insertStep(tree, path, 0, "branch", "inner");
    const nested = [...path, { key: "inner", branch: "otherwise" }];
    tree = insertStep(tree, nested, 0, "filter", "guard");
    tree = updateNode(tree, "guard", (node) => ({ ...node, config: { rule: rule(), scope: "following" } }));
    expect(listAt(tree, nested)[0]?.config).toEqual({ rule: rule(), scope: "following" });
    expect(locate(tree, "guard")).toMatchObject({ path: nested, index: 0 });
    expect(allKeys(tree).has("guard")).toBe(true);
    expect(descendants(tree.steps[0]!)).toBe(7);
    expect(treeIssues(tree).guard).toBeUndefined();
    expect(runFocus(tree, new Map([["guard", { type: "filter", status: "completed" }]]))).toBe("guard");
    tree = removeStep(tree, nested, 0);
    expect(allKeys(tree).has("guard")).toBe(false);
    expect(listAt(tree, nested)[0]?.type).toBe("exit");
    expect(toTree(toGraph(tree).steps, toGraph(tree).connections).problem).toBeNull();
  });

  it("replaces a removed lane's last step with a fresh permanent exit key", () => {
    const tree = branched();
    const path = [{ key: "split", branch: "otherwise" }];
    const key = listAt(tree, path)[0]!.key;
    const removed = removeStep(tree, path, 0);
    expect(listAt(removed, path)[0]?.type).toBe("exit");
    expect(listAt(removed, path)[0]?.key).not.toBe(key);
    expect(removeStep(removed, path, 0).steps).not.toEqual(removed.steps);
  });

  it("keeps lane and descendant keys when renamed and reordered, removes only the chosen path", () => {
    const tree = branched(3);
    const node = tree.steps[0]!;
    const paths = configuredPaths(node);
    const changed = setBranchPaths(node, [{ ...paths[2]!, label: "Enterprise" }, paths[0]!]);
    expect(branchesOf(changed)).toEqual(["path_3", "path_1", "otherwise"]);
    expect(branchSteps(changed, "path_3")).toEqual(branchSteps(node, "path_3"));
    expect(branchSteps(changed, "otherwise")).toEqual(branchSteps(node, "otherwise"));
    expect(changed.paths?.[0]?.label).toBe("Enterprise");
    expect(changed.paths?.some((path) => path.key === "path_2")).toBe(false);
  });

  it("prevents moving or inserting after Exit, and never discards work to insert Exit", () => {
    const tree = insertStep(insertStep(empty(), [], 0, "delay", "pause"), [], 1, "exit", "leave");
    expect(canMove(tree.steps, 0, 1)).toBe(false);
    expect(canMove(tree.steps, 1, -1)).toBe(false);
    expect(insertStep(tree, [], 0, "exit", "bad").steps).toEqual(tree.steps);
    expect(insertStep(tree, [], 2, "delay", "bad").steps).toEqual(tree.steps);
    expect(toGraph(tree).connections).toEqual([
      { from: "trigger", to: "pause", type: "default" }, { from: "pause", to: "leave", type: "default" },
    ]);
  });

  it("validates 2..10 paths, reserved and duplicate keys, labels and typed rules", () => {
    const node = branched().steps[0]!;
    expect(stepIssues(node)).toEqual({});
    expect(stepIssues({ ...node, config: { paths: configuredPaths(node).slice(0, 1) } }).paths).toMatch(/2 to 10/);
    expect(stepIssues({ ...node, config: { paths: Array(11).fill(configuredPaths(node)[0]) } }).paths).toBeTruthy();
    const invalid = { ...node, config: { paths: [
      { key: "otherwise", label: "", rule: rule() }, { key: "otherwise", label: "Again", rule: rule() },
    ] } };
    expect(stepIssues(invalid)).toMatchObject({ paths: expect.stringContaining("reserved"), "path.otherwise.label": "Enter a path label." });
    const typed = setBranchPaths(node, [
      { key: "paid", label: "Paid", rule: { type: "rule", field: "contact.paid", operator: "eq", value: "false" } },
      configuredPaths(node)[1]!,
    ]);
    const fields = contextFields({ properties: [{ key: "paid", type: "boolean" }] });
    expect(stepIssues(typed, fields)["path.paid.rule"]).toBe("Choose true or false.");
    expect(stepIssues({ key: "filter", type: "filter", config: { rule: rule(), scope: "forever" } }).scope).toBeTruthy();
  });

  it("locks incomplete, duplicate, unknown-path, joined and outbound-Exit API graphs", () => {
    const graph = toGraph(branched());
    for (const connections of [
      graph.connections.slice(0, -1),
      [...graph.connections, graph.connections[1]!],
      [...graph.connections, { from: "split", to: graph.steps[2]!.key, type: "branch", path: "unknown" }],
      graph.connections.map((edge) => edge.path === "otherwise" ? { ...edge, to: graph.steps[2]!.key } : edge),
      [...graph.connections, { from: graph.steps[2]!.key, to: "split", type: "default" }],
    ]) expect(toTree(graph.steps, connections).problem).toBeTruthy();
  });

  it("puts API path rule errors beside the keyed rule, and scope errors beside Filter's Check", () => {
    const graph = toGraph(branched());
    graph.steps.push({ key: "guard", type: "filter", config: {} });
    expect(placeIssues(graph.steps, [
      { path: "steps.1.config.paths.0.rule.value", message: "Use a boolean" },
      { path: "steps.1.config.paths.1.label", message: "Enter a label" },
      { path: "steps.5.config.scope", message: "Choose a scope" },
    ]).cards).toEqual({
      split: { "path.path_1.rule": "Use a boolean", "path.path_2.label": "Enter a label" },
      guard: { scope: "Choose a scope" },
    });
  });
});

describe("ordered path layout", () => {
  it("does not give an ordered path named event_received the legacy wait label", () => {
    const tree = branched();
    const node = tree.steps[0]!;
    const changed = updateNode(tree, node.key, (current) => setBranchPaths(current, [
      { ...configuredPaths(current)[0]!, key: "event_received", label: "A matching plan" }, configuredPaths(current)[1]!,
    ]));
    const graph = toGraph(changed);
    expect(toTree(graph.steps, graph.connections).problem).toBeNull();
    expect(layout(changed, { editable: true }).edges.find((edge) => edge.data?.branch === "event_received")?.data?.label)
      .toBe("A matching plan");
  });
  it.each([2, 5])("lays out %i ordered paths plus Otherwise as non-overlapping columns", (count) => {
    const tree = branched(count);
    const lanes = count + 1;
    const width = lanes * nodeWidth + (lanes - 1) * columnGap;
    expect(measure(tree.steps)).toBe(width);
    const { nodes, edges } = layout(tree, { editable: true });
    const split = nodes.find((node) => node.id === "split")!;
    const children = tree.steps[0]!.paths!;
    expect(children.at(-1)?.key).toBe("otherwise");
    children.forEach((path, index) => {
      const child = nodes.find((node) => node.id === path.steps[0]?.key)!;
      expect(child.position).toEqual({
        x: -width / 2 + index * (nodeWidth + columnGap), y: nodeHeight + rowGap + nodeHeight + branchGap,
      });
      expect(child.handles?.map((handle) => handle.type)).toEqual(["target"]);
      expect(edges.find((edge) => edge.target === child.id)?.data).toMatchObject({
        branch: path.key, label: path.label, slot: { path: [{ key: "split", branch: path.key }], index: 0 },
      });
    });
    expect(nodes.some((node) => node.type === "end")).toBe(false);
    expect(edges).toHaveLength(lanes + 1);
    expect(split.position.x).toBe(-nodeWidth / 2);
    for (const a of nodes) for (const b of nodes) {
      if (a.id === b.id) continue;
      expect(a.position.x + a.width! <= b.position.x || b.position.x + b.width! <= a.position.x ||
        a.position.y + a.height! <= b.position.y || b.position.y + b.height! <= a.position.y).toBe(true);
    }
    const readonly = layout(tree, { editable: false });
    expect(readonly.edges.every((edge) => !edge.data?.slot)).toBe(true);
  });
});

describe("run reasons", () => {
  const run: AutomationRunDetail = { id: "run", status: "completed", created_at: "" };
  it.each([
    ["completed", "Reached the end of this run."], ["exit", "Left at the Exit step."],
    ["stopped", "Cancelled when the automation was stopped."], ["stranded", "Cancelled because its waiting step was removed or changed."],
  ] as const)("explains %s in words", (reason, text) => {
    expect(runReason({ ...run, exit_reason: reason })).toBe(text);
  });
  it("keeps the stranded cancellation reason and does not invent a reason for old runs", () => {
    expect(runReason({ ...run, cancellation_reason: "stranded" })).toMatch(/waiting step/);
    expect(runReason(run)).toBeNull();
  });
  it("uses the saved following guard over a changed or removed filter, including raw step data", () => {
    const tree = { ...empty(), steps: [{ key: "guard", type: "filter" as const, config: { rule: rule("enterprise"), scope: "next" } }] };
    const failed = { ...run, exit_reason: "filter" as const, guards: [{ filter: "guard", rule: rule() }],
      steps: [{ key: "send", type: "send_email", data: { exited: "filter", filter: "guard" } }] };
    expect(runReason(failed, tree)).toBe('Left at the Filter step: Plan is not "free" (guard).');
    expect(runReason(failed, empty())).toBe(runReason(failed, tree));
    expect(runReason({ ...failed, guards: [], steps: [{ key: "guard", type: "filter", output: { exited: "filter" } }] }, tree))
      .toContain('Plan is not "enterprise"');
  });
});
