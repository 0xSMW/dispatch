# Operations

## Processes

- The API (`apps/api`) authenticates requests, writes rows, queues jobs, and logs every request. Logs, audit rows, and usage counters are buffered and written in batches every `TELEMETRY_FLUSH_MS` (100 ms).
- The worker (`apps/worker`) claims send jobs, delivers webhooks, runs every automation step, sends broadcasts in chunks, runs contact imports, and deletes logs older than `LOG_RETENTION_DAYS` once a minute. `POST /events/send` only stores the event. The worker starts the runs it triggers, so with no worker running, automations do not move. A broadcast gets its next chunk of 200 only while fewer than 400 of its emails wait for delivery, so one large broadcast cannot fill the send queue ahead of transactional mail. With `SES_PROVIDER=ses` it also polls SES and DNS for pending domains. When `SES_EVENTS_QUEUE_URL` or `SES_INBOUND_QUEUE_URL` is set, it reads those queues.
- The SMTP relay (`apps/smtp`) accepts mail and sends it through the same path as `POST /emails`. See [smtp.md](../smtp.md).
- The dashboard (`apps/dashboard`) and the CLI (`apps/cli`) are clients of the API.

Run as many API and worker processes as you need. Workers claim jobs with `for update skip locked`, so two workers never take the same job. A job left `running` for 5 minutes, or a webhook attempt left `running` for 1 minute, is picked up again.

## Checks

```sh
pnpm run doctor
pnpm --filter @dispatchmail/cli start -- system
pnpm --filter @dispatchmail/cli start -- timeline
```

`GET /system` reports the send job backlog by state, webhook attempts by state, enabled and disabled endpoints, automation runs by state, the log count, and the SES sending quota (`sending`). Its worker concurrency and its SMTP host and ports are the values in the API's own environment, not readings from the worker or the relay, so give the API the same `WORKER_CONCURRENCY` and `SMTP_*` settings. `GET /health` returns 200 when the API can reach Postgres and Redis and needs no key, so a load balancer can use it.

## Production startup checks

With `NODE_ENV=production`:

- The API, the worker, the SMTP relay, and local storage refuse to start unless `APP_SECRET` and `API_KEY_PEPPER` are set to private values of at least 16 characters. The development defaults are refused too. The API and the SMTP relay check `API_KEY_PEPPER`. The API and the worker check `APP_SECRET`, and so does local storage in any process that uses it, the SMTP relay included.
- The API and the worker refuse to start without `PUBLIC_URL` and `APP_URL`. The SMTP relay needs `PUBLIC_URL`. Links in sent mail are built from them, and a localhost default would break every one.
- The API refuses the development value of `DISPATCH_API_KEY` when it is set, and `pnpm db:seed` refuses to run unless that variable holds a private value of 32 or more characters.
- `pnpm db:seed` also refuses to run unless `DISPATCH_PASSWORD` holds a private password of 12 to 200 characters.
- The API and the worker refuse to start unless `SES_PROVIDER=ses`, or `ALLOW_FAKE_PROVIDER=true` says the fake provider is meant. The worker is the process that sends, and on the fake provider it records a delivery and sends nothing.
- Webhook URLs must be https.
- `ALLOW_PUBLIC_SETUP`, `ALLOW_PASSWORDLESS_SESSIONS`, and `ALLOW_PRIVATE_WEBHOOKS` default to `false`.
- The API binds to `0.0.0.0` instead of `127.0.0.1`.

`APP_SECRET` encrypts webhook signing secrets and signs file, share, and unsubscribe tokens. `API_KEY_PEPPER` is the HMAC key for stored API key hashes. Changing `API_KEY_PEPPER` invalidates every API key. Changing `APP_SECRET` breaks stored webhook secrets and every link already sent.

## Environment

### Core

