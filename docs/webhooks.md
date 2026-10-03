# Webhooks

The worker delivers webhooks after an event is written. API handlers never call your URL themselves, so a slow endpoint cannot slow down a send.

## Endpoints

`POST /webhooks` takes `endpoint` (or the older `url`) and `events`, a list of event types or `"all"`. `events` defaults to `email.sent` and `email.delivered`. In production the URL must be https. A host that resolves to a private, loopback, or link-local address is refused unless `ALLOW_PRIVATE_WEBHOOKS=true`, which is the default outside production.

Create, `GET /webhooks/{id}`, `PATCH /webhooks/{id}`, and rotate return `signing_secret`, a `whsec_` secret. It is stored encrypted with `APP_SECRET`. Lists leave it out.

`POST /webhooks/test` queues a test `email.sent` event to every enabled endpoint subscribed to `email.sent`. Locally, `dispatch webhooks listen` receives events on port 4318 and can forward them to your app with `--forward-to`.

## Event types

`email.scheduled`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.opened`, `email.clicked`, `email.suppressed`, `email.received`, `email.unsubscribed`, `automation.run.started`, `automation.run.completed`, `automation.run.failed`, `contact.created`, `contact.updated`, `contact.deleted`, `contact.topics.updated`, `domain.created`, `domain.updated`, `domain.deleted`, `suppression.added`, `suppression.removed`, `topic.created`, `topic.updated`, `topic.deleted`.

An unsubscribe link records one `email.unsubscribed` event per email, even when used again. Automation events carry `automation_id`, `run_id`, `contact_id` (nullable), and `state`. Started means the run was enrolled and queued. Completed covers `done` and `stopped`; failed has state `failed`. Delays and resumed waits do not emit another start. Each transition and its webhook attempts commit with the run's state change.

`all` expands to the supported types when an endpoint is created or updated. Update an existing endpoint's events to `["all"]` to include types added since it was configured.

## Payload

```json
{
  "id": "event_...",
  "request_id": "req_...",
  "type": "email.delivered",
  "email_id": "email_...",
  "data": {
    "email_id": "email_...",
    "created_at": "2026-10-01T12:00:00.000Z",
    "from": "Acme <hello@example.com>",
    "to": ["you@example.net"],
    "subject": "Hello",
    "message_id": "<...>",
    "tags": { "plan": "pro" }
  },
  "created_at": "2026-10-01T12:00:03.000Z"
}
```

For email events, `data` has `email_id`, `created_at` (when the email was created), `from`, `to`, `subject`, `message_id`, and `tags`, plus `broadcast_id` and `template_id` when they apply. Bounce, click, failure, and suppression events add a `bounce`, `click`, `failed`, or `suppressed` object. Bounce and suppression events also carry `email`, the one address the event is about, since `to` can hold several. `bounce.type` is `Permanent`, `Temporary`, or `Undetermined`. `Temporary` is what SES calls `Transient`: the payload uses Resend's word, and `GET /emails/{id}/events` and the metrics use SES's. Other events carry the event's own data, such as `{ "id": "contact_...", "email": "..." }` for contact events. The top-level `created_at` is when the event was recorded. `id` is the same across retries and replays, so use it to drop duplicates.

## Signatures

Dispatch signs with [Standard Webhooks](https://www.standardwebhooks.com), the scheme Svix and Resend use. Each delivery carries three header sets:

- `svix-id`, `svix-timestamp`, `svix-signature`
- `webhook-id`, `webhook-timestamp`, `webhook-signature`, with the same values. The `standardwebhooks` libraries read these names.
- `dispatch-webhook-id`, `dispatch-webhook-timestamp`, `dispatch-webhook-signature`, the old Dispatch scheme. They stay for one release so receivers written against it keep working, then go away.

The signature is `v1,` followed by a base64 HMAC-SHA256. The key is the secret with `whsec_` removed, base64-decoded. The signed content is `<id>.<timestamp>.<raw body>`. Reject a timestamp more than five minutes from now. Verify against the raw request body, before any JSON parsing.

### With `standardwebhooks`

```ts
import { Webhook } from "standardwebhooks";

