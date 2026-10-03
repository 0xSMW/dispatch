import { describe, expect, it } from "vitest";
import { automationSchema, eventSchema, eventSendSchema, normalizeAutomation, stepConfigs, triggerKey, triggerSchema } from "./index.js";

describe("trigger contracts", () => {
  it.each([
    [{ type: "event", event_name: "signup" }, "signup"],
    [{ type: "contact_created" }, "@contact.created"],
    [{ type: "contact_updated", field: "active", from: false, to: true }, "@contact.updated"],
    [{ type: "topic_subscribed", topic_id: "news" }, "@topic.subscribed:news"],
    [{ type: "segment_added", segment_id: "paid" }, "@segment.added:paid"]
  ])("normalizes and keys %j", (config, key) => {
    const parsed = triggerSchema.parse(config);
    expect(triggerKey(parsed)).toBe(key);
    const flow = automationSchema.parse({ name: "Test", steps: [{ key: "start", type: "trigger", config }] });
    expect(flow).toMatchObject({ trigger: key, trigger_config: config, trigger_type: parsed.type,
      reentry: parsed.type === "event" ? "every_time" : "once" });
  });
  it("normalizes legacy event triggers without changing their reentry default", () => {
    expect(triggerSchema.parse({ event_name: "signup" })).toEqual({ type: "event", event_name: "signup" });
    expect(automationSchema.parse({ name: "Old", trigger: "signup", steps: [{ type: "delay", seconds: 1 }] })).toMatchObject({
      trigger: "signup", trigger_type: "event", reentry: "every_time"
    });
  });
  it("rejects reserved names at all public input boundaries but reads legacy stored events", () => {
    expect(eventSchema.safeParse({ name: "@contact.created" }).success).toBe(false);
    expect(eventSendSchema.safeParse({ event: "@contact.created" }).success).toBe(false);
    expect(stepConfigs.trigger.safeParse({ event_name: "@contact.created" }).success).toBe(false);
    expect(stepConfigs.wait_for_event.safeParse({ event_name: "@contact.created" }).success).toBe(false);
    const input = { trigger: "@contact.created", steps: [{ type: "delay", seconds: 1 }] };
    expect(() => normalizeAutomation(input)).toThrow();
    expect(normalizeAutomation(input, true).steps[0]!.config).toEqual({ type: "event", event_name: "@contact.created" });
    expect(normalizeAutomation({ trigger: "@signup", steps: [{ type: "wait", event: "@activated", timeout_seconds: 60 }] }, true).steps[1]!.config)
      .toEqual({ event_name: "@activated", timeout: "60 seconds" });
  });
  it("keeps typed false/zero/null and requires a field for transition values", () => {
    for (const value of [false, 0, null, "2026-10-04T00:00:00Z"]) {
      expect(triggerSchema.parse({ type: "contact_updated", field: "value", from: value }).from).toBe(value);
    }
    expect(triggerSchema.safeParse({ type: "contact_updated", to: "pro" }).success).toBe(false);
    expect(triggerSchema.safeParse({ type: "contact_updated", field: "contact.plan" }).success).toBe(false);
  });
});