| Variable | Default | Read by | Purpose |
|:---|:---|:---|:---|
| `NODE_ENV` | unset | all | `production` turns on the checks above. |
| `DATABASE_URL` | `postgres://dispatch:dispatch@localhost:5432/dispatch` | API, worker, SMTP | Postgres. |
| `DB_POOL_SIZE` | 20 | API, worker, SMTP | Connections per process. |
| `REDIS_URL` | `redis://localhost:6379` | API, SMTP | Rate limit counters. |
| `APP_SECRET` | dev value outside production | API, worker, local storage | See above. |
| `API_KEY_PEPPER` | dev value outside production | API, SMTP | See above. |
| `PORT` | 3100 | API | Listen port. |
| `API_HOST` or `HOST` | `127.0.0.1`, or `0.0.0.0` in production | API | Bind address. |
| `PUBLIC_URL` | `http://localhost:3100` | API, worker, SMTP, storage | The API's public URL. Tracking links, local file links, and one-click unsubscribe URLs use it. |
| `APP_URL` | `http://localhost:5173` | API, worker | The dashboard's URL. Share links and the unsubscribe preference page use it. |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | API | Comma-separated browser origins allowed to call the API. Set it to the dashboard's origin. |
| `TRUST_PROXY` | unset | API | How far to trust `X-Forwarded-For`: a hop count such as `1`, or a comma-separated list of proxy addresses or ranges. Set it when the API runs behind a load balancer. Unset, every request appears to come from the proxy, and all callers of the public routes share one rate limit. |
| `MAX_BODY_BYTES` | 52428800 (50 MB) | API | Largest JSON body. Contact import files have their own 200 MB limit. |
| `TELEMETRY_FLUSH_MS` | 100 | API | How often buffered logs, audit rows, and usage counters are written. |
| `DISPATCH_API_KEY` | the public development key outside production | seed | The key `pnpm db:seed` gives its tenant. The API never reads a key from the environment. |
| `DISPATCH_PASSWORD` | `dispatch-local-password` outside production | seed | The password `pnpm db:seed` gives `operator@example.test`, 12 to 200 characters. Required in production. The seed sets it only for a new user, prints the development password, and never prints a private one. |
| `WEBHOOK_URL` | `http://localhost:8787/webhooks` | seed | Where the seeded sample webhook posts. |

Each process reads the `.env` file in its working directory and then the one at the repo root. A variable already in the environment is never replaced, so the order is the environment, the local file, the root file.

### Limits

| Variable | Default | Purpose |
|:---|:---|:---|
| `RATE_LIMIT_PER_SECOND` | 10 | Requests made with API keys, per tenant per second, across all keys. Mail sent through the SMTP relay counts too. |
| `SESSION_RATE_LIMIT_PER_SECOND` | 40 | Requests per signed-in dashboard user per second. Counted apart from the API key limit, so an application sending at its limit does not lock its operators out of the dashboard. |
| `PUBLIC_RATE_LIMIT_PER_SECOND` | 50 | Requests per client IP per second to each public route, such as `/click/{token}`. |
| `AUTH_RATE_LIMIT_PER_SECOND` | 5 | Requests per client IP per second to `POST /sessions`. Apart from this, after 10 failed sign-ins for one email within 15 minutes, the API refuses that email until the 15 minutes are up. That limit is fixed. |
| `AUTH_CACHE_TTL_MS` | 5000 | How long the API caches a key lookup. A revoked key can work this long on another API process. |
| `DOMAIN_CACHE_TTL_MS` | 5000 | How long the API caches a verified domain. |

### Worker

| Variable | Default | Purpose |
|:---|:---|:---|
| `WORKER_CONCURRENCY` | 5 | Send jobs and automation runs claimed per pass. Webhook attempts use twice this. |
| `WORKER_INTERVAL_MS` | 250 | Sleep between passes when a pass found no work. |
| `WEBHOOK_MAX_ATTEMPTS` | 8 | Delivery attempts per event. Values above 8 act as 8. See [webhooks.md](../webhooks.md). |
| `LOG_RETENTION_DAYS` | 30 | API request logs older than this are deleted. |
| `IMPORT_CONCURRENCY` | 1 | Contact imports one worker runs at once. |

### Provider and AWS

| Variable | Default | Purpose |
|:---|:---|:---|
| `SES_PROVIDER` | `fake` | `ses` sends through Amazon SES. |
| `ALLOW_FAKE_PROVIDER` | unset | `true` lets a production API and worker run with the fake provider. |
| `FAKE_PROVIDER_TERMINAL_DELAY_MS` | 0 | Fake provider only: how long to hold back the delivered, bounced, or complained event. |
| `FAKE_PROVIDER_DELAYED_DELAY_MS` | 0 | Fake provider only: how long to hold back `email.delivery_delayed`. |
| `AWS_REGION` | `us-east-1` | Region for SQS, S3, and the quota in `GET /system`. Each domain sends from its own `region`. |
| `SES_EVENTS_QUEUE_URL` | unset | SQS queue with SES sending events. Unset, the worker reads no events from SES. |
| `SES_INBOUND_QUEUE_URL` | unset | SQS queue with SES receipt notifications. Unset, no inbound mail arrives. |
| `SES_INBOUND_REGION` | `AWS_REGION` | Region the receipt rule runs in. Inbound mail only goes to domains in this region. With neither variable set, a domain in any region can receive. |

