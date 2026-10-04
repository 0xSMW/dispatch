import { describe, expect, it } from "vitest";
import { contentKind, sendKind, templateKind } from "./emailKind";

describe("email kind", () => {
  it.each(["UNSUBSCRIBE_URL", "RESEND_UNSUBSCRIBE_URL", "DISPATCH_UNSUBSCRIBE_URL"])("recognizes %s in HTML and plain text", (key) => {
    expect(contentKind({ html: `<a href="{{ ${key} }}">Leave</a>` })).toBe("marketing");
    expect(contentKind({ text: `Leave: {{{${key}}}}` })).toBe("marketing");
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
