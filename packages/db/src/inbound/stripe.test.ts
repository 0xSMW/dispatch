import { describe, expect, it, vi } from "vitest";
import { mapStripe, stripeEventId, stripeEvents, stripeMoney } from "./stripe.js";

const customerId = "cus_synthetic";
const invoice = {
  id: "in_synthetic", customer: customerId, customer_email: " Ada@Example.com ",
  amount_due: 4900, amount_paid: 4900, currency: "usd", number: "INV-0001",
  hosted_invoice_url: "https://invoice.stripe.test/synthetic",
  invoice_pdf: "https://invoice.stripe.test/synthetic.pdf",
  created: 1_800_000_000, due_date: 1_800_086_400, next_payment_attempt: 1_800_172_800,
  status_transitions: { paid_at: 1_800_000_000 },
  lines: { data: [{ description: "Pro", quantity: 1, amount: 4900, price: { lookup_key: "pro" } }] }
};
function event(type: string, source: unknown = invoice) {
  return { id: "evt_synthetic", type, data: { object: source } };
}

describe("Stripe mapping", () => {
  it("supplies the exact Failed payment preset variables and provider namespace", async () => {
    const result = await mapStripe(event("invoice.payment_failed"));
    expect(result.action).toBe("upsert");
    if (result.action !== "upsert") throw new Error("Expected upsert");
    expect(result.lookup).toEqual({ email: "ada@example.com" });
    expect(result.contact).toEqual({ properties: { stripe_customer_id: customerId } });
    expect(result.event.name).toBe("stripe.invoice.payment_failed");
    expect(result.event.data).toMatchObject({
      customer_id: customerId, invoice_id: invoice.id, email: "ada@example.com",
      AMOUNT: "$49.00", UPDATE_PAYMENT_URL: invoice.hosted_invoice_url,
      INVOICE_NUMBER: "INV-0001", PLAN: "pro", INVOICE_URL: invoice.hosted_invoice_url
    });
    expect(result.event.data).not.toHaveProperty("object");
  });

  it.each(["invoice.paid", "invoice.finalized"])("preserves receipt and invoice variables for %s", async (type) => {
    const result = await mapStripe(event(type));
    if (result.action !== "upsert") throw new Error("Expected upsert");
    expect(result.event.data).toMatchObject({
      TOTAL: "$49.00", AMOUNT_DUE: "$49.00", RECEIPT_NUMBER: "INV-0001",
      PAY_URL: invoice.hosted_invoice_url, RECEIPT_URL: invoice.hosted_invoice_url, PDF_URL: invoice.invoice_pdf,
      PAID_AT: "2027-01-15T08:00:00.000Z", ISSUED_AT: "2027-01-15T08:00:00.000Z",
      DUE_DATE: "2027-01-16T08:00:00.000Z", NEXT_RETRY_AT: "2027-01-17T08:00:00.000Z",
      LINE_ITEMS: [{ description: "Pro", quantity: 1, amount: "$49.00" }]
    });
  });

  it("keeps nullable invoice fields explicit without fabricating a payment URL", async () => {
    const result = await mapStripe(event("invoice.payment_failed", {
      ...invoice, hosted_invoice_url: null, number: null, amount_due: undefined, lines: { data: [] }
    }));
    if (result.action !== "upsert") throw new Error("Expected upsert");
    expect(result.event.data).toMatchObject({ AMOUNT: "", UPDATE_PAYMENT_URL: "", INVOICE_NUMBER: "", PLAN: "" });
  });

  it.each(["customer.created", "customer.updated"])("maps %s by email and stores the customer property", async (type) => {
    const result = await mapStripe(event(type, { id: customerId, email: "Ada@Example.com", name: "Ada Lovelace" }));
    expect(result).toMatchObject({
      action: "upsert", lookup: { email: "ada@example.com" },
      contact: { properties: { stripe_customer_id: customerId } },
      event: { name: `stripe.${type}` }
    });
  });

  it("uses checkout customer_details email before optional resolution", async () => {
    const resolveCustomer = vi.fn();
    expect(await mapStripe(event("checkout.session.completed", {
      id: "cs_synthetic", customer: customerId, customer_details: { email: "ada@example.com" }
    }), { resolveCustomer })).toMatchObject({
      action: "upsert", lookup: { email: "ada@example.com" },
      contact: { properties: { stripe_customer_id: customerId } },
      event: { name: "stripe.checkout.session.completed", data: { checkout_session_id: "cs_synthetic" } }
    });
    expect(resolveCustomer).not.toHaveBeenCalled();
  });

  it.each(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"])(
    "maps %s through the customer property when no resolver is supplied", async (type) => {
      const result = await mapStripe(event(type, {
        id: "sub_synthetic", customer: customerId, status: "canceled",
        items: { data: [{ price: { lookup_key: "pro" } }] }
      }), { mapPlan: true });
      expect(result).toMatchObject({
        action: "upsert", lookup: { property: "stripe_customer_id", value: customerId },
        contact: { properties: { stripe_customer_id: customerId, plan: "pro" } },
        event: { name: `stripe.${type}`, data: { subscription_id: "sub_synthetic", status: "canceled", PLAN: "pro" } }
      });
    }
  );

  it("writes the plan only when enabled and understands expanded current invoice prices", async () => {
    const source = {
      ...invoice, lines: { data: [{ pricing: { price_details: { price: { id: "price_synthetic", lookup_key: "business" } } } }] }
    };
    const defaultMapping = await mapStripe(event("invoice.paid", source));
    const enabled = await mapStripe(event("invoice.paid", source), { mapPlan: true });
    if (defaultMapping.action !== "upsert" || enabled.action !== "upsert") throw new Error("Expected upsert");
    expect(defaultMapping.contact.properties).not.toHaveProperty("plan");
    expect(enabled.contact.properties?.plan).toBe("business");
    expect(enabled.event.data.PLAN).toBe("business");
  });

  it("does not guess lookup keys from unexpanded price IDs", async () => {
    const result = await mapStripe(event("invoice.paid", {
      ...invoice, lines: { data: [{ pricing: { price_details: { price: "price_synthetic" } } }] }
    }), { mapPlan: true });
    if (result.action !== "upsert") throw new Error("Expected upsert");
    expect(result.event.data.PLAN).toBe("");
    expect(result.contact.properties).not.toHaveProperty("plan");
  });

  it("uses an injected customer resolver when only a customer ID is available", async () => {
    const resolveCustomer = vi.fn(async (id: string) => ({ id, email: "Resolved@Example.com" }));
    const result = await mapStripe(event("customer.subscription.trial_will_end", {
      id: "sub_synthetic", customer: customerId, trial_end: 1_800_000_000
    }), { resolveCustomer });
    expect(resolveCustomer).toHaveBeenCalledExactlyOnceWith(customerId);
    expect(result).toMatchObject({
      action: "upsert", lookup: { email: "resolved@example.com" },
      event: { name: "stripe.customer.subscription.trial_will_end", data: { TRIAL_END_DATE: "2027-01-15T08:00:00.000Z" } }
    });
  });

  it("uses expanded customer email without invoking the resolver", async () => {
    const resolveCustomer = vi.fn();
    const result = await mapStripe(event("customer.subscription.updated", {
      id: "sub_synthetic", customer: { id: customerId, email: "expanded@example.com" }
    }), { resolveCustomer });
    expect(result).toMatchObject({ action: "upsert", lookup: { email: "expanded@example.com" } });
    expect(resolveCustomer).not.toHaveBeenCalled();
  });

  it("falls back to property lookup if a resolver returns no usable customer", async () => {
    for (const customer of [null, { id: "wrong", email: "wrong@example.com" },
      { id: customerId, deleted: true, email: "deleted@example.com" }, { id: customerId, email: null }]) {
      const result = await mapStripe(event("customer.subscription.updated", { customer: customerId }), {
        resolveCustomer: () => customer
      });
      expect(result).toMatchObject({ action: "upsert", lookup: { property: "stripe_customer_id", value: customerId } });
    }
  });

  it("propagates resolution errors for consumer transaction rollback/retry", async () => {
    await expect(mapStripe(event("customer.subscription.updated", { customer: customerId }), {
      resolveCustomer: async () => { throw new Error("synthetic resolution failure"); }
    })).rejects.toThrow("synthetic resolution failure");
  });

  it("retains deleted customer contacts and never treats subscription deletion as contact deletion", async () => {
    const resolveCustomer = vi.fn();
    expect(await mapStripe(event("customer.deleted", { id: customerId, deleted: true }), { resolveCustomer })).toEqual({
      action: "retain", lookup: { property: "stripe_customer_id", value: customerId },
      event: { name: "stripe.customer.deleted", data: { customer_id: customerId } }
    });
    expect(resolveCustomer).not.toHaveBeenCalled();
    expect((await mapStripe(event("customer.subscription.deleted", { customer: customerId }))).action).toBe("upsert");
  });

  it("ignores unknown events before any resolution, and handles missing contacts/invalid envelopes", async () => {
    const resolveCustomer = vi.fn();
    expect(await mapStripe(event("charge.succeeded"), { resolveCustomer })).toEqual({ action: "ignored", reason: "unsupported_event" });
    expect(resolveCustomer).not.toHaveBeenCalled();
    expect(await mapStripe(event("invoice.paid", { customer_email: null, customer: null })))
      .toEqual({ action: "ignored", reason: "no_contact" });
    for (const payload of [null, [], {}, { type: "invoice.paid", data: { object: invoice } },
      { id: "evt_synthetic", type: "invoice.paid", data: {} }]) {
      expect(await mapStripe(payload)).toEqual({ action: "ignored", reason: "invalid_payload" });
    }
    expect(stripeEventId(event("invoice.paid"))).toBe("evt_synthetic");
    expect(stripeEventId({ id: 123 })).toBeUndefined();
  });

  it("has an explicit supported event set and leaves the original payload unchanged", async () => {
    expect(stripeEvents).toHaveLength(20);
    const payload = event("invoice.payment_failed", structuredClone(invoice));
    const before = structuredClone(payload);
    await mapStripe(payload, { mapPlan: true });
    expect(payload).toEqual(before);
  });
});

describe("Stripe currency formatting", () => {
  it.each([
    [4900, "usd", "$49.00"], [4900, "jpy", "¥4,900"],
    [1234, "kwd", "KWD 1.234"], [50000, "isk", "ISK 500"],
    [50000, "ugx", "UGX 500"], [1234, "huf", "HUF 12.34"],
    [4900, "mga", "MGA 4,900"], [0, "eur", "€0.00"], [-100, "usd", "-$1.00"]
  ])("formats %s %s as %s", (amount, currency, expected) => {
    expect(stripeMoney(amount, currency)).toBe(expected);
  });

  it("never invents a formatted amount for absent or malformed currency/amount data", () => {
    for (const amount of [undefined, null, "4900", NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(stripeMoney(amount, "usd")).toBe("");
    for (const currency of [undefined, "", "$", "notacurrency", 123]) expect(stripeMoney(4900, currency)).toBe("");
  });
});
