# Migration

## From Resend

Dispatch serves Resend's routes with Resend's request and response bodies, so most code moves by changing two values: the base URL and the key.

```sh
# before
curl https://api.resend.com/emails -H "Authorization: Bearer re_..." ...
# after
curl https://api.mail.example.com/emails -H "Authorization: Bearer sk_..." ...
```

With the TypeScript SDK, swap the client. The Dispatch constructor takes an options object, not a bare key string, and falls back to `DISPATCH_API_KEY` and `DISPATCH_BASE_URL`. `DISPATCH_API_URL`, the name the CLI reads, works too, and the CLI accepts either name:

```ts
import { Dispatch } from "@dispatchmail/sdk";

const dispatch = new Dispatch({ apiKey: process.env.DISPATCH_API_KEY, baseUrl: "https://api.mail.example.com" });

const { data, error } = await dispatch.emails.send({
  from: "Acme <hello@example.com>",
  to: "you@example.net",
  subject: "Hello",
  html: "<p>It works.</p>",
});
```

Every method returns `{ data, error, headers }` and does not throw, as Resend's does. Inputs are camelCase where Resend's SDK uses camelCase (`replyTo`, `scheduledAt`, `idempotencyKey`), and `react` renders a React Email component when `@react-email/render` is installed.

These calls have the same names and arguments in both SDKs:

- `emails.send` (alias `create`), `emails.get`, `emails.list`, `emails.update`, `emails.cancel`, `emails.attachments.list` and `get`, `emails.receiving.list` and `get`
- `batch.send` (alias `create`), with `idempotencyKey` and `batchValidation`
- `domains.create`, `get`, `list`, `update`, `remove`, `verify`
- `apiKeys.create`, `list`, `remove`
- `webhooks.create`, `get`, `list`, `update`, `remove`, and `webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret })`
- `templates.create`, `get`, `list`, `update`, `remove`, `publish`, `duplicate`
- `contacts.create`, `get`, `list`, `update`, `remove`, plus `contacts.segments` and `contacts.topics`
- `contactProperties`, `segments`, and `topics`: `create`, `get`, `list`, `update`, `remove`
- `broadcasts.create`, `send`, `get`, `list`, `update`, `remove`
- `logs.list`, `logs.get`

Methods the Dispatch SDK adds, such as `emails.retry` and `domains.doctor`, have no Resend counterpart. Python and Go SDKs live in `packages/sdk-python` and `packages/sdk-go`.

Things to check when you move:

- Add and verify your sending domains in Dispatch. Sends from an unverified domain fail with `validation_error` (403). Dispatch creates domains in `us-east-1`, `eu-west-1`, `sa-east-1`, or `ap-northeast-1`.
- Create new API keys. Resend keys do not carry over. `permission` is `full_access` or `sending_access`, as in Resend.
- Webhook signatures use the same Standard Webhooks scheme and `svix-*` headers, so an existing verifier works with the new `whsec_` secret. See [webhooks.md](../webhooks.md).
- Broadcasts accept `audience_id` as another name for `segment_id`, and responses carry both.
- The SMTP relay accepts `resend` as the username, so an SMTP config only needs a new host and password. See [smtp.md](../smtp.md).
- Batch emails cannot have attachments.
- The default rate limit is 10 requests per second per tenant, set with `RATE_LIMIT_PER_SECOND`.

Dispatch adds routes Resend does not have, such as `POST /emails/{id}/retry`, `GET /emails/{id}/events`, `GET /domains/{id}/doctor`, `POST /webhooks/{id}/events/{event_id}/replay`, and `POST /emails/receiving/simulate`. The [API reference](../api/README.md) lists them.

## From the old `/v1` routes

Earlier Dispatch builds served every route under `/v1`. Those routes are gone and return 404.

- Drop the `/v1` prefix. `/v1/broadcasts` is now `/broadcasts`. The routes in the last two items of this list were also renamed, so dropping the prefix is not enough for them.
- Bodies are flat now. A single resource comes back as the object itself with an `object` field, a list as `{ object: "list", has_more, data }`, and a delete as `{ object, id, deleted: true }`.
- A few names changed with the move. `POST /v1/broadcasts/{id}/clone` is `POST /broadcasts/{id}/duplicate`. `/v1/automation-runs/{id}` is `/automations/{id}/runs/{run_id}`. Fired custom events moved from `/v1/events` to `/fired-events`, `/events` now holds event definitions, and `POST /events/send` fires an event.
- Received mail moved from `/v1/received-emails` to `/emails/receiving`, with its single-email and attachment routes under it, and `/v1/received-emails/simulate` is `POST /emails/receiving/simulate`. Webhook deliveries moved from `/v1/webhooks/{id}/attempts` and `/v1/webhooks/{id}/replay` to `/webhooks/{id}/events`, `/webhooks/{id}/events/{event_id}/attempts`, and `POST /webhooks/{id}/events/{event_id}/replay`.
