import type { IntegrationRecord } from "@dispatchmail/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactRow } from "../audience.js";
import type { Queryable } from "../index.js";
import { applyInbound, prepareInbound } from "./application.js";
import type { Mapping } from "./types.js";

const effects = vi.hoisted(() => ({
  event: vi.fn(), contact: vi.fn(), emit: vi.fn(),
}));
vi.mock("../automations.js", () => ({ fireEventWithClient: effects.event }));
vi.mock("../contact-triggers.js", () => ({ dispatchContactWrite: effects.contact }));
vi.mock("../events.js", () => ({ emit: effects.emit }));

function integration(provider: IntegrationRecord["provider"] = "stripe", settings: IntegrationRecord["settings"] = {}): IntegrationRecord {
  return {
    id: "integration_synthetic", tenant_id: "tenant_synthetic", provider, name: "Synthetic",
    slug: provider, token_hash: "synthetic_hash", secret: "synthetic_secret", settings,
    last_received_at: null, created_at: "2026-01-01", updated_at: "2026-01-01", deleted_at: null,
  };
}
function contact(overrides: Partial<ContactRow & { deleted_at: string | null }> = {}) {
  return {
    id: "contact_synthetic", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace",
    properties: { stripe_customer_id: "cus_synthetic", favorite: "blue" },
    unsubscribed_at: "2026-01-01", created_at: "2025-01-01", updated_at: "2026-01-01",
    deleted_at: null, ...overrides,
  };
}
const mapping: Mapping = {
  action: "upsert", lookup: { email: "ada@example.com" },
  contact: { first_name: null, properties: { stripe_customer_id: "cus_synthetic", plan: "pro" } },
  event: { name: "stripe.invoice.payment_failed", data: { invoice_id: "in_synthetic", AMOUNT: "$12.34" } },
};

/** Synthetic query interpreter only: no database, SQL execution, retry runner or service. */
function client(
  rows: ReturnType<typeof contact>[] = [],
  definitions: { key: string; type: string }[] = [],
  conflict = false,
) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("select pg_advisory")) return { rows: [] };
    if (sql.includes("select key, type from contact_properties")) return { rows: definitions };
    if (sql.startsWith("select id, email")) return { rows };
    if (sql.startsWith("insert into contacts")) {
      return { rows: conflict ? [] : [contact({
        id: String(values[0]), email: String(values[2]), first_name: values[3] as string | null,
        last_name: values[4] as string | null, properties: JSON.parse(String(values[5])), unsubscribed_at: null,
      })] };
    }
    if (sql.startsWith("update contacts set\n")) return { rows: [contact({
      ...rows[0], first_name: values[2] ? values[3] as string | null : rows[0]!.first_name,
      last_name: values[4] ? values[5] as string | null : rows[0]!.last_name,
      properties: JSON.parse(String(values[6])),
    })] };
    if (sql.startsWith("update contacts set deleted_at")) return { rows: [{ id: rows[0]?.id }] };
    if (sql.startsWith("delete from ")) return { rows: [] };
    throw new Error(`Unexpected synthetic query: ${sql}`);
  });
  return { db: { query } as unknown as Queryable, query };
}
beforeEach(() => {
  vi.clearAllMocks();
  effects.event.mockResolvedValue({});
  effects.contact.mockResolvedValue(undefined);
  effects.emit.mockResolvedValue(undefined);
});

