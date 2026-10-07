# Invite to upgrade

## Goal

Invite a free account at its usage limit to upgrade, then recheck before reminding.

## App-owned state and events

Your app owns `plan` (string): initialize from account truth and update on every plan change. Fire usage.limit_reached once per intended notification, after persisting actual plan. Its declared payload schema is empty. Payloads do not update properties.

Installation creates missing compatible definitions, not values or a producer. Existing property types and declared event-field types must be compatible; conflicts return 409 rather than silent rewrites.

## Trigger and re-entry

Trigger: `{"type":"event","event_name":"usage.limit_reached"}`. Re-entry: `every_time`. Every matching event can start another run; callers must deduplicate unwanted repeats. Enabling does not replay old events or enroll existing contacts.

## Ordered graph and freshness

| Key | Step/config | Next path |
|:---|:---|:---|
| `trigger` | `trigger`: `{"type":"event","event_name":"usage.limit_reached"}` | default → `freshness` |
| `freshness` | `filter`: `{"rule":{"type":"rule","field":"event.received_at","operator":"within","value":"10 days"},"scope":"following"}` | default → `free_plan` |
| `free_plan` | `filter`: `{"rule":{"type":"rule","field":"contact.plan","operator":"eq","value":"free"},"scope":"next"}` | default → `invite` |
| `invite` | `send_email`: `{"template":"upgrade-invite","kind":"marketing"}` | default → `wait` |
| `wait` | `delay`: `{"duration":"4 days"}` | default → `still_free` |
| `still_free` | `filter`: `{"rule":{"type":"rule","field":"contact.plan","operator":"eq","value":"free"},"scope":"next"}` | default → `reminder` |
| `reminder` | `send_email`: `{"template":"upgrade-invite","kind":"marketing","subject":"Still need more room in {{{PRODUCT_NAME}}}?"}` | default → `exit` |
| `exit` | `exit`: `{}` | End |

Both free-plan filters require exact string free, before the invite and after four days. Paid or missing plans fail. The reminder reuses upgrade-invite with subject `Still need more room in {{{PRODUCT_NAME}}}?`.

Freshness uses scope following: it rechecks before every later step, including resumed delays/event waits after a pause. It uses recorded time, not a payload timestamp. Stale guards exit with `exit_reason: "filter"`; resume does not reset clocks. Contact rules use current stored values, not property-definition fallbacks. Already queued emails are not cancelled.

## Install, review, enable

Choose a sender on a live, verified, sending-enabled tenant domain; display names are accepted. Installation binds from on every send step without altering template senders. Verification at installation is not a permanent sending guarantee. Use a full-access key and write permission; Viewers can inspect, not install or enable.

Topic is optional at install, but every Marketing step needs a live topic before enable. Topicless installation stays disabled with `Choose a topic for marketing steps`; enable returns 422. The selected topic binds only Marketing steps, never Transactional steps.

```sh
dispatch automations create --preset invite-to-upgrade --from 'Acme <hello@acme.com>' --topic topic_123
# Optional: --name 'Your distinct automation name'
dispatch automations get auto_123
```

After review, enable explicitly (replace auto_123 with the returned automation.id):

```sh
dispatch automations update auto_123 --status enabled
```

Authenticated `POST /template-library/automations/invite-to-upgrade/install` accepts `{"from":"Acme <hello@acme.com>","topic_id":"topic_123"}`. HTTP 200 returns `{automation, templates: {created, reused}, events, properties, next_steps}` and existing request_id metadata. Empty arrays are present; events/properties list newly created definitions only. Automation status is always disabled. Reinstall with another name: a live name conflict returns 409, not silent idempotency.

### TypeScript

```ts
import { Dispatch, type Result } from "@dispatchmail/sdk";

function value<T>(result: Result<T>): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
const dispatch = new Dispatch({ apiKey: process.env.DISPATCH_API_KEY, baseUrl: process.env.DISPATCH_API_URL });
const installed = value(await dispatch.templates.library.installAutomation("invite-to-upgrade", { from: "Acme <hello@acme.com>", topicId: "topic_123" }));
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
export async function reachLimit(dispatch: Dispatch, email: string) {
  // Actual free account state first; payloads do not update contact.plan.
  value(await dispatch.contacts.update({ email, properties: { plan: "free" } }));
  return value(await dispatch.events.send({ event: "usage.limit_reached", email, payload: {} }));
}

export async function upgrade(dispatch: Dispatch, email: string) {
  return value(await dispatch.contacts.update({ email, properties: { plan: "pro" } }));
}
```

Updates assume a live existing contact and preserve consent. Create actual new signups with `dispatch.contacts.create({ email, firstName: "Ada", properties: yourActualState })`; do not revive deleted contacts to force a campaign.

Inspect `dispatch.automations.runs.list(id)` and `dispatch.automations.runs.get(id, runId)` for outputs and filter exits; queued does not mean delivered.

## Ask your agent

```text
Help me review Dispatch lifecycle presets and draft a disabled automation using the shipped API. Use the public documentation for my running Dispatch version and only shipped endpoints and SDK methods. Read DISPATCH_API_URL and DISPATCH_API_KEY from my environment; never print or embed the key. Respect my current permissions and ask for confirmation before sending email, publishing, deleting, or changing live configuration.
```
