# API

Dispatch serves a JSON REST API on `PUBLIC_URL`, `http://localhost:3100` by default. Routes have no version prefix. The full reference is [openapi.json](openapi.json), an OpenAPI 3.1 document. `apps/api/src/openapi.test.ts` reads the route modules and fails when a route exists in the code but not in the document, or the other way round.

A write commits to Postgres before the API responds. A `200` from `POST /emails` means the email is stored and queued for the worker.

## Authentication

Send `Authorization: Bearer <token>`. The token is an API key (`sk_...`) or a session token (`sess_...`).

- A full-access key works on every route.
- A sending-access key works only on `POST /emails`, `POST /emails/batch`, `PATCH /emails/{id}`, `POST /emails/{id}/cancel`, `POST /emails/{id}/retry`, and `GET /me`, which tells a client what the key is. Anywhere else it gets `restricted_api_key` (401). The OpenAPI document marks these operations with `x-scope: send`.
- A sending-access key created with a `domain_id` can only send from that domain.
- API keys have no roles. A key has full access or sending access.

These routes need no token: `GET /health`, `GET /setup` (while `ALLOW_PUBLIC_SETUP` is on, the default outside production), `POST /sessions`, `GET /open/{token}.gif`, `GET /click/{token}`, `GET /files/{token}`, `GET /shared/{token}`, and `GET` and `POST /unsubscribe/{token}`.

### Sessions

`POST /sessions` takes `{ "email", "password" }` and returns a session token that lasts 30 days. A wrong password and an unknown email get the same 401 `invalid_credentials`, and so does a deactivated user or one with no membership. Each email gets 10 attempts in a 15 minute window that starts at the first one. A right password gives its attempt back, so only failures use them up. Once they are gone, the API refuses every attempt for that email with a 429 until the window ends. Nothing ends the window early, not a right password and not an admin's reset, because one email can belong to several tenants.

Passwords are 12 to 200 characters. The API stores only a scrypt hash with a random salt.

- An admin sets a user's first password with `POST /users { "email", "name", "password" }`, and resets a forgotten one with `PATCH /users/{id} { "password" }`.
- A signed-in user changes their own with `POST /me/password { "current_password", "password" }`.
- Any password change signs the user out everywhere except the session that made the change.
- There are no reset emails, no email verification, and no MFA.

For local development and tests, `POST /sessions` also takes `{ "email", "api_key" }` with a full-access key in place of the password. The API refuses that form unless `ALLOW_PASSWORDLESS_SESSIONS=true`, which is the default outside production and off in it.

### Roles

A session gets its access from the user's role. Every tenant has two:

- Admin, with `["full"]`, can call every route.
- Viewer, with `["read"]`, can call `GET` routes, plus `POST /me/password` and `DELETE /sessions/{id}` for its own sessions. Every other call gets `forbidden` (403). A viewer can check whether an email arrived and why it bounced, or how a broadcast did, and cannot change anything.

A viewer does not see anything that grants access on its own:

- `GET /webhooks` and `GET /webhooks/{id}` leave out `signing_secret` and show only the scheme and host of `endpoint`, since a webhook URL's path can hold a credential.
- `GET /emails/{id}` replaces unsubscribe, click, and open links in `html` and `text` with `#link-hidden`. They carry the recipient's token and work without a session.
- `GET /logs/{id}` shows `[redacted]` in place of every `url`, `download_url`, and `raw` field in the stored bodies, and hides token links in them the same way.
- Signed download links for attachments and raw messages last 5 minutes for a viewer, and 1 hour otherwise.
- `GET /me` reports a viewer's `scope` as `read`.

`POST /roles` creates a role, or brings back a deleted one of that name. It returns 409 for a live one, which is changed with `PATCH /roles/{id}`. A viewer never counts as the last member with full access, so the API still refuses to remove or demote the last admin.

A role with neither `full` nor `read` can call nothing.

## Response shapes

A single resource is a flat object whose `object` field names its type:

```json
{ "object": "domain", "id": "domain_...", "name": "example.com", "status": "verified", "request_id": "req_..." }
```

A list:

```json
{ "object": "list", "has_more": true, "data": [ ... ], "request_id": "req_..." }
```

A delete:

```json
{ "object": "webhook", "id": "webhook_...", "deleted": true, "request_id": "req_..." }
```

`DELETE /contacts/{id}` is the one exception. Like Resend, it returns the ID in `contact` instead of `id`.

Every JSON object response carries `request_id`, and every response sends it in the `x-request-id` header. A request can supply its own `x-request-id` of 1 to 128 letters, digits, `_`, `.`, `:`, or `-`.

