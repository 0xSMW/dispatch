import { describe, expect, it } from "vitest";
import { goalSchema, goalMetricsSchema, type Rule } from "./index.js";

describe("goal contracts", () => {
  it("defaults the window and accepts event or shared contact rule targets", () => {
    expect(goalSchema.parse({ name: " Upgrade ", target: { event: " upgraded " } })).toEqual({
      name: "Upgrade", target: { event: "upgraded" }, window_days: 30,
    });
    const rule: Rule = { type: "and", rules: [{ type: "rule", field: "contact.paid", operator: "eq", value: true }] };
    expect(goalSchema.parse({ name: "Paid", target: { rule }, eligibility: null }).target).toEqual({ rule });
  });
  it("refuses mixed targets, unsupported contexts and invalid windows", () => {
    for (const target of [{ event: "@internal" }, { event: "x", rule: {} }, {
      rule: { type: "rule", field: "email.sent", operator: "eq", value: true },
    }, { rule: { type: "rule", field: "event.active", operator: "eq", value: true } }])
      expect(goalSchema.safeParse({ name: "X", target }).success).toBe(false);
    for (const days of [0, 366, 1.5]) expect(goalSchema.safeParse({ name: "X", target: { event: "x" }, window_days: days }).success).toBe(false);
  });
  it("validates mutually exclusive scopes, step context and half-open bounds", () => {
    for (const query of [{ automation_id: "a", broadcast_id: "b" }, { step_key: "send" },
      { start_date: "2026-09-01", end_date: "2026-09-02" },
      { start_date: "2026-09-01T00:00:00Z", end_date: "2026-09-01T00:00:00Z" }])
      expect(goalMetricsSchema.safeParse(query).success).toBe(false);
    expect(goalMetricsSchema.parse({ automation_id: "a", step_key: "old", start_date: "2026-09-01T00:00:00Z" })).toMatchObject({ step_key: "old" });
  });
});
