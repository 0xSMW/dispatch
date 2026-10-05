import { describe, expect, it } from "vitest";
import { automationRuleSchema, ruleSchema, segmentPreviewSchema, segmentSchema, segmentUpdateSchema } from "./index.js";

describe("segment shared contracts", () => {
  const engagement = { type: "rule", field: "email.opened", operator: "eq", value: true };
  it("retains bound engagement scopes and positive windows", () => {
    expect(ruleSchema.parse({ ...engagement, scope: { automation_id: "auto_test" }, window: "30 days" }))
      .toEqual({ ...engagement, scope: { automation_id: "auto_test" }, window: "30 days" });
    for (const extra of [{ value: "true" }, { field: "email.received" }, { operator: "contains" }, { window: "0 days" }, { scope: {} }, { scope: { automation_id: "a", broadcast_id: "b" } }])
      expect(ruleSchema.safeParse({ ...engagement, ...extra }).success).toBe(false);
    expect(ruleSchema.safeParse({ ...engagement, field: "contact.unsubscribed", window: "1 day" }).success).toBe(false);
  });
  it("distinguishes omitted rule and explicit conversion without client type", () => {
    expect(segmentUpdateSchema.parse({ name: "Renamed" })).not.toHaveProperty("rule");
    expect(segmentUpdateSchema.parse({ rule: null })).toEqual({ rule: null });
    expect(segmentSchema.safeParse({ name: "Filter", type: "dynamic" }).success).toBe(false);
  });
  it("bounds segments without lowering automation depth and rejects unresolved engagement", () => {
    expect(automationRuleSchema.safeParse(engagement).success).toBe(false);
    const leaf = { type: "rule", field: "event.plan-id", operator: "eq", value: "pro" };
    let rule: unknown = leaf;
    for (let depth = 0; depth < 5; depth++) rule = { type: "and", rules: [rule] };
    expect(ruleSchema.safeParse(rule).success).toBe(true);
    expect(segmentPreviewSchema.safeParse({ rule }).success).toBe(false);
    expect(segmentPreviewSchema.safeParse({ rule: { type: "and", rules: Array.from({ length: 21 }, () => leaf) } }).success).toBe(false);
  });
});
