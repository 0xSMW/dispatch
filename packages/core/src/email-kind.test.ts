import { describe, expect, it } from "vitest";
import { stepConfigs, templateKind } from "./index.js";

describe("send kinds", () => {
  const config = { template: "welcome" };
  it("normalizes legacy kinds without changing transactional requirements", () => {
    expect(stepConfigs.send_email.parse(config).kind).toBe("transactional");
    expect(stepConfigs.send_email.parse({ ...config, topic_id: "news" }).kind).toBe("marketing");
    expect(stepConfigs.send_email.parse({ ...config, kind: "marketing" })).toMatchObject({ kind: "marketing" });
  });
  it("refuses contradictory and unknown kinds", () => {
    expect(stepConfigs.send_email.safeParse({ ...config, kind: "transactional", topic_id: "news" }).success).toBe(false);
    expect(stepConfigs.send_email.safeParse({ ...config, kind: "other" }).success).toBe(false);
  });
  it.each(["UNSUBSCRIBE_URL", "RESEND_UNSUBSCRIBE_URL", "DISPATCH_UNSUBSCRIBE_URL"])("classifies %s content as Marketing", (key) => {
    expect(templateKind({ html: `<a href="{{{${key}}}}">Leave</a>` })).toBe("marketing");
    expect(templateKind({ text: `{{ ${key} }}` })).toBe("marketing");
  });
  it("retains library intent and otherwise treats ordinary templates as Transactional", () => {
    expect(templateKind({ source: { send_kind: "marketing" } })).toBe("marketing");
    expect(templateKind({ html: "<p>Receipt</p>" })).toBe("transactional");
  });
});
