import { describe, expect, it } from "vitest";
import { renderTemplate, stepConfigs } from "./index.js";
import { contentKind, templateKind } from "./email-kind.js";

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
    for (const token of [
      `{{${key}}}`, `{{ ${key} }}`, `{{{${key}}}}`, `{{{ ${key} }}}`,
      `{{{${key}|https://example.com/unsubscribe}}}`, `{{{ ${key} | }}}`,
      `{{{${key}|}}}`, `{{{${key}|\nhttps://example.com/unsubscribe|extra}}}`,
    ]) {
      for (const field of ["html", "text"] as const) {
        const content = { [field]: token };
        expect(contentKind(content), `${field}: ${token}`).toBe("marketing");
        expect(templateKind(content), `${field}: ${token}`).toBe("marketing");
        // Classification uses only syntax that the current renderer actually consumes.
        expect(renderTemplate(content, { [key]: "resolved" })[field]).toBe("resolved");
      }
    }
  });
  it.each(["UNSUBSCRIBE_URL", "RESEND_UNSUBSCRIBE_URL", "DISPATCH_UNSUBSCRIBE_URL"])("retains %s inline fallback behavior and escaping", (key) => {
    for (const fallback of ["", "https://example.com/unsubscribe?a=1&b=2"]) {
      const token = `{{{${key}|${fallback}}}}`;
      expect(templateKind({ html: token, text: token })).toBe("marketing");
      expect(renderTemplate({ html: token, text: token }, {})).toMatchObject({
        html: fallback.replace(/&/g, "&amp;"), text: fallback,
      });
    }
  });
  it.each([
    "UNSUBSCRIBE_URL", "{{UNSUBSCRIBE_URL|https://example.com}}",
    "{{{UNSUBSCRIBE_URL|broken}fallback}}}", "{{unsubscribe_url}}",
    "{{{contact.UNSUBSCRIBE_URL|fallback}}}", "{{UNSUBSCRIBE_URL_SUFFIX}}",
    "{{{OTHER_URL|UNSUBSCRIBE_URL}}}",
  ])("does not invent reserved placeholder grammar for %s", (token) => {
    expect(contentKind({ html: token, text: token })).toBe("transactional");
    expect(templateKind({ html: token, text: token })).toBe("transactional");
  });
  it("does not combine separate HTML and text into a placeholder", () => {
    expect(contentKind({ html: "{{UNSUBSCRIBE_URL", text: "}}" })).toBe("transactional");
  });
  it("retains library intent and otherwise treats ordinary templates as Transactional", () => {
    expect(templateKind({ source: { send_kind: "marketing" } })).toBe("marketing");
    expect(templateKind({ source: { send_kind: "marketing" }, html: "Edited body" })).toBe("marketing");
    expect(templateKind({ source: { send_kind: "transactional" }, text: "{{{UNSUBSCRIBE_URL|}}}" })).toBe("marketing");
    const metadataOnly = { source: { send_kind: "marketing" }, text: "Receipt" };
    expect(contentKind(metadataOnly)).toBe("transactional");
    expect(templateKind({ html: "<p>Receipt</p>" })).toBe("transactional");
    expect(templateKind({ source: null, html: null, text: null })).toBe("transactional");
  });
});