describe("inbound preparation", () => {
  const invoice = {
    id: "evt_synthetic", type: "invoice.payment_failed", data: { object: {
      id: "in_synthetic", customer: "cus_synthetic", customer_email: "ada@example.com",
      amount_due: 1234, currency: "usd", number: "SYN-7", hosted_invoice_url: "https://invoice.example/pay",
      lines: { data: [{ price: { lookup_key: "pro" } }] },
    } },
  };

  it("preserves invoice template values and stores plan only by explicit opt-in", async () => {
    const result = await prepareInbound(integration(), invoice);
    expect(result.action).toBe("upsert");
    if (result.action !== "upsert") throw new Error("Expected upsert");
    expect(result.contact.properties).toEqual({ stripe_customer_id: "cus_synthetic" });
    expect(result.event.data).toMatchObject({
      AMOUNT: "$12.34", UPDATE_PAYMENT_URL: "https://invoice.example/pay",
      INVOICE_NUMBER: "SYN-7", invoice_id: "in_synthetic", PLAN: "pro",
    });
    const optedIn = await prepareInbound(integration("stripe", { map_plan: true }), invoice);
    expect(optedIn.action === "upsert" && optedIn.contact.properties?.plan).toBe("pro");
  });

  it("retrieves a missing Stripe email in preparation, not application", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({
      id: "cus_synthetic", email: "ada@example.com",
    })));
    const result = await prepareInbound(integration(), {
      ...invoice, data: { object: { ...invoice.data.object, customer_email: undefined } },
    }, { stripeRestrictedKey: "rk_test_synthetic", customerTransport: transport });
    expect(transport).toHaveBeenCalledTimes(1);
    const fake = client([contact()]);
    await applyInbound(fake.db, integration(), result, "request_synthetic");
    await applyInbound(fake.db, integration(), result, "request_retry");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("uses provider ID lookup without transport when no restricted key is supplied", async () => {
    const transport = vi.fn();
    const result = await prepareInbound(integration(), {
      ...invoice, data: { object: { ...invoice.data.object, customer_email: undefined } },
    }, { customerTransport: transport });
    expect(result.action !== "ignored" && result.lookup).toEqual({
      property: "stripe_customer_id", value: "cus_synthetic",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("defaults Clerk deletion to retain, with explicit deletion only", async () => {
    const payload = { type: "user.deleted", data: { id: "user_synthetic" } };
    expect((await prepareInbound(integration("clerk"), payload)).action).toBe("retain");
    expect((await prepareInbound(integration("clerk", { delete_contact: true }), payload)).action).toBe("delete");
  });

  it("dispatches Clerk, Supabase and app webhook mappings into separate namespaces", async () => {
    const clerk = await prepareInbound(integration("clerk"), { type: "user.created", data: {
      id: "user_synthetic", primary_email_address_id: "email_primary",
      email_addresses: [{ id: "email_primary", email_address: "ada@example.com" }],
    } });
    const supabase = await prepareInbound(integration("supabase"), {
      schema: "auth", table: "users", type: "INSERT", record: { id: "user_synthetic", email: "ada@example.com" },
    });
    const webhook = await prepareInbound({ ...integration("webhook"), slug: "my-app" }, {
      event: "signed_up", email: "ada@example.com", data: {},
    });
    expect(clerk.action !== "ignored" && clerk.event.name).toBe("clerk.user.created");
    expect(supabase.action !== "ignored" && supabase.event.name).toBe("supabase.user.created");
    expect(webhook.action !== "ignored" && webhook.event.name).toBe("my-app.signed_up");
    expect(await prepareInbound(integration("webhook"), { event: "@internal", email: "ada@example.com", data: {} }))
      .toEqual({ action: "ignored", reason: "invalid_payload" });
  });
});

describe("transaction-bound inbound application", () => {
  it("passes ignored mappings through without any queries or effects", async () => {
    const fake = client();
    expect(await applyInbound(fake.db, integration(), { action: "ignored", reason: "unsupported_event" }, "request"))
      .toEqual({ status: "ignored", eventName: null, contactId: null, reason: "unsupported_event" });
    expect(fake.query).not.toHaveBeenCalled();
  });

  it("merges locked properties, records contact effects and passes the resolved contact to the event operation", async () => {
    const before = contact();
    const fake = client([before]);
    expect(await applyInbound(fake.db, integration(), mapping, "request_synthetic")).toEqual({
      status: "processed", eventName: "stripe.invoice.payment_failed", contactId: before.id,
    });
    const lookup = fake.query.mock.calls.find(([sql]) => sql.startsWith("select id, email"))!;
    expect(lookup[0]).toContain("tenant_id = $1");
    expect(lookup[0]).toContain("order by id for update");
    expect(lookup[0]).not.toContain("deleted_at is null");
    expect(lookup[1]).toEqual(["tenant_synthetic", "ada@example.com", "stripe_customer_id", "cus_synthetic"]);
    const written = effects.contact.mock.calls[0]!;
    expect(written.slice(0, 4)).toEqual([fake.db, "tenant_synthetic", "request_synthetic", before]);
    expect(written[4]).toMatchObject({
      first_name: null, last_name: "Lovelace", unsubscribed_at: before.unsubscribed_at,
      properties: { stripe_customer_id: "cus_synthetic", favorite: "blue", plan: "pro" },
    });
    const update = fake.query.mock.calls.find(([sql]) => sql.startsWith("update contacts"))![0];
    expect(update).not.toContain("unsubscribed_at =");
    expect(update).not.toContain("email =");
    expect(fake.query.mock.calls.some(([sql]) => /topic_subscriptions|suppressions|segment_contacts/.test(sql))).toBe(false);
    expect(effects.event).toHaveBeenCalledWith(fake.db, "tenant_synthetic", "request_synthetic", {
      ...mapping.event, email: before.email,
    }, written[4]);
    expect(effects.contact.mock.invocationCallOrder[0]).toBeLessThan(effects.emit.mock.invocationCallOrder[0]!);
    expect(effects.emit.mock.invocationCallOrder[0]).toBeLessThan(effects.event.mock.invocationCallOrder[0]!);
    expect(fake.query.mock.calls.some(([sql]) => /^(begin|commit|rollback)$/i.test(sql))).toBe(false);
  });

  it("creates an absent email contact with conflict-do-nothing, never conflict update", async () => {
    const fake = client();
    const result = await applyInbound(fake.db, integration(), mapping, "request");
    expect(result.status).toBe("processed");
    const insert = fake.query.mock.calls.find(([sql]) => sql.startsWith("insert into contacts"))!;
    expect(insert[0]).toContain("on conflict do nothing");
    expect(insert[0]).not.toContain("do update");
    expect(effects.contact.mock.calls[0]![3]).toBeNull();
    expect(effects.contact.mock.calls[0]![5]).toEqual({ created: true });
  });

  it("rejects an insertion race without invoking any contact or event effects", async () => {
    const fake = client([], [], true);
    await expect(applyInbound(fake.db, integration(), mapping, "request")).rejects.toThrow("Contact changed");
    expect(effects.contact).not.toHaveBeenCalled();
    expect(effects.event).not.toHaveBeenCalled();
  });

  it("never revives a tombstone even if it is found via provider ID rather than email", async () => {
    const fake = client([contact({ email: "old@example.com", deleted_at: "2026-01-02" })]);
    expect(await applyInbound(fake.db, integration(), mapping, "request")).toMatchObject({
      status: "ignored", contactId: null, reason: "no_contact",
    });
    expect(fake.query.mock.calls.some(([sql]) => /^(insert|update|delete)/.test(sql))).toBe(false);
    expect(effects.event).not.toHaveBeenCalled();
  });

  it.each([
    [contact(), contact({ id: "contact_other" })],
    [contact(), contact({ id: "contact_deleted", deleted_at: "2026-01-02" })],
  ])("refuses multiple matching rows, including live/tombstone collisions", async (...rows) => {
    const fake = client(rows);
    expect(await applyInbound(fake.db, integration(), mapping, "request")).toMatchObject({
      status: "ignored", reason: "ambiguous_contact",
    });
    expect(effects.event).not.toHaveBeenCalled();
    expect(effects.contact).not.toHaveBeenCalled();
  });

  it("does not replace a different provider identity already attached to the email", async () => {
    const fake = client([contact({ properties: { stripe_customer_id: "cus_other" } })]);
    expect(await applyInbound(fake.db, integration(), mapping, "request")).toMatchObject({
      status: "ignored", reason: "ambiguous_contact",
    });
    expect(effects.event).not.toHaveBeenCalled();
  });

  it("resolves a provider identity with a changed address without creating or replacing the stored address", async () => {
    const before = contact({ email: "old@example.com" });
    const fake = client([before]);
    await applyInbound(fake.db, integration(), mapping, "request");
    expect(effects.event.mock.calls[0]![3].email).toBe("old@example.com");
    expect(fake.query.mock.calls.some(([sql]) => sql.startsWith("insert into contacts"))).toBe(false);
  });

  it("validates declared property types before contact writes and event effects", async () => {
    const fake = client([contact()], [{ key: "plan", type: "number" }]);
    await expect(applyInbound(fake.db, integration(), mapping, "request")).rejects.toThrow("Property plan must be a number");
    expect(fake.query.mock.calls.some(([sql]) => sql.startsWith("update"))).toBe(false);
    expect(effects.event).not.toHaveBeenCalled();
  });

  it.each(["retain", "delete", "upsert"] as const)("does not create an unresolved property-only %s", async (action) => {
    const fake = client();
    const result = await applyInbound(fake.db, integration("clerk"), {
      action, lookup: { property: "clerk_user_id", value: "user_synthetic" },
      ...(action === "upsert" ? { contact: {} } : {}),
      event: { name: "clerk.user.deleted", data: {} },
    } as Mapping, "request");
    expect(result).toMatchObject({ status: "ignored", reason: "no_contact" });
    expect(fake.query.mock.calls.some(([sql]) => /^(insert|update|delete)/.test(sql))).toBe(false);
  });

  it("retains a resolved Clerk contact and history by default without contact cleanup", async () => {
    const before = contact({ properties: { clerk_user_id: "user_synthetic" } });
    const fake = client([before]);
    const result = await prepareInbound(integration("clerk"), { type: "user.deleted", data: { id: "user_synthetic" } });
    await applyInbound(fake.db, integration("clerk"), result, "request");
    expect(effects.event.mock.calls[0]![4]).toEqual(before);
    expect(effects.contact).not.toHaveBeenCalled();
    expect(effects.emit).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.some(([sql]) => /^(insert|update|delete)/.test(sql))).toBe(false);
  });

  it("records explicit deletion's event first, then uses ordinary cleanup and emits deletion without a later event upsert", async () => {
    const before = contact({ properties: { clerk_user_id: "user_synthetic" } });
    const fake = client([before]);
    const configured = integration("clerk", { delete_contact: true });
    const result = await prepareInbound(configured, { type: "user.deleted", data: { id: "user_synthetic" } });
    await applyInbound(fake.db, configured, result, "request");
    const deletionIndex = fake.query.mock.calls.findIndex(([sql]) => sql.startsWith("update contacts set deleted_at"));
    expect(effects.event.mock.invocationCallOrder[0]).toBeLessThan(fake.query.mock.invocationCallOrder[deletionIndex]!);
    expect(effects.event).toHaveBeenCalledTimes(1);
    expect(fake.query.mock.calls.filter(([sql]) => sql.startsWith("delete from")).map(([sql]) => sql))
      .toEqual([
        "delete from segment_contacts where tenant_id = $1 and contact_id = $2",
        "delete from topic_subscriptions where tenant_id = $1 and contact_id = $2 and status = 'subscribed'",
        "delete from automation_enrollments where tenant_id = $1 and contact_id = $2",
      ]);
    expect(effects.emit.mock.calls[0]![1].type).toBe("contact.deleted");
    expect(effects.contact).not.toHaveBeenCalled();
  });

  it("propagates transaction-bound event failure to the caller, never committing or deleting afterward", async () => {
    effects.event.mockRejectedValueOnce(new Error("synthetic event failure"));
    const fake = client([contact()]);
    await expect(applyInbound(fake.db, integration(), {
      action: "delete", lookup: { property: "stripe_customer_id", value: "cus_synthetic" },
      event: { name: "stripe.customer.deleted", data: {} },
    }, "request")).rejects.toThrow("synthetic event failure");
    expect(fake.query.mock.calls.some(([sql]) => /^(update|delete|commit)/.test(sql))).toBe(false);
  });

  it("refuses mappings outside the integration namespace before querying", async () => {
    const fake = client();
    await expect(applyInbound(fake.db, integration(), {
      ...mapping, event: { name: "@contact.created", data: {} },
    }, "request")).rejects.toThrow("Invalid inbound event namespace");
    expect(fake.query).not.toHaveBeenCalled();
  });
});
