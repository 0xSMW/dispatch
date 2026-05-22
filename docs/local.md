# Local Development

The local stack is the proving ground for v1. It must complete a send without AWS:

1. Create or reuse a tenant.
2. Create an API key.
3. Add and verify a domain.
4. Accept an email request durably.
5. Accept a batch request durably with batch idempotency.
6. Process send jobs through the fake provider.
7. Append events.
8. Dispatch signed webhooks.
9. Render a published template into a send.
10. Block unsubscribed or manually suppressed recipients before queueing.
11. Store and retrieve sent attachments without putting bytes in Postgres.
12. Track local opens and clicks through event endpoints.
13. Simulate received email with retrievable bodies and attachments.
14. Snapshot topic and segment membership for a broadcast.
15. Trigger local automations from custom events.
16. Resume automation delay and wait steps.
17. Show the full timeline in the API, CLI, and dashboard.

## Commands

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The CLI aliases for the first two local operations are:

```sh
pnpm --filter @dispatch/cli start -- dev up
pnpm --filter @dispatch/cli start -- dev seed
```

In another shell:

```sh
pnpm run doctor
pnpm smoke
pnpm load -- --count 100 --concurrency 20
```

`pnpm run doctor` checks Docker, Postgres, Redis, Mailpit, the API, local system health, domains, emails, and webhooks. `pnpm --filter @dispatch/cli start -- timeline` shows the same end-to-end activity feed exposed in the dashboard Timeline view.

For the load check, start or restart the API with the higher local limit first:

```sh
RATE_LIMIT_PER_SECOND=200 pnpm dev:api
```

`pnpm smoke` is the executable local acceptance loop. It should print:

- `final delivered`
- `key lifecycle`
- `idempotency replay`
- `batch delivered`
- `template delivered`
- `automation run`
- `attachment stored`
- `contact suppressed`
- `manual suppression`
- `broadcast sent`
- `scheduled delivered`
- `tracking events`
- `received email stored`
- `webhook sent`
- `webhook retry queued`
- `ops visible`

## Local Services

- Postgres stores tenants, keys, domains, templates, contacts, topics, segments, broadcasts, automations, custom events, suppressions, emails, attachment metadata, received-email metadata, jobs, events, webhooks, and logs.
- Local disk storage under `.dispatch/storage` stores attachment bytes for the local provider path.
- Redis handles local rate limits.
- The fake provider simulates SES acceptance and recipient delivery.
- Mailpit is available for future SMTP-backed local provider tests.
- The API defaults to `http://localhost:3100` to avoid common app-server collisions on port 3000.
- `RATE_LIMIT_PER_SECOND` and `WORKER_CONCURRENCY` are local tuning knobs for throughput checks.
