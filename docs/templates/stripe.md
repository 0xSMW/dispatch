# Stripe

## Receiver setup

Create a Stripe integration in **Settings > Integrations**, or use the API:

```sh
jq -n --arg secret "$STRIPE_WEBHOOK_SECRET" \
  '{provider:"stripe",name:"Stripe billing",secret:$secret,settings:{map_plan:false}}' |
curl --fail-with-body --silent --show-error "$DISPATCH_API_URL/integrations" \
  -H "Authorization: Bearer $DISPATCH_API_KEY" \
  -H "Content-Type: application/json" --data-binary @-
```

Create returns safe integration fields plus flat, top-level `token` and `url` once. Configure that URL as the Stripe webhook endpoint and set `secret` to that endpoint's signing secret. If you create the Dispatch receiver before Stripe gives you the endpoint secret, use a private temporary secret, configure the endpoint, then replace `secret` through `PATCH /integrations/:id` before accepting deliveries. The receiver verifies `Stripe-Signature` over raw bytes with a 300-second timestamp tolerance.

Normal GETs never return the URL or credentials. Rotate with `POST /integrations/:id/rotate` to obtain a replacement URL; replace the old URL in Stripe. See [management and body-free delivery history](../integrations.md#delivery-history-and-replay-retention), including the `LOG_RETENTION_DAYS` replay bound (default 30 days).

### Mapped events and contacts

Subscribe only to the supported events you need:

| Stripe events | Dispatch events |
| --- | --- |
| `customer.created`, `customer.updated`, `customer.deleted` | `stripe.customer.created`, `stripe.customer.updated`, `stripe.customer.deleted` |
| `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `.trial_will_end` | Each complete provider name prefixed with `stripe.` |
| `checkout.session.completed`, `.async_payment_succeeded`, `.async_payment_failed` | Each complete provider name prefixed with `stripe.` |
| `invoice.created`, `.finalized`, `.paid`, `.payment_succeeded`, `.payment_failed`, `.payment_action_required`, `.voided`, `.marked_uncollectible` | Each complete provider name prefixed with `stripe.` |

Contacts store `stripe_customer_id`. An email in the payload can identify the contact; events with only a customer ID can resolve an existing contact by that property. Optionally set `settings.stripe_restricted_key` to a Stripe restricted key with customer read permission for customer-email lookup. GET returns only `has_restricted_key`, never the key. Missing or ambiguous contact matches are ignored rather than selecting an arbitrary contact; deleted contacts are not revived. `customer.deleted` retains an existing contact rather than creating or deleting one.

### Receiver invoice variables

Invoice events supply actual billing values to the event payload:

| Variable | Source |
| --- | --- |
| `AMOUNT`, `AMOUNT_DUE` | `amount_due`, formatted in the invoice currency |
| `UPDATE_PAYMENT_URL`, `INVOICE_URL`, `PAY_URL`, `RECEIPT_URL` | `hosted_invoice_url`, or an empty string when absent |
| `INVOICE_NUMBER`, `RECEIPT_NUMBER` | `number`, or an empty string |
| `invoice_id` | Invoice `id` |
| `TOTAL` | Formatted `amount_paid` |
| `PLAN` | First available price lookup key in provider line order, or an empty string |

They also include `LINE_ITEMS`, `PDF_URL`, `ISSUED_AT`, `DUE_DATE`, `PAID_AT` and `NEXT_RETRY_AT`. Subscription events include `subscription_id`, `status` and `TRIAL_END_DATE`; checkout events include `checkout_session_id`. `PLAN` is available in event data, but storing it as `contact.properties.plan` requires `settings.map_plan: true`.

The receiver's **`UPDATE_PAYMENT_URL` is a hosted invoice pay link**, not a card-update billing portal. Review and adjust button copy to describe paying or viewing the invoice. The receiver does not create billing-portal sessions or supply an app-owned `ACTION_URL` for trial emails. Missing values are not replaced by preview samples. Install and review [Failed payment](../automations/failed-payment.md) separately; enabling a receiver does not enable that preset.

Waits match contact and event name, not `invoice_id`. Stripe remains the billing source of truth; this integration does not cancel subscriptions.

## Manual email alternative

Keep a code-owned, signature-verified handler when you need custom recipient lookup, app-owned billing links or direct template sends. Do not also route the same events into an enabled receiver-driven flow without business deduplication.

`data.object` is the Invoice for invoice events, and the Subscription for `customer.subscription.trial_will_end`.

Money fields are integers in Stripe's currency units. `amount_paid` of `4900` with currency `usd` is `$49.00`. The template wants formatted strings in `TOTAL`, `AMOUNT_DUE`, and each line's `amount`; it does not format money itself. The helper below handles zero-decimal and three-decimal currencies and Stripe's legacy ISK/UGX representation.

`customer_email` is a snapshot of the customer's email once the invoice is finalized. It can be null. `hosted_invoice_url` stays null until the invoice is finalized. `invoice_pdf` is the PDF URL.

| Event | Template | What to pass |
| --- | --- | --- |
| `invoice.paid` | `receipt` | `RECEIPT_NUMBER` from `number`, `PAID_AT` as an absolute time, `TOTAL` from `amount_paid`, `LINE_ITEMS` from `lines.data` |
| `invoice.finalized` | `invoice` | `INVOICE_NUMBER`, `ISSUED_AT`, `DUE_DATE`, `AMOUNT_DUE` from `amount_due`, `LINE_ITEMS`, `PAY_URL` from `hosted_invoice_url` |
| `invoice.payment_failed` | `payment-failed` | `AMOUNT` from `amount_due`, `UPDATE_PAYMENT_URL` from your billing portal, `INVOICE_URL` from `hosted_invoice_url` |
| `customer.subscription.trial_will_end` | `trial-ending` | `TRIAL_END_DATE` from `trial_end`, `ACTION_URL` from your billing page |

In this manual alternative, `UPDATE_PAYMENT_URL` is your app's billing-portal card-update link and `ACTION_URL` is your app's billing page. Neither is a Stripe payload field. This intentionally differs from the receiver's hosted-invoice `UPDATE_PAYMENT_URL`. Create any portal session in your billing application and protect the entry point appropriately. `trial_end` is a unix timestamp in seconds. Format it with a timezone. The subscription object does not include the email unless you expanded `customer`. Retrieve the customer and read `email`.

A line item uses `description`, `quantity`, and `amount`. Format `amount` the same way as `amount_paid`. Quantity can be a number.

```ts
function money(amount: number, currency: string) {
  const code = currency.toUpperCase();
  const zeroDecimal = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"]);
  const digits = zeroDecimal.has(code) ? 0 : ["BHD", "JOD", "KWD", "OMR", "TND"].includes(code) ? 3 : 2;
  const displayDigits = ["ISK", "UGX"].includes(code) ? 0 : digits;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: code,
    minimumFractionDigits: displayDigits, maximumFractionDigits: displayDigits,
  }).format(amount / 10 ** digits);
}

