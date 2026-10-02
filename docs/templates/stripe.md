# Stripe

Checked against the Invoice object and the subscription webhook list on 2026-10-01. `data.object` is the Invoice for the invoice events, and the Subscription for `customer.subscription.trial_will_end`.

Money fields are integers in the smallest currency unit. `amount_paid` of `4900` with currency `usd` is `$49.00`. Divide by 100 for two-decimal currencies. Do not divide for a zero-decimal currency such as `jpy`. The template wants a formatted string in `TOTAL`, `AMOUNT_DUE`, and each line's `amount`. It does not format money itself.

`customer_email` is a snapshot of the customer's email once the invoice is finalized. It can be null. `hosted_invoice_url` stays null until the invoice is finalized. `invoice_pdf` is the PDF URL.

| Event | Template | What to pass |
| --- | --- | --- |
| `invoice.paid` | `receipt` | `RECEIPT_NUMBER` from `number`, `PAID_AT` as an absolute time, `TOTAL` from `amount_paid`, `LINE_ITEMS` from `lines.data` |
| `invoice.finalized` | `invoice` | `INVOICE_NUMBER`, `ISSUED_AT`, `DUE_DATE`, `AMOUNT_DUE` from `amount_due`, `LINE_ITEMS`, `PAY_URL` from `hosted_invoice_url` |
| `invoice.payment_failed` | `payment-failed` | `AMOUNT` from `amount_due`, `UPDATE_PAYMENT_URL` from your billing portal, `INVOICE_URL` from `hosted_invoice_url` |
| `customer.subscription.trial_will_end` | `trial-ending` | `TRIAL_END_DATE` from `trial_end`, `ACTION_URL` from your billing page |

`UPDATE_PAYMENT_URL` and `ACTION_URL` are not Stripe fields. Stripe's hosted invoice page is a receipt or a pay page, not the page where the customer changes a card or cancels. Build those two URLs in the app. `trial_end` is a unix timestamp in seconds. Format it with a timezone. The subscription object does not include the email unless you expanded `customer`. Retrieve the customer and read `email`.

A line item uses `description`, `quantity`, and `amount`. Format `amount` the same way as `amount_paid`. Quantity can be a number.

```ts
function money(amount: number, currency: string) {
  const zeroDecimal = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
  const major = zeroDecimal.has(currency.toLowerCase()) ? amount : amount / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(major);
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

## The webhook handler

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
  const response = await fetch(`${process.env.DISPATCH_BASE_URL}/emails`, {
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