## Pagination

Lists take `limit` (1 to 100, default 20), `after`, and `before`. `after` and `before` are item IDs, and a request can use one of them, not both. `has_more` says whether another page exists in that direction. `GET /contacts/imports` defaults to 10. `GET /webhooks/{id}/events` pages with `after` only.

## Errors

```json
{ "name": "not_found", "statusCode": 404, "message": "Domain not found", "request_id": "req_..." }
```

A body that fails validation also carries `path`, the dotted path to the first bad field, and `issues`, every problem with its path:

```json
{
  "name": "validation_error",
  "statusCode": 400,
  "message": "Invalid email",
  "path": "to",
  "issues": [{ "path": "to", "message": "Invalid email" }],
  "request_id": "req_..."
}
```

| Name | Status | When |
|:---|:---|:---|
| `validation_error` | 400, 403, 409, 413, 415, 422 | Bad input. 400 for a body that fails validation, bad paging, or bad JSON. 403 for a sender domain that is not verified or not allowed for the key. 409 when a unique value is already taken. 413 for a file or body over the limit. 415 for a content type the route does not read. 422 for input that is well formed but cannot be applied. |
| `missing_api_key` | 401 | No `Authorization: Bearer` header. |
| `restricted_api_key` | 401 | A sending-access key on a full-access route. |
| `invalid_session` | 401 | The session token is unknown, revoked, or expired. |
| `invalid_api_key` | 403 | The key is unknown or revoked. |
| `forbidden` | 403 | The session's role lacks `full`, or passwordless sessions are off. |
| `not_found` | 404 | The resource does not exist for this tenant. |
| `conflict` | 409 | The resource is in the wrong state, such as cancelling a sent email, editing an enabled automation, or removing the last member with full access. |
| `invalid_idempotency_key` | 400 | The `Idempotency-Key` header is longer than 256 characters. |
| `invalid_idempotent_request` | 409 | The key was used before with a different body. |
| `concurrent_idempotent_requests` | 409 | The first request with this key is still running. |
| `invalid_attachment` | 422 | An attachment is not base64, its `path` cannot be fetched, or attachments exceed 40 MB. |
| `invalid_storage_key` | 400 | A stored file key is malformed. |
| `rate_limit_exceeded` | 429 | Over the rate limit. |
| `application_error` | 500 | Anything unexpected. The message is always `Unexpected error`, and the details go to the API log. |

## Rate limits

Requests made with an API key share one bucket per tenant per second, across all keys and routes. The size is `RATE_LIMIT_PER_SECOND`, default 10. Requests made with a dashboard session count into a separate bucket per user, `SESSION_RATE_LIMIT_PER_SECOND`, default 40, so browsing the dashboard does not use up the limit an application sends with. Public routes are limited per client IP and route: `PUBLIC_RATE_LIMIT_PER_SECOND` (default 50), and `AUTH_RATE_LIMIT_PER_SECOND` (default 5) for `POST /sessions`.

Every response to an authenticated request carries `ratelimit-limit`, `ratelimit-remaining`, and `ratelimit-reset`. A request refused for a missing or invalid key has none, because it is refused before it is counted. A 429 also carries `retry-after`, in seconds.

## Sending

`POST /emails` and `POST /emails/batch` accept an `Idempotency-Key` header of 1 to 256 characters. A retry with the same key and body within 24 hours returns the first response without sending again.

`POST /emails/batch` takes up to 100 emails, as an array or as `{ "emails": [...] }`. Batch emails cannot have attachments. The `x-batch-validation` header picks the mode:

- `strict`, the default, rejects the whole batch when one email is invalid.
- `permissive` accepts the valid emails. `data` lists only the accepted ones, and `errors` lists the others as `{ index, message }`, where `index` is the position in the request.

`scheduled_at` takes ISO 8601 or a phrase such as `in 1 hour`, at most 30 days ahead. A time with no offset, such as `2026-10-03T09:00`, and a phrase such as `tomorrow at 9am` are read as UTC. Send an offset to mean another timezone. An email in `queued` or `scheduled` can be changed with `PATCH /emails/{id}` or cancelled with `POST /emails/{id}/cancel`.

## Broadcasts and automations

