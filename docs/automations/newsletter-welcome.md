# Newsletter welcome

## Goal

Welcome a subscriber and recommend tips or setup based on current activation.

## App-owned state and events

Your app owns `activated` (boolean): initialize false before subscribing; set true when setup completes. No custom event is required. Change topic preferences only with consent.

Installation creates missing compatible definitions, not values or a producer. Existing property types and declared event-field types must be compatible; conflicts return 409 rather than silent rewrites.

## Trigger and re-entry

Trigger: `{"type":"topic_subscribed","topic_id":"{{topic_id}}"}`. Installation binds the placeholder to the selected live topic. Re-entry: `once`. Lifetime once per identified contact, including after completion or failure. Enabling does not replay old events or enroll existing contacts.

## Ordered graph and freshness

| Key | Step/config | Next path |
|:---|:---|:---|
| `trigger` | `trigger`: `{"type":"topic_subscribed","topic_id":"{{topic_id}}"}` | default → `freshness` |
| `freshness` | `filter`: `{"rule":{"type":"rule","field":"event.received_at","operator":"within","value":"7 days"},"scope":"following"}` | default → `welcome` |
| `welcome` | `send_email`: `{"template":"newsletter-welcome","kind":"marketing"}` | default → `wait` |
| `wait` | `delay`: `{"duration":"3 days"}` | default → `activation` |
| `activation` | `condition`: `{"type":"rule","field":"contact.activated","operator":"eq","value":true}` | condition_met → `tips`; condition_not_met → `setup` |
| `tips` | `send_email`: `{"template":"feature-tips","kind":"marketing"}` | default → `exit` |
| `setup` | `send_email`: `{"template":"setup-reminder","kind":"marketing"}` | default → `exit` |
| `exit` | `exit`: `{}` | End |

The binary Condition tests contact.activated eq true: met → tips; not met → setup. Missing activation takes setup. It is not a one-path Branch; Branch still requires 2–10 ordered paths plus Otherwise.

Freshness uses scope following: it rechecks before every later step, including resumed delays/event waits after a pause. It uses recorded time, not a payload timestamp. Stale guards exit with `exit_reason: "filter"`; resume does not reset clocks. Contact rules use current stored values, not property-definition fallbacks. Already queued emails are not cancelled.

## Install, review, enable

Choose a sender on a live, verified, sending-enabled tenant domain; display names are accepted. Installation binds from on every send step without altering template senders. Verification at installation is not a permanent sending guarantee. Use a full-access key and write permission; Viewers can inspect, not install or enable.

A live same-tenant topic is required at install: omission returns 422 validation_error, `Choose a topic`, with no installation. It binds the subscription trigger and every Marketing send.

```sh
dispatch automations create --preset newsletter-welcome --from 'Acme <hello@acme.com>' --topic topic_123
# Optional: --name 'Your distinct automation name'
dispatch automations get auto_123
```

After review, enable explicitly (replace auto_123 with the returned automation.id):

```sh
dispatch automations update auto_123 --status enabled
```

Authenticated `POST /template-library/automations/newsletter-welcome/install` accepts `{"from":"Acme <hello@acme.com>","topic_id":"topic_123"}`. HTTP 200 returns `{automation, templates: {created, reused}, events, properties, next_steps}` and existing request_id metadata. Empty arrays are present; events/properties list newly created definitions only. Automation status is always disabled. Reinstall with another name: a live name conflict returns 409, not silent idempotency.

### TypeScript

```ts
import { Dispatch, type Result } from "@dispatchmail/sdk";

function value<T>(result: Result<T>): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
const dispatch = new Dispatch({ apiKey: process.env.DISPATCH_API_KEY, baseUrl: process.env.DISPATCH_API_URL });
const installed = value(await dispatch.templates.library.installAutomation("newsletter-welcome", { from: "Acme <hello@acme.com>", topicId: "topic_123" }));
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
export async function subscribeNewsletter(dispatch: Dispatch, email: string, topicId: string) {
  // Opt_out-default topic; consented new subscriber, not an existing user's reset.
  value(await dispatch.contacts.create({ email, firstName: "Ada", properties: { activated: false },
    topics: [{ id: topicId, subscription: "opt_out" }] }));
  return value(await dispatch.contacts.topics.update({ email,
    topics: [{ id: topicId, subscription: "opt_in" }] }));
}

export async function activate(dispatch: Dispatch, email: string) {
  return value(await dispatch.contacts.update({ email, properties: { activated: true } }));
}
```

Inspect `dispatch.automations.runs.list(id)` and `dispatch.automations.runs.get(id, runId)` for outputs and filter exits; queued does not mean delivered.

## Ask your agent

```text
Help me review Dispatch lifecycle presets and draft a disabled automation using the shipped API. Use the public documentation for my running Dispatch version and only shipped endpoints and SDK methods. Read DISPATCH_API_URL and DISPATCH_API_KEY from my environment; never print or embed the key. Respect my current permissions and ask for confirmation before sending email, publishing, deleting, or changing live configuration.
```
