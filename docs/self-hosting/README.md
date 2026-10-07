# Self-hosting

Dispatch is three Node processes, a static dashboard, and two services. You run the API, the worker, and optionally the SMTP relay, and you serve the dashboard's built files. They need Postgres (the compose file runs 16), Redis, and either a shared disk or an S3 bucket. Sending goes through Amazon SES.

There is no complete reference deployment yet. `infra/terraform` creates a private, encrypted content bucket and two SQS queues. It does not deploy the application, database, Redis, IAM runtime roles, SES configuration sets, event subscriptions, or HTTPS endpoints. The steps below are what a deployment has to do.

## Try it on one machine

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- API: `http://localhost:3100/health`
- Dashboard: `http://localhost:5173`
- Mailpit: `http://localhost:8025`

This runs with the fake provider and local storage. The Compose ports bind to `127.0.0.1` only. Postgres uses public development credentials, and Redis and Mailpit have no authentication. Keep this stack on your own machine; do not expose its ports or use it as a production deployment. See [local.md](../local.md).

## Production settings

[Operations](../operations/README.md#environment) lists every variable with its default. At minimum, set:

```sh
NODE_ENV=production
DATABASE_URL=postgres://...
REDIS_URL=redis://...
APP_SECRET=<32 or more random characters>
API_KEY_PEPPER=<32 or more random characters, different from APP_SECRET>
PUBLIC_URL=https://api.mail.example.com
APP_URL=https://dashboard.mail.example.com
CORS_ORIGINS=https://dashboard.mail.example.com
SES_PROVIDER=ses
AWS_REGION=us-west-2
STORAGE_BACKEND=s3
S3_BUCKET=<bucket>
SES_EVENTS_QUEUE_URL=https://sqs.us-west-2.amazonaws.com/<account>/<events-queue>
TRACKING_DOMAIN=<host that serves the API over HTTPS, such as track.mail.example.com>
```

Set these in each process's environment, or in a `.env` file at the repo root, which every process reads. A variable in the environment wins over the file. Do not use `.env.example` as that file: it holds local development values.

With `NODE_ENV=production`, each process checks the secrets it uses and refuses to start on a missing, short, or development value. The API and the SMTP relay check `API_KEY_PEPPER`. The API and the worker check `APP_SECRET`, and so does any process that uses local storage. The API and the worker also refuse to start without `SES_PROVIDER=ses`, because the fake provider records a delivery and sends nothing. Keep both secrets stable. A new `API_KEY_PEPPER` invalidates every API key, and a new `APP_SECRET` breaks stored webhook secrets and links already sent.

Back up the database, then run `pnpm db:migrate` before starting a new version. It applies `packages/db/src/schema.ts`. Most of that file adds tables, columns, and indexes that are missing. A few statements change data, and each does nothing the second time:

- Contacts whose addresses differ only by letter case are merged into one. The row that stays keeps the others' segments, topic choices, opt-outs, and broadcast history, and the other rows are deleted.
- Every contact address is lowercased.
- Suppressions that an older build recorded for a bounce or a complaint get the matching `origin`.
- Some unique constraints are replaced by ones that ignore deleted rows.

Put the API behind HTTPS at `PUBLIC_URL`. Tracking links, local file links, and the one-click unsubscribe URL in each email point there, and `GET /health` works as a load balancer check. Behind a load balancer or reverse proxy, set `TRUST_PROXY` (`1` for a single proxy), so rate limits on the public routes count each visitor and not the proxy. The API and the worker must share storage. With more than one machine, use S3.

Build the dashboard with the API's URL, then serve `apps/dashboard/dist` as static files at `APP_URL`, with `index.html` returned for unknown paths:

```sh
VITE_API_URL=https://api.mail.example.com pnpm --filter @dispatchmail/dashboard build
```

`VITE_API_URL` is read at build time. The unsubscribe page that recipients open has no other way to find the API. A build without it calls the dashboard's own origin, which only works when one host serves both.

People sign in to the dashboard with their email and password. This works in production with no extra setting. Leave `ALLOW_PASSWORDLESS_SESSIONS` off. It turns on a local shortcut that signs in with an API key in place of a password. After 10 wrong passwords for one email in 15 minutes, the API refuses that email until the 15 minutes are up. A right password or an admin's reset does not end the wait early. There are no reset emails. An admin sets a new password for a teammate on the team page, or with `PATCH /users/{id}`.

Each tenant has two roles. Admin can do everything. Viewer can read and change nothing, which suits support staff checking why an email bounced. A viewer does not see webhook signing secrets, webhook URL paths, or the unsubscribe and tracking links inside stored emails, and gets download links that last 5 minutes. Pick the role when you invite someone on the team page.

Users created before passwords existed have none and cannot sign in until they get one. `pnpm db:migrate` adds the Viewer role to every tenant and renames the old `owner` role to Admin. Then set each user's password with a full-access key:

```sh
curl -X PATCH "$PUBLIC_URL/users/user_..." \
  -H "Authorization: Bearer $DISPATCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"password":"12 to 200 characters"}'
```

## Sending with SES

Each domain sends from the region it was created in. Dispatch creates the SES identity when you add a domain and deletes it when you delete the domain. It does not create configuration sets. Create two in each region you send from:

- `dispatch-default`, used for normal sends and set on every new identity
- `dispatch-tls-required`, used for domains with `tls: enforced`. Set its TLS policy to require.

Verify `DeliveryOptions.TlsPolicy` is `REQUIRE` for `dispatch-tls-required` after creation and on later provisioning runs. The account-specific `scripts/provision-aws.py` reconciles and verifies this setting on every run; its account, domain, and Vercel role settings must be reviewed before using it for another deployment.

Give both an event destination for send, delivery, bounce, complaint, delivery delay, reject, and rendering failure events, delivered to the SQS queue named by `SES_EVENTS_QUEUE_URL`. The worker parses each message body as the SES event itself, so when SNS sits between SES and SQS, turn on raw message delivery on the subscription. Dispatch tags every message with `dispatch_email_id` and `dispatch_tenant_id` and uses those tags to match events to emails. Without the queue, emails stop at `sent`, and bounces and complaints never suppress anyone.

A new SES account is in the sandbox and can only send to verified addresses. `GET /system` reports the account's quota and whether it is in the sandbox.

## Domains

`POST /domains` returns the DNS records SES needs: three DKIM CNAMEs, an MX and an SPF TXT on the return path (`send.<domain>` by default), a DMARC TXT, the tracking CNAME (`links.<domain>` pointing at `TRACKING_DOMAIN`), and, with receiving on, an MX for the domain. After the records are published, `POST /domains/{id}/verify` starts verification. The worker polls SES and DNS until the domain is verified or fails. `GET /domains/{id}/doctor` shows what DNS returns for each record.

`POST /domains/{id}/publish-route53` writes the records into the Route 53 hosted zone whose name matches the domain. It leaves an existing DMARC record alone, and existing MX records too, because replacing them would cut off mail to mailboxes already on the domain. It skips the tracking record when `TRACKING_DOMAIN` is not a real host, such as the default `links.localhost`. Each record it leaves alone is listed in `skipped` with the reason.

## Click and open tracking

With tracking on for a domain, Dispatch rewrites links to `PUBLIC_URL/click/{token}` and adds a pixel at `PUBLIC_URL/open/{token}.gif`. Links stay on `PUBLIC_URL` unless `TRACKING_CUSTOM_HOSTS=true` and the domain's tracking record is verified, in which case they use `https://links.<domain>`. That host needs its own TLS certificate, which a CNAME alone does not give it. Turn the setting on only when every verified domain's tracking host serves HTTPS and routes to the API.

## Receiving mail

Receiving needs an SES receipt rule, which you create:

1. Turn on receiving for the domain (`capabilities.receiving: "enabled"`) and publish its MX record, `inbound-smtp.<region>.amazonaws.com`.
2. In the region named by `SES_INBOUND_REGION` (default `AWS_REGION`), add a receipt rule for the domain with an S3 action. Write to `S3_BUCKET` with the object key prefix `raw/`, so each message lands at `raw/<messageId>`. Have the action notify an SNS topic.
3. Subscribe the queue named by `SES_INBOUND_QUEUE_URL` to that topic with raw message delivery on.
4. Use `STORAGE_BACKEND=s3` with the same bucket, so the worker can read the message.

The worker parses each message and stores it as a received email, then emits `email.received`. It delivers a message only to a tenant whose domain matches the first recipient, is verified, has receiving enabled, and is in `SES_INBOUND_REGION`. When no tenant matches, or more than one does, it drops the message. SQS redelivery does not create duplicates.

Without SES, `POST /emails/receiving/simulate` stores a received email for testing.

## Webhooks

The worker calls webhook endpoints from wherever it runs. In production, endpoints must be https, and hosts that resolve to private addresses are refused when the endpoint is saved and again before each delivery. Set `ALLOW_PRIVATE_WEBHOOKS=true` only if your endpoints live on a private network. See [webhooks.md](../webhooks.md).

## First tenant

After the migration, create the tenant:

```sh
pnpm db:bootstrap -- --name "Acme" --email you@acme.com --password "a private password"
```

`--password` is required, 12 to 200 characters. The script creates a tenant, the Admin and Viewer roles, one Admin user with that email and password, a full-access API key, and the library templates. It prints the key once and stores only its hash, so save it then. It stores only a hash of the password too, and never prints it. Sign in to the dashboard with that email and password. Run it again with another name for another tenant.

`pnpm db:seed` is for local development. It creates a tenant with fixed IDs, the user `operator@example.test`, a verified `example.com` domain, and a sample webhook. In production it refuses to run unless `DISPATCH_API_KEY` is set to a private value of 32 or more characters, which becomes the tenant's key, and `DISPATCH_PASSWORD` is set to a private password of 12 to 200 characters, which becomes the password for `operator@example.test`.

Keep `ALLOW_PUBLIC_SETUP` off in production.
