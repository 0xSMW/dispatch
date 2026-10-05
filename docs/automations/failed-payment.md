# Failed payment

## Goal

Notify about a failed invoice, wait for payment and follow up on timeouts.

## App-owned state and events

No contact property is declared. Manually produce stripe.invoice.payment_failed through the SDK today with actual billing strings: AMOUNT, UPDATE_PAYMENT_URL, INVOICE_NUMBER, invoice_id. Produce stripe.invoice.paid with invoice_id after confirmed payment. Your app owns deduplication, ordering and billing truth.

Installation creates missing compatible definitions, not values or a producer. Existing property types and declared event-field types must be compatible; conflicts return 409 rather than silent rewrites.

## Trigger and re-entry

Trigger: `{"type":"event","event_name":"stripe.invoice.payment_failed"}`. Re-entry: `every_time`. Every matching event can start another run; callers must deduplicate unwanted repeats. Enabling does not replay old events or enroll existing contacts.

## Ordered graph and freshness

| Key | Step/config | Next path |
|:---|:---|:---|
| `trigger` | `trigger`: `{"type":"event","event_name":"stripe.invoice.payment_failed"}` | default → `freshness` |
| `freshness` | `filter`: `{"rule":{"type":"rule","field":"event.received_at","operator":"within","value":"10 days"},"scope":"following"}` | default → `failed` |
| `failed` | `send_email`: `{"template":"payment-failed","kind":"transactional"}` | default → `first_wait` |
| `first_wait` | `wait_for_event`: `{"event_name":"stripe.invoice.paid","timeout":"3 days"}` | event_received → `exit`; timeout → `reminder` |
| `reminder` | `send_email`: `{"template":"card-update-reminder","kind":"transactional"}` | default → `second_wait` |
| `second_wait` | `wait_for_event`: `{"event_name":"stripe.invoice.paid","timeout":"4 days"}` | event_received → `exit`; timeout → `canceled` |
| `canceled` | `send_email`: `{"template":"subscription-canceled","kind":"transactional"}` | default → `exit` |
| `exit` | `exit`: `{}` | End |

Both paid-event waits match contact/email and event name, not invoice_id. A paid event for another invoice can end the run; including invoice_id adds no automatic correlation. These waits consume later events, not historical invoice state. Prevent overlapping invoice runs or adapt a reviewed flow. The preset does not cancel a subscription. Billing must actually cancel before the final subscription-canceled notice; this graph has no cancellation-state guard. Do not enable unchanged if your billing policy cannot guarantee that timing.

Freshness uses scope following: it rechecks before every later step, including resumed delays/event waits after a pause. It uses recorded time, not a payload timestamp. Stale guards exit with `exit_reason: "filter"`; resume does not reset clocks. Contact rules use current stored values, not property-definition fallbacks. Already queued emails are not cancelled.

## Install, review, enable

Choose a sender on a live, verified, sending-enabled tenant domain; display names are accepted. Installation binds from on every send step without altering template senders. Verification at installation is not a permanent sending guarantee. Use a full-access key and write permission; Viewers can inspect, not install or enable.

All sends are Transactional: no topic is required or attached to these steps.

```sh
dispatch automations create --preset failed-payment --from 'Acme <hello@acme.com>'
# Optional: --name 'Your distinct automation name'
dispatch automations get auto_123
```

After review, enable explicitly (replace auto_123 with the returned automation.id):

```sh
dispatch automations update auto_123 --status enabled
```

Authenticated `POST /template-library/automations/failed-payment/install` accepts `{"from":"Acme <hello@acme.com>"}`. HTTP 200 returns `{automation, templates: {created, reused}, events, properties, next_steps}` and existing request_id metadata. Empty arrays are present; events/properties list newly created definitions only. Automation status is always disabled. Reinstall with another name: a live name conflict returns 409, not silent idempotency.

### TypeScript

```ts
import { Dispatch, type Result } from "@dispatchmail/sdk";

function value<T>(result: Result<T>): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
const dispatch = new Dispatch({ apiKey: process.env.DISPATCH_API_KEY, baseUrl: process.env.DISPATCH_API_URL });
const installed = value(await dispatch.templates.library.installAutomation("failed-payment", { from: "Acme <hello@acme.com>" }));
const id = installed.automation.id;
value(await dispatch.automations.get(id));
for (const template of [...installed.templates.created, ...installed.templates.reused]) {
  value(await dispatch.templates.get(template.id));
}
// STOP: inspect next_steps, graph, content, variables, links, brand and publication.
```

After reviewing the graph and every email, enable in a separate approved operation:

```ts
value(await dispatch.automations.update(id, { status: "enabled" }));
```

Missing library copies are installed published. Reused edited or draft copies are never overwritten, repaired or auto-published. Inspect the published version; render a draft with real variables using `dispatch.templates.render(templateId, variables, { draft: true })` and check its error. Publish only an explicitly approved draft with `dispatch.templates.publish(templateId)`. Review [Brand](../templates.md#brand), consent, sender, topics and business timing before the separate enable call. Server next_steps are guidance, not assurance that arbitrary caller data or edited copies are ready.

## App calls

These real SDK functions use the value error-checking helper in [offline examples](../../examples/lifecycle/recipes.ts). Importing makes no requests. Invoking changes data and can trigger email after enabling.

```ts
export type Invoice = { amount: string; updatePaymentUrl: string; number: string; id: string };

export async function paymentFailed(dispatch: Dispatch, email: string, invoice: Invoice) {
  // Actual billing values, never library preview samples.
  return value(await dispatch.events.send({ event: "stripe.invoice.payment_failed", email,
    payload: { AMOUNT: invoice.amount, UPDATE_PAYMENT_URL: invoice.updatePaymentUrl,
      INVOICE_NUMBER: invoice.number, invoice_id: invoice.id } }));
}

export async function invoicePaid(dispatch: Dispatch, email: string, invoiceId: string) {
  return value(await dispatch.events.send({ event: "stripe.invoice.paid", email,
    payload: { invoice_id: invoiceId } }));
}
```

The schema type-checks supplied keys but does not require every declared key. Preview samples are not production fallbacks; missing printed payment data can fail rendering. Validate real values in your producer. Today these are manual app-owned event calls, not an automatically connected Stripe integration. Future authenticated receiver setup must verify Stripe signatures, deduplicate provider events and map billing truth before forwarding; the preset installs no receiver. See [billing integration](../templates/stripe.md) and [Python/Go examples](../../examples/lifecycle/README.md).

Inspect `dispatch.automations.runs.list(id)` and `dispatch.automations.runs.get(id, runId)` for outputs and filter exits; queued does not mean delivered.

## Ask your agent

```text
Help me review Dispatch lifecycle presets and draft a disabled automation using the shipped API. Use the public documentation for my running Dispatch version and only shipped endpoints and SDK methods. Read DISPATCH_API_URL and DISPATCH_API_KEY from my environment; never print or embed the key. Respect my current permissions and ask for confirmation before sending email, publishing, deleting, or changing live configuration.
```
