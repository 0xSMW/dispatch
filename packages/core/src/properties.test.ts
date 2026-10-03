import { describe, expect, it } from "vitest";
import { evaluate, isIsoDate, operatorsForType, propertySchema, propertyUpdateSchema, ruleSchema, stepConfigs, type Operator } from "./index.js";

describe("typed properties and shared rules", () => {
  it.each([
    ["string", "free"], ["number", 4], ["boolean", false], ["date", "2026-02-28"],
    ["date", "2024-02-29T12:34:56.123+02:00"],
  ])("validates %s fallbacks without changing their values", (type, fallback_value) => {
    expect(propertySchema.parse({ key: "value", type, fallback_value }).fallback_value).toBe(fallback_value);
    expect(propertySchema.parse({ key: "value", type, fallback_value: null }).fallback_value).toBeNull();
  });
  it.each([
    ["string", true], ["number", "4"], ["number", Infinity], ["boolean", "true"],
    ["date", "2026-02-29"], ["date", "2026-04-31"], ["date", "yesterday"],
    ["date", "2026-01-01T00:00:00"], ["date", 1770000000000],
  ])("rejects a mismatched or invalid %s fallback", (type, fallback_value) => {
    expect(propertySchema.safeParse({ key: "value", type, fallback_value }).success).toBe(false);
  });
  it("keeps update fallbacks typed for validation against the stored definition", () => {
    expect(propertyUpdateSchema.parse({ fallback_value: false })).toEqual({ fallback_value: false });
  });
  it.each(["2026-10-04", "2026-10-04T01:02:03Z", "2026-10-04T01:02:03.456-04:30"])("recognizes ISO %s", (value) => {
    expect(isIsoDate(value)).toBe(true);
  });
  it.each(["2026-00-01", "2026-13-01", "2026-01-00", "2026-01-32", "2026-01-01T24:00:00Z", "2026-01-01T12:60:00Z", "2026-01-01T12:00:60Z", "2026-01-01T12:00:00+24:00", "Oct 4, 2026", "", null, 10])("rejects non-ISO/invalid %s", (value) => {
    expect(isIsoDate(value)).toBe(false);
  });
  it("negates unchanged string and set contains semantics", () => {
    for (const actual of [["topic_1", "topic_2"], "topic_1 topic_2", null, 10]) {
      const context = { contact: { topics: actual } };
      const rule = { type: "rule" as const, field: "contact.topics", value: "topic_1" };
      expect(evaluate({ ...rule, operator: "not_contains" }, context)).toBe(!evaluate({ ...rule, operator: "contains" }, context));
    }
    expect(evaluate({ type: "rule", field: "contact.topics", operator: "contains", value: "1" }, { contact: { topics: [1] } })).toBe(false);
  });
  it("uses one inclusive clock across nested date windows and their complement", () => {
    const now = Date.parse("2026-10-04T00:00:00Z");
    for (const [value, inside] of [["2026-10-04T00:00:00Z", true], ["2026-09-04", true], ["2026-09-03T23:59:59.999Z", false], ["2026-10-04T00:00:00.001Z", false]] as const) {
      for (const operator of ["within", "not_within"] as Operator[]) {
        expect(evaluate({ type: "and", rules: [{ type: "rule", field: "event.received_at", operator, value: "30 days" }] }, { event: { received_at: value } }, now)).toBe(operator === "within" ? inside : !inside);
      }
    }
  });
  it("matches neither window for missing, non-ISO or malformed legacy dates", () => {
    for (const value of [undefined, null, "", false, 2026, "yesterday", "2026-02-30"]) {
      for (const operator of ["within", "not_within"] as const) {
        expect(evaluate({ type: "rule", field: "contact.date", operator, value: "7 days" }, { contact: { date: value } })).toBe(false);
      }
    }
  });
  it.each(["0 days", "-1 days", "30 months", "forever", true, undefined])("rejects invalid window %s", (value) => {
    const rule = { type: "rule", field: "event.received_at", operator: "within", value };
    expect(ruleSchema.safeParse(rule).success).toBe(false);
    expect(evaluate(rule as Parameters<typeof evaluate>[0], { event: { received_at: "2026-10-04" } })).toBe(false);
  });
  it("restricts operators by known type without losing strict equality", () => {
    expect(operatorsForType("boolean")).toEqual(["eq", "neq", "exists", "is_empty"]);
    expect(operatorsForType("set")).toEqual(["contains", "not_contains", "exists", "is_empty"]);
    expect(operatorsForType("date")).toContain("within");
    expect(operatorsForType("number")).not.toContain("within");
    expect(evaluate({ type: "rule", field: "x", operator: "eq", value: true }, { x: "true" })).toBe(false);
  });
  it("preserves additive variable mappings and refuses paths outside the context", () => {
    const config = { template: "tmpl_1", variable_mapping: { NAME: "contact.first_name", PLAN: "event.plan" } };
    expect(stepConfigs.send_email.parse(config).variable_mapping).toEqual(config.variable_mapping);
    expect(stepConfigs.send_email.safeParse({ ...config, variable_mapping: { NAME: "brand.secret" } }).success).toBe(false);
  });
});