`POST /broadcasts/{id}/send` checks the broadcast before it changes state. It refuses an unverified or disabled sender domain, blocks that do not pair up, and content that needs a value no recipient would get, such as `{{{COMPANY_ADDRESS}}}` when the brand has no address. The check renders two sample contacts, one with every contact field the content names and one with none, so it also finds a variable inside `{{{#if contact.plan}}}` or `{{{#unless contact.first_name}}}`. A missing contact field is not refused. `{{{contact.first_name}}}` with no fallback prints as a blank for a contact with no first name, and the email still goes. The same holds for `FIRST_NAME`, `LAST_NAME`, and any `contact.*` property. A missing variable still fails a send through `POST /emails`. `GET /broadcasts/{id}/audience` returns `no_first_name` and `no_last_name`, the number of recipients who have no first or last name, and the dashboard's review step warns when the content prints a name with no fallback and outside an `#if` on that name. It also warns about a `contact.*` field that no property defines, which is blank for everyone and is usually a typo. `POST /broadcasts/{id}/render` returns the broadcast as a sample contact would get it.

An automation's `send_email` step sends to everyone by default, like `POST /emails`, so it suits receipts and password resets. Give the step a `topic_id` to make it subscription mail: a contact who unsubscribed from everything, or opted out of that topic, is then skipped and the run goes on. So is a deleted contact, recorded as `contact_deleted`. A step without a topic still emails a deleted contact's address, as `POST /emails` would. `from` may be left out when the template stores a sender. `POST /events/send` only stores the event. The worker runs the steps.

An event is often the first time Dispatch hears of a person, such as a signup. When `email` matches no contact, `POST /events/send` adds one before the runs start. It lowercases the address, subscribes the contact, takes the name from the payload's `first_name` and `last_name`, and sends `contact.created` to webhooks. A name is used when it is a string of 1 to 120 characters after trimming. A live contact with no name gets the event's name and sends `contact.updated`. A name it already has is never changed. The body keeps Resend's shape, and both name fields are optional. A deleted contact stays deleted, since the deletion may have been a privacy request. Its event is stored and its runs start. Steps that change the contact or add it to a segment skip it, and so does a `send_email` step with a topic. Two events for the same new address at once create one contact.

## Email metrics

`GET /emails/metrics` counts `email_events` for the tenant. With no dates it covers the 7 days before now. `end_date` is exclusive. `opened` counts every open event, and `unique_opened` counts distinct emails, so the two differ once one email is opened twice.

Rates are percentages rounded to two decimals. A zero denominator gives 0.

- `delivery_rate` is delivered / sent.
- `open_rate` is unique_opened / delivered.
- `click_rate` is unique_clicked / delivered.
- `bounce_rate` is bounced / sent.
- `complaint_rate` is complained / delivered.
- `unsubscribe_rate` is unsubscribed / delivered.

`unsubscribed` counts `email.unsubscribed` events, which are recorded when a recipient unsubscribes through a broadcast's link. `email` and `broadcast` cannot be dimensions together. `timezone` must be an IANA name.

## Sharing an email

`POST /emails/{id}/share` returns a dashboard URL under `APP_URL` for a sent or received email. It lasts 48 hours at most, set with `expires_in`. The dashboard reads `GET /shared/{token}`, which is public and returns the HTML the caller sent, not the tracked copy.

## Routes

The OpenAPI document has every parameter and field. By area:

- Emails: `POST /emails`, `POST /emails/batch`, `GET /emails`, `GET /emails/{id}`, `PATCH /emails/{id}`, `POST /emails/{id}/cancel`, `POST /emails/{id}/retry`, `GET /emails/{id}/attachments`, `GET /emails/{id}/attachments/{attachment_id}`, `GET /emails/{id}/events`, `GET /emails/{id}/insights`, `POST /emails/{id}/share`, `GET /email-jobs`, `GET /email-jobs/{id}`
- Metrics: `GET /emails/metrics`
- Receiving: `GET /emails/receiving`, `GET /emails/receiving/{id}`, `GET /emails/receiving/{id}/attachments`, `GET /emails/receiving/{id}/attachments/{attachment_id}`, `POST /emails/receiving/simulate`
- Domains: `POST /domains`, `GET /domains`, `GET /domains/{id}`, `PATCH /domains/{id}`, `DELETE /domains/{id}`, `POST /domains/{id}/verify`, `GET /domains/{id}/doctor`, `POST /domains/{id}/publish-route53`
- API keys: `POST /api-keys`, `GET /api-keys`, `GET /api-keys/{id}`, `PATCH /api-keys/{id}`, `DELETE /api-keys/{id}`
- Webhooks: `POST /webhooks`, `GET /webhooks`, `GET /webhooks/{id}`, `PATCH /webhooks/{id}`, `DELETE /webhooks/{id}`, `POST /webhooks/{id}/signing-secret/rotate`, `POST /webhooks/test`, `GET /webhooks/{id}/events`, `GET /webhooks/{id}/events/{event_id}`, `GET /webhooks/{id}/events/{event_id}/attempts`, `POST /webhooks/{id}/events/{event_id}/replay`. See [webhooks.md](../webhooks.md).
- Templates: `POST /templates`, `GET /templates`, `GET /templates/{id}`, `PATCH /templates/{id}`, `DELETE /templates/{id}`, `POST /templates/{id}/versions`, `GET /templates/{id}/versions`, `POST /templates/{id}/publish`, `POST /templates/{id}/render`, `POST /templates/{id}/duplicate`. `{id}` also accepts the alias.
- Template library: `GET /template-library`, `GET /template-library/{slug}`, `POST /template-library/{slug}/install`
- Brand: `GET /brand`, `PATCH /brand`
- Contacts: `POST /contacts`, `GET /contacts`, `GET /contacts/stats`, `GET /contacts/{id}`, `PATCH /contacts/{id}`, `DELETE /contacts/{id}`, `GET /contacts/{id}/activity`, `GET /contacts/{id}/segments`, `POST` and `DELETE /contacts/{id}/segments/{segment_id}`, `GET` and `PATCH /contacts/{id}/topics`. `{id}` also accepts the email address.
- Imports: `POST /contacts/imports` (multipart CSV), `GET /contacts/imports`, `GET /contacts/imports/{id}`
- Contact properties: `POST /contact-properties`, `GET /contact-properties`, `GET /contact-properties/{id}`, `PATCH /contact-properties/{id}`, `DELETE /contact-properties/{id}`
- Segments: `POST /segments`, `GET /segments`, `GET /segments/{id}`, `PATCH /segments/{id}`, `DELETE /segments/{id}`, `GET` and `POST /segments/{id}/contacts`, `DELETE /segments/{id}/contacts/{contact_id}`
- Topics: `POST /topics`, `GET /topics`, `GET /topics/{id}`, `PATCH /topics/{id}`, `DELETE /topics/{id}`, `GET` and `POST /topics/{id}/subscriptions`
- Suppressions: `POST /suppressions`, `GET /suppressions`, `GET /suppressions/{id}`, `DELETE /suppressions/{id}`, `POST /suppressions/batch/add`, `POST /suppressions/batch/remove`. `{id}` also accepts the email address.
- Broadcasts: `POST /broadcasts`, `GET /broadcasts`, `GET /broadcasts/{id}`, `PATCH /broadcasts/{id}`, `DELETE /broadcasts/{id}`, `POST /broadcasts/{id}/send`, `POST /broadcasts/{id}/cancel`, `POST /broadcasts/{id}/duplicate`, `POST /broadcasts/{id}/render`, `POST /broadcasts/{id}/pause`, `POST /broadcasts/{id}/resume`, `GET /broadcasts/{id}/audience`, `GET /broadcasts/{id}/recipients`, `GET /broadcasts/{id}/clicked-links`
- Automations: `POST /automations`, `GET /automations`, `GET /automations/{id}`, `PATCH /automations/{id}`, `DELETE /automations/{id}`, `POST /automations/{id}/duplicate`, `POST /automations/{id}/stop`, `GET /automations/{id}/runs`, `GET /automations/{id}/runs/metrics`, `GET /automations/{id}/runs/{run_id}`
- Events: `POST /events`, `GET /events`, `GET /events/{id}`, `PATCH /events/{id}`, `DELETE /events/{id}`, `POST /events/send`, `GET /fired-events`, `GET /fired-events/{id}`. `/events` holds event definitions, `POST /events/send` fires one, and `/fired-events` lists what fired.
- Logs: `GET /logs`, `GET /logs/{id}`, `GET /logs/export`, `GET /timeline`
- Platform: `GET /health`, `GET /setup`, `GET /me`, `POST /me/password`, `GET /system`, `GET /usage`, `GET /audit-logs`, `POST /links/check`, users (`GET`, `POST /users`, `PATCH`, `DELETE /users/{id}`), roles (`GET`, `POST /roles`, `PATCH`, `DELETE /roles/{id}`), memberships (`GET`, `POST /memberships`, `DELETE /memberships/{id}`), sessions (`POST`, `GET /sessions`, `DELETE /sessions/{id}`)
- Public links in sent mail: `GET /open/{token}.gif`, `GET /click/{token}`, `GET /files/{token}`, `GET /shared/{token}`, `GET` and `POST /unsubscribe/{token}`
