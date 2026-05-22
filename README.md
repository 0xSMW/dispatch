# Dispatch

Dispatch is a local-first, AWS-native email API and control plane. The local v1 runs with Postgres, Redis, a fake SES-compatible provider, a worker, CLI, and dashboard before any AWS deployment.

## Local Start

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The CLI aliases are available too:

```sh
pnpm --filter @dispatch/cli start -- dev up
pnpm --filter @dispatch/cli start -- dev seed
```

Then open:

- API: http://localhost:3100/health
- Dashboard: http://localhost:5173
- Mailpit: http://localhost:8025

Run the smoke check:

```sh
pnpm smoke
```

Run a local acceptance load check:

```sh
RATE_LIMIT_PER_SECOND=200 pnpm dev:api
pnpm load -- --count 100 --concurrency 20
```

The rate-limit env var must be set on the API process, not only on the load client.

The local path uses fake delivery, durable Postgres state, local attachment storage, queued worker jobs, append-only events, batch acceptance, open/click tracking, signed webhooks, API logs, idempotency, Redis rate limits, published templates, contacts, topics, static segments, broadcasts, custom events, automation delays and waits, received-email simulation, and manual suppressions.

The current local acceptance path is:

```sh
pnpm run doctor
pnpm smoke
pnpm load -- --count 100 --concurrency 20
```

`pnpm smoke` proves API-key create/revoke, the first-send loop plus idempotency replay/conflict, batch send replay, template rendering and send, automation-triggered sends, automation delay and wait resume, sent and received attachments, tracking events, received-email simulation, contact unsubscribe blocking, manual suppression blocking, topic/segment broadcast delivery, scheduled delivery, signed webhook delivery, and webhook retry queueing.

For local inspection:

```sh
pnpm --filter @dispatch/cli start -- timeline
pnpm --filter @dispatch/cli start -- system
pnpm --filter @dispatch/cli start -- listen --port 8787
```

## SDKs And Examples

- TypeScript SDK: `packages/sdk`
- Python SDK: `packages/sdk-python`
- Go SDK: `packages/sdk-go`
- Examples: `examples/python` and `examples/go`
- API docs: `docs/api`
