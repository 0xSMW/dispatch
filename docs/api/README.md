# API

Dispatch exposes a JSON REST API under `/v1`. The local contract is centered on durable acceptance: a successful send, batch, received email, webhook, broadcast, or automation mutation is committed before the API responds.

## Local Contract

- Auth uses `Authorization: Bearer <api-key>`.
- Session auth uses `POST /v1/sessions` to issue `sess_...` bearer tokens for local dashboard-style flows.
- Mutating requests return `request_id`.
- Send and batch endpoints accept `Idempotency-Key`.
- List endpoints return `{ object: "list", data, has_more }`.
- Errors return `{ name, statusCode, message, request_id }`.

The machine-readable local OpenAPI entrypoint is [openapi.json](openapi.json).

## Core Resources

- Emails: `POST /v1/emails`, `POST /v1/emails/batch`, `GET /v1/emails`, `GET /v1/emails/:id`, `PATCH /v1/emails/:id`, `POST /v1/emails/:id/cancel`, `POST /v1/emails/:id/retry`, `GET /v1/email-jobs`
- Domains: create, list, retrieve, update, verify, doctor, delete
- API keys: create, list, revoke
- Identity: users, roles, memberships, sessions, audit logs
- Templates: create, list, retrieve, update, publish versions, render, duplicate, delete
- Contacts, suppressions, topics, static segments
- Broadcasts: draft, send, pause, resume, cancel, clone, retrieve recipient snapshots
- Custom events and automations with update/delete, delay, wait resume, and stop
- Received emails: local simulation, retrieve body and attachments
- Webhooks: CRUD, signed attempts, replay, test event
- Logs, timeline, usage, and system health
