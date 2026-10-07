import { describe, expect, it } from "vitest";
import { mapWebhook, webhookSlug } from "./webhook.js";

const payload = {
  event: "invoice.paid", email: " Ada@Example.com ",
  contact: { first_name: "Ada", last_name: null, properties: { plan: "pro", activated: true, count: 4 } },
  data: { AMOUNT: "$49.00", invoice_id: "invoice_synthetic" }
};

describe("Standard Webhooks mapping", () => {
  it("uses the per-integration namespace, with webhook as its default", () => {
    expect(mapWebhook(payload, "billing")).toEqual({
      action: "upsert", lookup: { email: "ada@example.com" }, contact: payload.contact,
      event: { name: "billing.invoice.paid", data: payload.data }
    });
    const result = mapWebhook(payload);
    if (result.action !== "upsert") throw new Error("Expected upsert");
    expect(result.event.name).toBe("webhook.invoice.paid");
    expect(result.event.data).toEqual(payload.data);
  });

  it("keeps a purported provider event under its own namespace", () => {
    const result = mapWebhook({ ...payload, event: "stripe.invoice.payment_failed" }, "billing");
    if (result.action !== "upsert") throw new Error("Expected upsert");
    expect(result.event.name).toBe("billing.stripe.invoice.payment_failed");
  });

  it("allows optional contact patches without requiring lifecycle state", () => {
    expect(mapWebhook({ event: "user.inactive", email: "ada@example.com", data: {} })).toEqual({
      action: "upsert", lookup: { email: "ada@example.com" }, contact: {},
      event: { name: "webhook.user.inactive", data: {} }
    });
  });

  it("refuses named-provider slugs, internal events and overlong names", () => {
    for (const slug of ["stripe", "clerk", "supabase", "@internal", "billing.other", ""]) {
      expect(webhookSlug(slug)).toBe(false);
      expect(mapWebhook(payload, slug)).toEqual({ action: "ignored", reason: "invalid_payload" });
    }
    expect(webhookSlug("billing-v2")).toBe(true);
    expect(mapWebhook({ ...payload, event: "@contact.updated" })).toEqual({ action: "ignored", reason: "invalid_payload" });
    expect(mapWebhook({ ...payload, event: "a".repeat(112) }).action).toBe("upsert");
    expect(mapWebhook({ ...payload, event: "a".repeat(113) })).toEqual({ action: "ignored", reason: "invalid_payload" });
  });

  it("never accepts deletion, revival or consent instructions as a contact patch", () => {
    for (const contact of [{ deleted_at: null }, { delete: true }, { email: "other@example.com" }, { unsubscribed: false }]) {
      expect(mapWebhook({ ...payload, contact })).toEqual({ action: "ignored", reason: "invalid_payload" });
    }
  });

  it("ignores missing contacts and malformed envelopes/patches/data", () => {
    for (const email of [undefined, null, "invalid", "a@b.com\nBcc: other@b.com"]) {
      expect(mapWebhook({ ...payload, email })).toEqual({ action: "ignored", reason: "no_contact" });
    }
    for (const value of [null, [], {}, { ...payload, data: [] }, { ...payload, data: null },
      { ...payload, data: undefined }, { ...payload, contact: { first_name: 123 } },
      { ...payload, contact: { properties: [] } }]) {
      expect(mapWebhook(value)).toEqual({ action: "ignored", reason: "invalid_payload" });
    }
  });

  it("does not mutate incoming data or contact fields", () => {
    const before = structuredClone(payload);
    mapWebhook(payload);
    expect(payload).toEqual(before);
  });
});
