import { email, object, text, type ContactLookup, type ContactPatch, type Mapping } from "./types.js";

export const stripeEvents = [
  "customer.created", "customer.updated", "customer.deleted",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.paused", "customer.subscription.resumed", "customer.subscription.trial_will_end",
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "invoice.created", "invoice.finalized", "invoice.paid", "invoice.payment_succeeded",
  "invoice.payment_failed", "invoice.payment_action_required", "invoice.voided", "invoice.marked_uncollectible"
] as const;

export type StripeCustomer = { id: string; email?: string | null; deleted?: boolean };
export type StripeOptions = {
  /** The consumer supplies any customer fetch; this module never uses an SDK or network. */
  resolveCustomer?: (id: string) => StripeCustomer | null | Promise<StripeCustomer | null>;
  /** Write the price lookup key to properties.plan when explicitly enabled. */
  mapPlan?: boolean;
};

/** Stripe amounts use currency minor units, including its legacy ISK/UGX representation. */
export function stripeMoney(amount: unknown, currency: unknown): string {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || typeof currency !== "string" || !/^[a-zA-Z]{3}$/.test(currency)) return "";
  const code = currency.toUpperCase();
  // Stripe's charge units differ from Intl/ISO for HUF, ISK and UGX.
  const zero = ["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"];
  const digits = zero.includes(code) ? 0 : ["BHD", "JOD", "KWD", "OMR", "TND"].includes(code) ? 3 : 2;
  const displayDigits = ["ISK", "UGX"].includes(code) ? 0 : digits;
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency", currency: code, minimumFractionDigits: displayDigits, maximumFractionDigits: displayDigits
  });
  return formatter.format(amount / 10 ** digits);
}

function when(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function reference(value: unknown): string | undefined {
  return text(value) ?? text(object(value)?.id);
}

function pricePlan(value: unknown): string | undefined {
  const item = object(value);
  const price = object(item?.price) ?? object(object(item?.pricing)?.price_details)?.price;
  return text(object(price)?.lookup_key);
}

function plan(source: Record<string, unknown>): string | undefined {
  const lines = object(source.items)?.data ?? object(source.lines)?.data;
  if (!Array.isArray(lines)) return undefined;
  // Multi-price subscriptions use the first line with a lookup key, in provider order.
  return lines.map(pricePlan).find((value) => value !== undefined);
}

export function stripeEventId(payload: unknown): string | undefined {
  return text(object(payload)?.id);
}

export async function mapStripe(payload: unknown, options: StripeOptions = {}): Promise<Mapping> {
  const envelope = object(payload);
  const type = text(envelope?.type);
  if (!type || !stripeEventId(payload)) return { action: "ignored", reason: "invalid_payload" };
  if (!(stripeEvents as readonly string[]).includes(type)) return { action: "ignored", reason: "unsupported_event" };
  const source = object(object(envelope?.data)?.object);
  if (!source) return { action: "ignored", reason: "invalid_payload" };
  const customerEvent = type.startsWith("customer.") && !type.startsWith("customer.subscription.");
  const customerId = customerEvent ? text(source.id) : reference(source.customer);
  if (type === "customer.deleted") {
    if (!customerId) return { action: "ignored", reason: "no_contact" };
    return {
      action: "retain", lookup: { property: "stripe_customer_id", value: customerId },
      event: { name: "stripe.customer.deleted", data: { customer_id: customerId } }
    };
  }
  const expanded = object(source.customer);
  let recipient = customerEvent ? email(source.email)
    : email(source.customer_email) ?? email(object(source.customer_details)?.email)
      ?? email(expanded?.deleted === true ? undefined : expanded?.email);
  if (!recipient && customerId && options.resolveCustomer) {
    // Exceptions deliberately propagate so a receiver transaction can roll back and retry.
    const customer = await options.resolveCustomer(customerId);
    if (customer?.id === customerId && customer.deleted !== true) recipient = email(customer.email);
  }
  const lookup: ContactLookup | undefined = recipient ? { email: recipient }
    : customerId ? { property: "stripe_customer_id", value: customerId } : undefined;
  if (!lookup) return { action: "ignored", reason: "no_contact" };
  const lookupKey = plan(source);
  const contact: ContactPatch = {
    ...(customerId || (options.mapPlan === true && lookupKey) ? {
      properties: {
        ...(customerId ? { stripe_customer_id: customerId } : {}),
        ...(options.mapPlan === true && lookupKey ? { plan: lookupKey } : {})
      }
    } : {})
  };
  const data: Record<string, unknown> = {
    ...(customerId ? { customer_id: customerId } : {}),
    ...(recipient ? { email: recipient } : {}),
    PLAN: lookupKey ?? ""
  };
  if (type.startsWith("invoice.")) {
    const url = text(source.hosted_invoice_url) ?? "";
    Object.assign(data, {
      invoice_id: text(source.id) ?? "",
      AMOUNT: stripeMoney(source.amount_due, source.currency),
      UPDATE_PAYMENT_URL: url,
      INVOICE_NUMBER: text(source.number) ?? "",
      INVOICE_URL: url,
      AMOUNT_DUE: stripeMoney(source.amount_due, source.currency),
      TOTAL: stripeMoney(source.amount_paid, source.currency),
      RECEIPT_NUMBER: text(source.number) ?? "",
      PAY_URL: url, RECEIPT_URL: url,
      PDF_URL: text(source.invoice_pdf) ?? "",
      ISSUED_AT: when(source.created), DUE_DATE: when(source.due_date ?? source.created),
      PAID_AT: when(object(source.status_transitions)?.paid_at),
      NEXT_RETRY_AT: when(source.next_payment_attempt),
      LINE_ITEMS: (Array.isArray(object(source.lines)?.data) ? object(source.lines)!.data as unknown[] : [])
        .map((line) => {
          const item = object(line);
          return {
            description: text(item?.description) ?? "Item",
            quantity: typeof item?.quantity === "number" ? item.quantity : 1,
            amount: stripeMoney(item?.amount, source.currency)
          };
        })
    });
  } else if (type.startsWith("customer.subscription.")) {
    Object.assign(data, {
      subscription_id: text(source.id) ?? "", status: text(source.status) ?? "",
      TRIAL_END_DATE: when(source.trial_end)
    });
  } else if (type.startsWith("checkout.session.")) {
    data.checkout_session_id = text(source.id) ?? "";
  }
  return { action: "upsert", lookup, contact, event: { name: `stripe.${type}`, data } };
}