const webhook = new Webhook(process.env.DISPATCH_WEBHOOK_SECRET!); // whsec_...

export async function POST(request: Request) {
  const body = await request.text();
  const event = webhook.verify(body, {
    "webhook-id": request.headers.get("webhook-id")!,
    "webhook-timestamp": request.headers.get("webhook-timestamp")!,
    "webhook-signature": request.headers.get("webhook-signature")!,
  });
  // event is the parsed payload. verify() throws on a bad signature or an old timestamp.
  return new Response(null, { status: 204 });
}
```

### With the Dispatch SDK

`verifyWebhook` checks the signature and the five-minute window, then returns the parsed payload. It throws `WebhookVerificationError` otherwise. It makes no network call and needs no API key, so a receiver only has to hold the webhook secret. `dispatch.webhooks.verify` on a client is the same function.

```ts
import { verifyWebhook, WebhookVerificationError } from "@dispatchmail/sdk";

export async function POST(request: Request) {
  const payload = await request.text();
  try {
    const event = verifyWebhook({
      payload,
      headers: {
        id: request.headers.get("svix-id")!,
        timestamp: request.headers.get("svix-timestamp")!,
        signature: request.headers.get("svix-signature")!,
      },
      webhookSecret: process.env.DISPATCH_WEBHOOK_SECRET!,
    });
    console.log(event);
  } catch (error) {
    if (error instanceof WebhookVerificationError) return new Response(null, { status: 400 });
    throw error;
  }
  return new Response(null, { status: 204 });
}
```

### Rotating the secret

`POST /webhooks/{id}/signing-secret/rotate` returns a new secret. For the next 24 hours the previous secret stays valid, and `svix-signature` and `webhook-signature` hold two space-separated signatures, one per secret. Deploy the new secret to your receiver within that window.

An endpoint created by a build from before secrets were encrypted holds a legacy secret that is not a Standard Webhooks secret, and the `standardwebhooks` libraries cannot verify with it. Rotate it once to get a `whsec_` secret.

## Retries

A delivery succeeds on any 2xx response within 5 seconds. Dispatch does not follow redirects. A failed delivery is retried on the schedule in `webhookSchedule` in `packages/core`, measured from the previous failure: 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours, and 10 hours. With the first try that makes eight attempts over about 27 hours. `WEBHOOK_MAX_ATTEMPTS` lowers the count. A value above 8 has no effect, because the schedule has eight entries.

Before every attempt the worker resolves the endpoint's host again and refuses a private address, unless `ALLOW_PRIVATE_WEBHOOKS` is on. A DNS record that changed after the endpoint was saved cannot redirect deliveries into your network.

`POST /webhooks/{id}/events/{event_id}/replay` queues one extra delivery of an event. If it fails, it is not retried, and it does not restart the event's schedule. Replay needs the endpoint to be enabled and subscribed to the event type.

`GET /webhooks/{id}/events` lists events sent to an endpoint with the newest attempt's status (`pending`, `attempting`, `success`, or `failed`). `GET /webhooks/{id}/events/{event_id}` adds the payload and the time of the next queued retry. `GET /webhooks/{id}/events/{event_id}/attempts` lists every attempt with its HTTP status and the first 1,000 characters of the response.

## Disabled endpoints

One event running out of attempts does not turn an endpoint off. An endpoint that has been failing for five days is disabled, and its status becomes `disabled`. The five days restart when a failure comes more than 27 hours after the previous check, so an old failure plus a new one does not count as five days of failing.

A disabled endpoint receives nothing. Its waiting retries are marked failed with `Endpoint is disabled` instead of firing later. Setting `status` back to `enabled` with `PATCH /webhooks/{id}` clears its health record, so the next failure starts a fresh five days.
