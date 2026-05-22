import { describe, expect, it } from "vitest";
import { ApiError, renderTemplate, stableHash, verify, sign } from "./index.js";

describe("core", () => {
  it("hashes JSON independent of object key order", () => {
    expect(stableHash({ b: 1, a: 2 })).toBe(stableHash({ a: 2, b: 1 }));
  });

  it("signs and verifies webhook payloads", () => {
    const payload = JSON.stringify({ type: "email.sent" });
    const signed = sign(payload, "secret", "evt_test", 123);
    expect(verify(payload, "secret", signed.id, String(signed.timestamp), signed.signature)).toBe(true);
  });

  it("renders templates with declared and inferred variables", () => {
    expect(
      renderTemplate(
        {
          subject: "Hello {{name}}",
          html: "<p>{{message}}</p>",
          variables: ["name", "message"]
        },
        { name: "Ada", message: "Welcome" }
      )
    ).toEqual({
      subject: "Hello Ada",
      html: "<p>Welcome</p>",
      text: undefined
    });
  });

  it("fails when a template variable is missing", () => {
    expect(() => renderTemplate({ subject: "Hello {{name}}", text: "Hi" }, {})).toThrow(ApiError);
  });
});
