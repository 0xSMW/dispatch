import { describe, expect, it, vi } from "vitest";
import { formSchema, type FormRecord } from "@dispatchmail/core";
import type { Queryable } from "@dispatchmail/db";
import { formOrigin, formSubmission, honeypot } from "./forms.js";
import { hideLinks, logBodies, redact } from "./logs.js";

const form = { ...formSchema.parse({ name: "News", topic_ids: ["topic_1"], properties: ["active", "score"],
  from_email: "hello@example.com", allowed_origins: ["https://customer.example"] }), tenant_id: "tenant_1" } as FormRecord;
const db = { query: vi.fn(async () => ({ rows: [{ key: "active", type: "boolean" }, { key: "score", type: "number" }] })) } as unknown as Queryable;
describe("public form guards", () => {
  it("requires exact form origins and a blank website honeypot", () => {
    expect(formOrigin(form, "https://customer.example")).toBe(true);
    for (const origin of [undefined, "null", "https://customer.example.evil", "http://customer.example"])
      expect(formOrigin(form, origin)).toBe(false);
    expect(honeypot({ website: "bot" })).toBe(true);
    expect(honeypot({ website: "" })).toBe(false);
  });
  it("accepts allowlisted JSON and encoded scalar properties without extra fields", async () => {
    expect(await formSubmission(db, form, { email: "PERSON@example.com", properties: { active: false, score: 2 } }, false))
      .toEqual({ email: "person@example.com", properties: { active: false, score: 2 } });
    expect(await formSubmission(db, form, { email: "person@example.com", "properties.active": "false", "properties.score": "2" }, true))
      .toEqual({ email: "person@example.com", properties: { active: false, score: 2 } });
    expect(await formSubmission(db, form, { email: "person@example.com", "properties.active": "", "properties.score": "" }, true))
      .toEqual({ email: "person@example.com", properties: {} });
    for (const extra of [{ redirect_url: "https://evil.example" }, { properties: { secret: "x" } }, { properties: [] }])
      await expect(formSubmission(db, form, { email: "person@example.com", ...extra }, false)).rejects.toMatchObject({ statusCode: 400 });
  });
  it("conceals confirmation links and credentials from viewer logs and omits public consent bodies", () => {
    expect(hideLinks('Confirm https://example.com/confirm/sealed.token now')).toBe("Confirm #link-hidden now");
    expect(logBodies({ method: "POST", route: "/confirm/:token", body: {}, responseText: "{}" })).toEqual({ request_body: null, response_body: null });
    expect(redact({ stripe_restricted_key: "synthetic", secret: "synthetic" })).toEqual({ stripe_restricted_key: "[redacted]", secret: "[redacted]" });
  });
});
