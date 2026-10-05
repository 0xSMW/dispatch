import { expect, it } from "vitest";
import { automationGraphSchema, splitSchema } from "./index.js";

const variants = [{ key: "a", label: "A", weight: 0 }, { key: "b", label: "B", weight: 100 }];
const graph = {
  steps: [{ key: "t", type: "trigger", config: { event_name: "start" } }, { key: "s", type: "split", config: { variants } }, { key: "x", type: "exit", config: {} }],
  connections: [{ from: "t", to: "s" }, { from: "s", to: "x", type: "variant", path: "a" }, { from: "s", to: "x", type: "variant", path: "b" }],
};
it("accepts zero weights, repeated labels and exactly one edge per permanent variant", () => {
  expect(automationGraphSchema.safeParse(graph).success).toBe(true);
  expect(splitSchema.safeParse({ variants: variants.map((variant) => ({ ...variant, label: "Same" })) }).success).toBe(true);
});
it("rejects missing zero-weight edges, duplicate/unknown edges, non-split sources and cycles", () => {
  for (const connections of [
    graph.connections.slice(0, 2),
    [...graph.connections, graph.connections[1]],
    graph.connections.map((edge, index) => index === 1 ? { ...edge, path: "unknown" } : edge),
    graph.connections.map((edge, index) => index === 1 ? { ...edge, type: "default", path: undefined } : edge),
    [...graph.connections, { from: "x", to: "s", type: "variant", path: "a" }],
  ]) expect(automationGraphSchema.safeParse({ ...graph, connections }).success).toBe(false);
});
it("refuses invalid count, duplicates, fractions and totals", () => {
  for (const invalid of [variants.slice(0, 1), [...variants, ...variants], variants.map((variant) => ({ ...variant, weight: 50.5 })), variants.map((variant) => ({ ...variant, weight: 0 }))]) {
    expect(splitSchema.safeParse({ variants: invalid }).success).toBe(false);
  }
});
