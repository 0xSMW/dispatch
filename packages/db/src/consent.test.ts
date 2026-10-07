import { describe, expect, it, vi } from "vitest";
import { seal, stableHash, type FormRecord } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { confirmForm, confirmationState, readConfirmationToken, submitForm } from "./consent.js";
import { subscriptionStored, subscriptionWire } from "./audience.js";

const secret = "synthetic-consent-unit-secret";
const payload = { use: "confirm" as const, id: "confirm_1", tenant_id: "tenant_1", form_id: "form_1",
  contact_id: "contact_1", topic_hash: stableHash(["topic_1"]), exp: Math.floor(Date.now() / 1000) + 7 * 86400 };
const form: FormRecord = { id: "form_1", tenant_id: "tenant_1", key: "key", name: "News",
  topic_ids: ["topic_1"], properties: [], from_email: "hello@example.com", double_opt_in: true,
  allowed_origins: ["https://example.com"], redirect_url: "https://example.com/thanks",
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null };
const contact = { id: "contact_1", email: "person@example.com", first_name: null, last_name: null,
  properties: {}, unsubscribed_at: "2026-01-01", deleted_at: "2026-01-01", created_at: "2026-01-01", updated_at: "2026-01-01" };
const state = { ...payload, topic_ids: ["topic_1"], used_at: null, expires_at: new Date(payload.exp * 1000).toISOString() };
describe("confirmation consent", () => {
  it("rejects purpose, signature, missing scope, and expired or malformed expiry", () => {
    expect(readConfirmationToken(seal(payload, secret), secret)).toEqual(payload);
    for (const patch of [{ use: "unsub" }, { tenant_id: "" }, { form_id: null }, { exp: 0 }, { exp: "later" }, { topic_hash: null }])
      expect(readConfirmationToken(seal({ ...payload, ...patch }, secret), secret)).toBeNull();
    expect(readConfirmationToken(seal(payload, "another-secret"), secret)).toBeNull();
  });
  it("requires durable scope, expiry and topic binding without a write", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [state] });
    const db = { query } as unknown as Queryable;
    await confirmationState(db, payload);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toContain("expires_at > clock_timestamp()");
    expect(query.mock.calls[0]![0]).not.toContain("for update");
    await expect(confirmationState(db, { ...payload, topic_hash: stableHash(["foreign"]) })).rejects.toMatchObject({ statusCode: 404 });
  });
  it("used POST after later opt-out and deletion never updates consent, history, or runs", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("from forms") ? [form]
      : sql.includes("from contacts") ? [contact] : sql.includes("from confirmations") ? [{ ...state, used_at: "2026-01-01" }] : [] }));
    expect(await confirmForm({ query } as unknown as Queryable, payload, "req_1")).toBe(form.redirect_url);
    expect(query.mock.calls).toHaveLength(3);
    expect(query.mock.calls.every(([sql]) => sql.trim().startsWith("select"))).toBe(true);
  });
  it("quota refusal leaves opted-out or deleted contacts completely unchanged", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("from domains") ? [{ id: "domain_1" }]
      : sql.includes("from topics") ? [{ id: "topic_1" }] : sql.includes("from contacts") ? [contact]
      : sql.includes("from tenants") ? [{ settings: {} }] : [] }));
    const enqueue = vi.fn();
    await submitForm({ query } as unknown as Queryable, { ...form, double_opt_in: false },
      { email: contact.email, properties: {} }, "req_1", { secret, enqueue });
    expect(enqueue).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.startsWith("update contacts") || sql.startsWith("insert into contacts"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into topic_subscriptions"))).toBe(false);
  });
  it("never presents pending as receiving", () => {
    expect(subscriptionStored("pending")).toBe("pending");
    expect(subscriptionWire("pending")).toBe("pending");
    expect(subscriptionWire("unknown")).toBe("opt_out");
  });
});