function when(unix: number | null) {
  if (!unix) return "";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(unix * 1000) + " UTC";
}

type Line = { description?: string | null; quantity?: number | null; amount?: number | null };

export function receiptVariables(invoice: {
  number: string | null;
  status_transitions?: { paid_at?: number | null };
  amount_paid: number;
  currency: string;
  lines: { data: Line[] };
}) {
  return {
    RECEIPT_NUMBER: invoice.number ?? "",
    PAID_AT: when(invoice.status_transitions?.paid_at ?? null),
    TOTAL: money(invoice.amount_paid, invoice.currency),
    LINE_ITEMS: lineItems(invoice.lines.data, invoice.currency),
  };
}

function lineItems(lines: Line[], currency: string) {
  return lines.map((line) => ({
    description: line.description ?? "Item",
    quantity: line.quantity ?? 1,
    amount: money(line.amount ?? 0, currency),
  }));
}
```

`RECEIPT_NUMBER` is required, and `number` is null on a draft. Send `receipt` from `invoice.paid`, after Stripe has assigned the number. Skip the send when `customer_email` is null.

### The manual webhook handler

One handler covers the four events. Verify the Stripe signature before this runs. `billingUrl` and `portalUrl` are pages in your own app.

```ts
type Invoice = {
  number: string | null;
  customer_email: string | null;
  created: number;
  due_date: number | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  next_payment_attempt: number | null;
  status_transitions?: { paid_at?: number | null };
  lines: { data: Line[] };
};

