# Troubleshooting

Start with:

```sh
pnpm run doctor
```

It checks the CLI credentials, Docker, the Postgres, Redis, and Mailpit ports, and the API's health, setup, system, domains, emails, and webhooks routes. For more detail:

```sh
pnpm --filter @dispatchmail/cli start -- system
pnpm --filter @dispatchmail/cli start -- timeline
pnpm --filter @dispatchmail/cli start -- logs export
pnpm --filter @dispatchmail/cli start -- webhooks listen
```

`system` shows the send job backlog, webhook attempts, and automation runs by state. `timeline` shows recent emails, events, inbound mail, webhook attempts, automation runs, and API requests in one feed. Every response carries `request_id`. Search for it with `GET /logs?q=<request_id>`.

## Local stack

- Docker is not running, or `docker compose up -d` was not run.
- Postgres is not ready on `localhost:5432`, or Redis on `localhost:6379`.
- `pnpm db:migrate` has not run, so tables are missing.
- `pnpm db:seed` has not run, so there is no tenant or key.
- The worker is not running, so emails stay `queued` and webhooks never arrive. `pnpm dev` starts it, or run `pnpm dev:worker`.
- The API and the worker point at different `STORAGE_DIR` values, so attachments the API stored are missing for the worker. A relative path resolves against the workspace root, so leave it relative in both or give both the same absolute path.

## Sends

- `validation_error` with status 403 and `Sender domain is not verified` means the `from` domain is not verified for this tenant. Verify it with `POST /domains/{id}/verify`.
- `restricted_api_key` (401) means a sending-access key called a route other than the send routes.
- `rate_limit_exceeded` (429) means the tenant made more than `RATE_LIMIT_PER_SECOND` requests in one second. Wait for `retry-after`.
- An email stays `sent` and never reaches `delivered` with `SES_PROVIDER=ses` when the worker is not reading SES events. Check `SES_EVENTS_QUEUE_URL` and the configuration set's event destination. See [self-hosting](self-hosting/README.md#sending-with-ses).
- A recipient shows `suppressed` when the address bounced, complained, or was added by hand. `GET /suppressions/{email}` shows why, and `DELETE /suppressions/{email}` removes it.

## Production startup

- `APP_SECRET must be set to a private value of at least 16 characters in production`, or the same for `API_KEY_PEPPER`. Set both to long random values.
- `Fake provider is disabled in production`. Set `SES_PROVIDER=ses`, or `ALLOW_FAKE_PROVIDER=true` for a staging install that should not send.

## Webhooks

- If nothing arrives, check that the endpoint is `enabled` and subscribed to the event type, then look at `GET /webhooks/{id}/events` and the attempts for one event.
- `Webhook URL host is not allowed` means the host resolves to a private address. Set `ALLOW_PRIVATE_WEBHOOKS=true` if that is intended.
- If signatures fail with `standardwebhooks`, the endpoint may hold a legacy secret that is not `whsec_`. Rotate it once. See [webhooks.md](webhooks.md).

## Inbound mail

Received mail is dropped when no tenant matches. The domain must be verified, have receiving enabled, and be in `SES_INBOUND_REGION`. When two tenants qualify for the same domain, the message goes to neither.
