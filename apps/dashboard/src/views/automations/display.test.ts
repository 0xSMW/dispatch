import { describe as suite, expect, it } from "vitest";
import { describe, ruleText, triggerSummary, type Node } from "./graph";

const sources = {
  templates: [{ value: "tpl_1", label: "Welcome" }], templateNames: { welcome_alias: "Welcome" },
  topics: [{ value: "topic_1", label: "Newsletter" }], segments: [{ value: "seg_1", label: "VIP" }],
};
const step = (type: Node["type"], config: Node["config"]): Node => ({ key: "generated_123", type, config });
suite("automation presentation", () => {
  it("uses real names for template IDs and aliases, topics and memberships without changing config", () => {
    const node = step("send_email", { kind: "marketing", template: { id: "welcome_alias" }, topic_id: "topic_1" });
    const before = JSON.stringify(node);
    expect(describe(node, sources)).toBe("Marketing · Welcome · Newsletter");
    expect(describe(step("add_to_segment", { segment_id: "seg_1" }), sources)).toBe("VIP · Person in this automation");
    expect(ruleText({ type: "rule", field: "contact.segments", operator: "contains", value: "seg_1" }, sources)).toBe("Segment membership contains VIP");
    expect(JSON.stringify(node)).toBe(before);
  });
  it("distinguishes pending and unavailable sources without exposing IDs or guessing resource names", () => {
    const node = step("add_to_segment", { segment_id: "seg_missing" });
    expect(describe(node)).toContain("Segment unavailable");
    expect(describe(node, { segments: [], segmentsReady: false })).toContain("Loading segment…");
    expect(describe(node, { segments: [] })).toContain("Segment unavailable");
    expect(describe(node, { segments: [], segmentsReady: false, segmentsError: "Denied" })).toContain("Segment unavailable");
    expect(triggerSummary({ type: "topic_subscribed", topic_id: "hidden" }, { topicsError: "Denied" })).toBe("Topic unavailable");
  });
  it("describes subscription changes, fields, waits and named paths", () => {
    expect(describe(step("contact_update", { first_name: "Sam", unsubscribed: false, properties: { plan_level: "pro" } }))).toBe("First name: Sam · Subscription: Subscribed · Plan level: pro");
    expect(ruleText({ type: "rule", field: "contact.unsubscribed", operator: "eq", value: false })).toBe("Subscription is Subscribed");
    expect(describe(step("delay", { duration: "2d" }))).toBe("Wait 2 days");
    expect(describe(step("wait_for_event", { event_name: "purchase", timeout: "1 day" }))).toBe("Wait for purchase, up to 1 day");
    expect(describe(step("branch", { paths: [{ key: "path_1", label: "Paid" }, { key: "path_2", label: "Trial" }] }))).toBe("Paid / Trial / Otherwise");
  });
});
