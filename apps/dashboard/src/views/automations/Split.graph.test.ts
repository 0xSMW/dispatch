import { expect, it } from "vitest";
import { branchSteps, insertStep, projectRun, setSplitVariants, toGraph, toTree, updateNode } from "./graph";
import { layout } from "./layout";

it("round trips List/Canvas variants including connected zero-weight lanes", () => {
  const tree = insertStep({ trigger: "t", event: "start", steps: [] }, [], 0, "split", "s");
  const edited = updateNode(tree, "s", (node) => setSplitVariants(node, [{ key: "a", label: "A", weight: 0 }, { key: "b", label: "B", weight: 100 }]));
  const graph = toGraph(edited);
  expect(graph.connections.filter((edge) => edge.from === "s").map((edge) => [edge.type, edge.path])).toEqual([["variant", "a"], ["variant", "b"]]);
  expect(toTree(graph.steps, graph.connections).problem).toBeNull();
  expect(toGraph(toTree(graph.steps, graph.connections).tree)).toEqual(graph);
  expect(layout(edited, { editable: true }).edges.filter((edge) => edge.source === "s").map((edge) => edge.data?.label)).toEqual(["A (0%)", "B (100%)"]);
});
it("weight and label edits preserve child keys and adding a path creates a real Exit", () => {
  const tree = insertStep({ trigger: "t", event: "start", steps: [] }, [], 0, "split", "s");
  const node = tree.steps[0]!;
  const edited = setSplitVariants(node, [{ key: "a", label: "Winner", weight: 100 }, { key: "b", label: "B", weight: 0 }, { key: "c", label: "C", weight: 0 }]);
  expect(branchSteps(edited, "a")).toEqual(branchSteps(node, "a"));
  expect(branchSteps(edited, "b")).toEqual(branchSteps(node, "b"));
  expect(branchSteps(edited, "c")[0]?.type).toBe("exit");
  expect(new Set(edited.paths?.map((path) => path.steps[0]?.key)).size).toBe(3);
});
it("projects a shared Exit only onto the successful recorded variant, not winner weights", () => {
  const graph = {
    steps: [{ key: "t", type: "trigger", config: { event_name: "start" } }, { key: "s", type: "split", config: { variants: [{ key: "a", label: "A", weight: 0 }, { key: "b", label: "B", weight: 100 }] } }, { key: "x", type: "exit", config: {} }],
    connections: [{ from: "t", to: "s" }, { from: "s", to: "x", type: "variant", path: "a" }, { from: "s", to: "x", type: "variant", path: "b" }],
  };
  const tree = toTree(graph.steps, graph.connections).tree;
  const result = { status: "completed", output: {} };
  const projected = projectRun(tree, new Map([["s", { ...result, output: { variant: "a" } }], ["x", result]]));
  expect(projected.get(branchSteps(tree.steps[0]!, "a")[0]!.key)).toEqual(result);
  expect(projected.has(branchSteps(tree.steps[0]!, "b")[0]!.key)).toBe(false);
});
