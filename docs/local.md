# Local development

The local stack runs the whole product without AWS. The fake provider stands in for SES, attachments go to local disk, and the worker delivers webhooks and runs automations the same way it does in production.

## Start

### Dynamic audience migration

The append-only migration adds nullable `segments.rule`, the email
`(tenant_id, contact_id, created_at)` index, and the recipient
`(tenant_id, lower(email))` index. It does not backfill contact attribution.
Creating these indexes can lock writes for a while on a large installation.
Plan an upgrade window and monitor PostgreSQL before resuming normal traffic.
Schema replay is idempotent.

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Every process reads the `.env` at the repo root, whichever folder pnpm starts it in. A variable set in the shell wins over the file.

The CLI can stand in for `docker compose up -d`, `pnpm db:migrate`, and `pnpm db:seed`. `dev seed` runs the migration first:

```sh
pnpm --filter @dispatchmail/cli start -- dev up
pnpm --filter @dispatchmail/cli start -- dev seed
```

`pnpm dev` starts the API on port 3100, the worker, and the dashboard on port 5173. Each also has its own script: `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:dashboard`. The SMTP relay runs with `pnpm dev:smtp`.

`pnpm db:seed` creates:

- a tenant with the Admin role (`full`) and the Viewer role (`read`)
- the Admin user `operator@example.test`, whose password is `DISPATCH_PASSWORD` from `.env`, or `dispatch-local-password` when that is unset. The seed prints the development password.
- a full-access key whose secret is `DISPATCH_API_KEY` from `.env`
- `example.com`, marked verified, with open and click tracking on
- a webhook to `WEBHOOK_URL` (default `http://localhost:8787/webhooks`) for sent, delivered, bounced, complained, and failed events. See [webhooks.md](webhooks.md).
- the library templates, published

Sign in to the dashboard at http://localhost:5173 as `operator@example.test` with that password. Running the seed again keeps the password the user has. To start over, set a new one from the dashboard's account menu.

## Services

- Postgres holds every record: tenants, keys, domains, templates, contacts, emails, events, jobs, webhooks, and logs.
- Redis holds the rate limit counters.
- Attachment bytes, received mail, and import files live under `STORAGE_DIR`, `.dispatch/storage` by default. A relative path resolves against the workspace root, so the API and the worker read the same directory even though `pnpm dev` starts each one in its own folder.
- Mailpit runs from `docker-compose.yml` on ports 1025 and 8025. The fake provider does not deliver to it. `dispatch doctor` checks that its port is open.

## The fake provider

With `SES_PROVIDER=fake`, the default, the worker records `email.sent` and then `email.delivered` for each email. Each recipient's own address can pick another outcome for that recipient:

- an address containing `bounce` gets a permanent bounce, which also suppresses it
- an address containing `complaint` gets a complaint, which also suppresses it
- an address containing `delay` gets `email.delivery_delayed` before `email.delivered`

`FAKE_PROVIDER_TERMINAL_DELAY_MS` and `FAKE_PROVIDER_DELAYED_DELAY_MS` hold those events back, both default 0. Domains verify at once with `POST /domains/{id}/verify`.

Received mail has no SES path locally. Post it to `POST /emails/receiving/simulate` instead.

## Checks

`pnpm test` runs every vitest file. None of them needs a running service: the database, Redis, and AWS are mocked. Run single files with `pnpm vitest run path/to/file.test.ts`.

With the stack up, in another shell:

```sh
pnpm run doctor
pnpm load -- --count 100 --concurrency 20
```

`pnpm run doctor` runs `dispatch doctor`, which checks the CLI credentials, Docker, the Postgres, Redis, and Mailpit ports, and the API's health, setup, system, domains, emails, and webhooks routes. `pnpm --filter @dispatchmail/cli start -- timeline` prints emails, events, inbound mail, webhook attempts, automation runs, and API logs in one feed.

`pnpm load` sends through the API and counts on the per-tenant rate limit, 10 requests a second by default. Restart the API with a higher limit first:

```sh
RATE_LIMIT_PER_SECOND=200 pnpm dev:api
```

## Settings worth knowing locally

- `PORT` sets the API port, default 3100. `API_HOST` sets the bind address, default `127.0.0.1` outside production.
- `APP_SECRET` and `API_KEY_PEPPER` fall back to fixed development values outside production. Production refuses to start with them.
- `ALLOW_PUBLIC_SETUP`, `ALLOW_PASSWORDLESS_SESSIONS`, and `ALLOW_PRIVATE_WEBHOOKS` default to `true` outside production and `false` in it.
- `WORKER_CONCURRENCY` (default 5) and `WORKER_INTERVAL_MS` (default 250) tune the worker loop.

The full list is in [operations](operations/README.md#environment).