type Subscription = { customer: string; trial_end: number | null };

async function send(to: string, id: string, variables: Record<string, unknown>, key: string) {
  const response = await fetch(`${process.env.DISPATCH_API_URL}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.DISPATCH_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ from: process.env.DISPATCH_FROM, to, template: { id, variables } }),
  });
  if (!response.ok) throw new Error(await response.text());
}

export async function onStripeEvent(
  event: { id: string; type: string; data: { object: unknown } },
  app: { billingUrl: string; portalUrl: string; customerEmail: (customerId: string) => Promise<string | null> },
) {
  if (event.type === "customer.subscription.trial_will_end") {
    const subscription = event.data.object as Subscription;
    const to = await app.customerEmail(subscription.customer);
    if (!to || !subscription.trial_end) return;
    await send(to, "trial-ending", { TRIAL_END_DATE: when(subscription.trial_end), ACTION_URL: app.billingUrl }, event.id);
    return;
  }

  const invoice = event.data.object as Invoice;
  if (!invoice.customer_email) return;

  if (event.type === "invoice.paid") {
    await send(invoice.customer_email, "receipt", {
      ...receiptVariables(invoice),
      ...(invoice.hosted_invoice_url ? { RECEIPT_URL: invoice.hosted_invoice_url } : {}),
    }, event.id);
  }

  if (event.type === "invoice.finalized" && invoice.number && invoice.hosted_invoice_url) {
    await send(invoice.customer_email, "invoice", {
      INVOICE_NUMBER: invoice.number,
      ISSUED_AT: when(invoice.created),
      DUE_DATE: when(invoice.due_date ?? invoice.created),
      AMOUNT_DUE: money(invoice.amount_due, invoice.currency),
      LINE_ITEMS: lineItems(invoice.lines.data, invoice.currency),
      PAY_URL: invoice.hosted_invoice_url,
      ...(invoice.invoice_pdf ? { PDF_URL: invoice.invoice_pdf } : {}),
    }, event.id);
  }

  if (event.type === "invoice.payment_failed") {
    await send(invoice.customer_email, "payment-failed", {
      AMOUNT: money(invoice.amount_due, invoice.currency),
      UPDATE_PAYMENT_URL: app.portalUrl,
      ...(invoice.next_payment_attempt ? { NEXT_RETRY_AT: when(invoice.next_payment_attempt) } : {}),
      ...(invoice.hosted_invoice_url ? { INVOICE_URL: invoice.hosted_invoice_url } : {}),
    }, event.id);
  }
}
```

The Stripe event ID is the idempotency key. Stripe delivers an event more than once when the handler is slow or fails, and the key makes a second delivery return the first email instead of sending another. Dispatch keeps a key for 24 hours, and Stripe can retry for up to three days. To be safe past the first day, record the event IDs you have handled in your own database and skip the ones you have seen.

`invoice.finalized` is skipped until the invoice has a number and a hosted URL, because `INVOICE_NUMBER` and `PAY_URL` are required. An invoice with no due date uses its creation date for `DUE_DATE`. Change that if your invoices are due on receipt and you want the email to say so.
