import { describe, expect, it } from "vitest";
import { automationSchema, stepConfigs } from "./index.js";

const rule = { type: "rule", field: "event.plan", operator: "eq", value: "free" };
const paths = [{ key: "free", label: "Free", rule }, { key: "paid", label: "Paid", rule }];
const graph = () => ({
  name: "Flow",
  steps: [
    { key: "start", type: "trigger", config: { event_name: "start" } },
    { key: "check", type: "branch", config: { paths } },
    { key: "end", type: "exit", config: {} },
  ],
  connections: [
    { from: "start", to: "check", type: "default" },
    ...["free", "paid", "otherwise"].map((path) => ({ from: "check", to: "end", type: "branch", path })),
  ],
});

describe("flow control validation", () => {
  it("accepts two to ten ordered unique paths with explicit Otherwise exits", () => {
    expect(automationSchema.parse(graph()).connections).toHaveLength(4);
    expect(stepConfigs.branch.safeParse({ paths: Array.from({ length: 10 }, (_, n) => ({ key: `p${n}`, label: `Path ${n}`, rule })) }).success).toBe(true);
  });
  it.each([1, 11])("rejects %i paths", (count) => {
    expect(stepConfigs.branch.safeParse({ paths: Array.from({ length: count }, (_, n) => ({ key: `p${n}`, label: "Path", rule })) }).success).toBe(false);
  });
  it("rejects duplicate and reserved path keys, empty labels and invalid rules", () => {
    for (const change of [{ key: "free" }, { key: "otherwise" }, { label: " " }, { rule: {} }]) {
      expect(stepConfigs.branch.safeParse({ paths: [paths[0], { ...paths[1], ...change }] }).success).toBe(false);
    }
  });
  it("requires exactly one connection for each declared path and Otherwise", () => {
    for (const index of [1, 2, 3]) {
      const input = graph();
      input.connections.splice(index, 1);
      expect(automationSchema.safeParse(input).success).toBe(false);
    }
    const duplicate = graph();
    duplicate.connections.push(duplicate.connections[1]);
    expect(automationSchema.safeParse(duplicate).success).toBe(false);
  });
  it("rejects unkeyed, undeclared, default branch edges and paths on other steps", () => {
    for (const change of [{ path: undefined }, { path: "unknown" }, { type: "default" }]) {
      const input = graph();
      Object.assign(input.connections[1], change);
      expect(automationSchema.safeParse(input).success).toBe(false);
    }
    const input = graph();
    Object.assign(input.connections[0], { path: "free" });
    expect(automationSchema.safeParse(input).success).toBe(false);
  });
  it("refuses outgoing exits, dangling targets and invalid filter outcomes", () => {
    const input = graph();
    input.connections.push({ from: "end", to: "check", type: "default" });
    expect(automationSchema.safeParse(input).success).toBe(false);
    const filter = { ...graph(), steps: [
      graph().steps[0], { key: "check", type: "filter", config: { rule, scope: "following" } }, graph().steps[2],
    ], connections: [{ from: "start", to: "check" }, { from: "check", to: "end", type: "condition_not_met" }] };
    expect(automationSchema.safeParse(filter).success).toBe(false);
  });
  it("validates empty Exit and both filter scopes with the shared typed rules", () => {
    expect(stepConfigs.exit.parse({})).toEqual({});
    expect(stepConfigs.exit.safeParse({ rule }).success).toBe(false);
    for (const scope of ["next", "following"]) expect(stepConfigs.filter.parse({ scope, rule })).toEqual({ scope, rule });
    expect(stepConfigs.filter.safeParse({ scope: "forever", rule }).success).toBe(false);
    expect(stepConfigs.filter.safeParse({ scope: "next", rule: {} }).success).toBe(false);
  });
});
