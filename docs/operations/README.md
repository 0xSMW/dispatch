# Operations

Local operations are intentionally inspectable without a cloud account.

## Checks

```sh
pnpm run doctor
pnpm smoke
pnpm load -- --count 100 --concurrency 20
```

## Runtime

- API accepts requests, logs every request, writes durable rows, and queues jobs.
- Identity mutations write audit rows separate from request logs.
- Worker processes sends, automation resumes, and webhook attempts.
- Dashboard shows setup, identity, domains, keys, send/batch, emails, templates, audience, broadcasts, automations/events, inbound, webhooks, and logs.
- CLI exposes the same operational paths for terminal use.

## Common Knobs

- `RATE_LIMIT_PER_SECOND`
- `WORKER_CONCURRENCY`
- `WORKER_INTERVAL_MS`
- `WEBHOOK_MAX_ATTEMPTS`
- `STORAGE_DIR`