AWS credentials come from the AWS SDK's default chain: environment variables, a profile, or an instance or task role. [aws.md](../aws.md) lists the calls Dispatch makes.

### Storage

| Variable | Default | Purpose |
|:---|:---|:---|
| `STORAGE_BACKEND` | `local` | `s3` stores files in S3. |
| `STORAGE_DIR` | `.dispatch/storage` | Local storage directory. A relative path resolves against the workspace root, the folder with `pnpm-workspace.yaml`, so the API and the worker share it. |
| `S3_BUCKET` | empty | Bucket for `STORAGE_BACKEND=s3`. |
| `S3_ENDPOINT` | unset | An S3-compatible store, such as MinIO at `http://localhost:9000`. Buckets are then addressed by path. Leave unset for AWS. |

Storage holds sent attachments (`attachments/`), received mail and its attachments (`raw/`, `received/`), and contact import files (`imports/`). With local storage, download links point at `PUBLIC_URL/files/{token}` and last one hour. With S3 they are presigned S3 URLs. Contact import files are streamed in both directions, so a 200 MB import is never held in memory. Run the API and the worker against the same storage. On more than one machine that means S3.

### Tracking

| Variable | Default | Purpose |
|:---|:---|:---|
| `TRACKING_DOMAIN` | `links.localhost` | Target of each domain's tracking CNAME record (`links.<domain>` points here). |
| `TRACKING_CUSTOM_HOSTS` | unset | `true` puts tracked links on `https://<tracking_subdomain>.<domain>` once that domain's tracking record is verified. |

Tracked links and the open pixel use `PUBLIC_URL` unless `TRACKING_CUSTOM_HOSTS=true` and the domain's tracking record is verified. A per-domain host needs its own TLS certificate, and a CNAME alone does not give it one. Turn this on only when every verified domain's tracking host serves HTTPS.

### Access switches

| Variable | Default outside production | In production | Purpose |
|:---|:---|:---|:---|
| `ALLOW_PUBLIC_SETUP` | `true` | `false` | `GET /setup` without a key. |
| `ALLOW_PASSWORDLESS_SESSIONS` | `true` | `false` | `POST /sessions` with an email and a full-access key in place of a password, for local development and tests. Password sign-in needs no switch. |
| `ALLOW_PRIVATE_WEBHOOKS` | `true` | `false` | Webhook endpoints may resolve to private addresses. `POST /links/check` never contacts private hosts, whatever this is set to. |

### SMTP relay

`SMTP_PORT` (587 and 2587), `SMTP_TLS_PORT` (465 and 2465), `SMTP_TLS_CERT`, `SMTP_TLS_KEY`, `SMTP_HOSTNAME`, and `SMTP_MAX_CLIENTS` (50 open connections) configure the relay. See [smtp.md](../smtp.md). `SMTP_HOST` is the relay's public hostname. The API shows it in `GET /system` so the dashboard can tell users where to connect.

### Dashboard build

The dashboard is a static build, so its settings are read when it is built, not when it runs. Set them in the environment of `pnpm --filter @dispatchmail/dashboard build`, or in `apps/dashboard/.env`.

| Variable | Default | Purpose |
|:---|:---|:---|
| `VITE_API_URL` | the dashboard's own origin in a production build, `http://localhost:3100` in development | The API's URL. It is the default on the sign-in page, and the only place the public unsubscribe and shared-email pages can learn where the API is. Set it whenever the API and the dashboard are on different hosts. Without it, a recipient who opens an unsubscribe link sees "Could not reach the API". |
| `VITE_ALLOW_REMOTE_API` | unset | `true` lets the sign-in page use an API on a host other than localhost, the dashboard's origin, or `VITE_API_URL`. |
| `VITE_DOCS_URL` | unset | Shows a Docs link in the top bar. |

## Logs and audit

Every request is logged with method, path, status, latency, user agent, and key. Request and response bodies are stored for writes and single-resource reads, up to 64 KB each, with fields such as `token`, `secret`, `signing_secret`, `api_key`, and `password` replaced by `[redacted]`. `GET /logs` and `GET /logs/{id}` read them. Successful writes also go to `GET /audit-logs`.
