import { describe, expect, it } from "vitest";
import { contentKind, sendKind, templateKind } from "./emailKind";
import { contentKind as coreContentKind } from "../../../../packages/core/src/email-kind";

describe("email kind", () => {
  it.each(["UNSUBSCRIBE_URL", "RESEND_UNSUBSCRIBE_URL", "DISPATCH_UNSUBSCRIBE_URL"])("recognizes %s in HTML and plain text", (key) => {
    for (const token of [
      `{{${key}}}`, `{{ ${key} }}`, `{{{${key}}}}`, `{{{ ${key} }}}`,
      `{{{${key}|https://example.com/unsubscribe}}}`, `{{{ ${key} | }}}`,
      `{{{${key}|}}}`, `{{{${key}|\nhttps://example.com/unsubscribe|extra}}}`,
    ]) {
      for (const field of ["html", "text"] as const) {
        const content = { [field]: token };
        expect(contentKind(content), `${field}: ${token}`).toBe("marketing");
        expect(contentKind(content)).toBe(coreContentKind(content));
        expect(templateKind({ ...content, kind: "transactional", source: { send_kind: "transactional" } })).toBe("marketing");
      }
    }
  });
  it.each([
    "UNSUBSCRIBE_URL", "{{UNSUBSCRIBE_URL|https://example.com}}",
    "{{{UNSUBSCRIBE_URL|broken}fallback}}}", "{{unsubscribe_url}}",
    "{{{contact.UNSUBSCRIBE_URL|fallback}}}", "{{UNSUBSCRIBE_URL_SUFFIX}}",
    "{{{OTHER_URL|UNSUBSCRIBE_URL}}}",
  ])("keeps ordinary and unsupported content Transactional: %s", (token) => {
    expect(contentKind({ html: token, text: token })).toBe("transactional");
    expect(contentKind({ html: token, text: token })).toBe(coreContentKind({ html: token, text: token }));
  });
  it("does not combine HTML and text or infer content kind from metadata", () => {
    expect(contentKind({ html: "{{UNSUBSCRIBE_URL", text: "}}" })).toBe("transactional");
    expect(contentKind({ source: { send_kind: "marketing" }, kind: "marketing", text: "Receipt" })).toBe("transactional");
    expect(contentKind({ html: null, text: null })).toBe("transactional");
  });
  it("uses API metadata when present and content for older detail responses", () => {
    expect(templateKind({ kind: "marketing", html: "<p>News</p>" })).toBe("marketing");
    expect(templateKind({ text: "{{UNSUBSCRIBE_URL}}" })).toBe("marketing");
    expect(templateKind({ html: "UNSUBSCRIBE_URL without braces" })).toBe("transactional");
  });
  it("retains Marketing library kind after body edits and does not let stale Transactional metadata hide an unsubscribe token", () => {
    expect(templateKind({ source: { kind: "library", send_kind: "marketing" }, text: "Edited body" })).toBe("marketing");
    expect(templateKind({ kind: "transactional", html: "{{{UNSUBSCRIBE_URL}}}" })).toBe("marketing");
  });
  it("only infers legacy kind when no explicit kind exists", () => {
    expect(sendKind({})).toBe("transactional");
    expect(sendKind({ topic_id: "news" })).toBe("marketing");
    expect(sendKind({ kind: "transactional", topic_id: "news" })).toBe("transactional");
    expect(sendKind({ kind: "marketing" })).toBe("marketing");
  });
});
