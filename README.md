# Dispatch

Dispatch is an email platform you run in your own AWS account. One API sends everything your product needs, from password resets and receipts to newsletters. Delivery goes through Amazon SES, and every message, contact, and log stays in your own database. You pay SES rates, with no per-email markup on top. Your developers get a clean REST API, SDKs for TypeScript, Python, and Go, and a CLI. Everyone else on your team gets a dashboard to write templates, send broadcasts, build automations, and see why an email bounced. On a laptop it runs with no AWS account at all, so you can build and test every email before a real one goes out.

## Features

Dispatch handles the whole life of an email. You write it, address it, and send it, then follow it through delivery, opens, clicks, bounces, and replies. Developers work from the API and the SDKs, and marketing and support work from the dashboard. Both see the same data.

- **Sending API.** Send one email or a batch, schedule one for later, attach files, and retry safely with idempotency keys.
- **SMTP relay.** Point any app or tool that speaks SMTP at Dispatch and sign in with an API key.
- **Templates.** Sixteen ready-made templates for sign-up, password reset, receipts, invitations, and more, themed with your brand's logo and colors. Edit them as code or in a visual editor, or write your own in React Email.
- **Broadcasts.** Send newsletters and announcements to a segment, with a review step that checks links and recipients before anything goes out.
- **Contacts and audiences.** Import contacts from CSV, group them into segments, and let people choose topics on a hosted preference page. Every broadcast carries the one-click unsubscribe headers that mail apps turn into an unsubscribe button.
- **Automations.** Trigger a sequence of emails, waits, and branches from events your app sends, such as a signup or an upgrade. Build it as a list or on a canvas.
- **Inbound email.** Receive replies and incoming mail on your domains, and pick them up through the API or a webhook.
- **Domains.** Dispatch gives you every DNS record SES needs, can publish them to Route 53, and watches each domain until it verifies.
- **Tracking and metrics.** Track opens and clicks per domain, and follow delivery, bounce, and complaint rates over time.
- **Webhooks.** Get a signed event for every delivery, bounce, open, and click. Failed deliveries retry automatically, and you can replay any event.
- **Logs.** Every API request is logged, so you can see exactly what your app sent. Passwords, keys, and other secrets are removed before a log is stored.
- **Suppressions.** Hard bounces and complaints suppress the address automatically, which protects your sender reputation.
- **Team access.** Invite teammates as Admins, or as Viewers who can look into any email and change nothing.

## Getting started

### Try it on your laptop

You need Node.js 22, pnpm 10, and Docker. Clone this repository, then run:

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

This starts Postgres, Redis, the API, the background worker, and the dashboard. The seed creates a workspace with a verified `example.com` domain, an API key, and the template library. No email leaves your machine. A local stand-in for SES records each send and reports it delivered.

- Dashboard: http://localhost:5173. Sign in as `operator@example.test` with the password `dispatch-local-password`.
- API: `/health`

Send your first email:

```sh
export DISPATCH_API_KEY=sk_local_dispatch_dev_key_change_before_deploy
curl http://localhost:3100/emails \
  -H "Authorization: Bearer $DISPATCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from":"hello@example.com","to":"you@example.net","subject":"Hello","text":"My first email from Dispatch."}'
```

Open the dashboard to see it arrive in the email list. To try failures, send to an address with `bounce`, `complaint`, or `delay` in it, and watch the events come in.

### Send from code

```ts
import { Dispatch } from "@dispatchmail/sdk";

const dispatch = new Dispatch({ apiKey: process.env.DISPATCH_API_KEY });

await dispatch.emails.send({
  from: "hello@example.com",
  to: "you@example.net",
  subject: "Welcome aboard",
  html: "<p>Thanks for signing up.</p>",
});
```

The Python SDK is in `packages/sdk-python` and the Go SDK in `packages/sdk-go`, with runnable programs in `examples/`. The `dispatch` CLI does the same from your terminal. See [docs/cli.md](docs/cli.md).

### Run it in production

Dispatch runs as three Node processes (the API, the worker, and an optional SMTP relay) and a dashboard served as static files. They need Postgres, Redis, and S3 or a shared disk, and they send through SES in your AWS account.

1. Set up SES, an S3 bucket, and an SQS queue for delivery events. [AWS setup](docs/aws.md) lists the permissions each process needs.
2. Set the production environment: database and Redis URLs, two private secrets, your public URLs, and `SES_PROVIDER=ses`. Each process refuses to start on a missing or development value, so a mistake shows up at startup and not in your customers' inboxes.
3. Run `pnpm db:migrate`, then create your workspace and first admin:

   ```sh
   pnpm db:bootstrap -- --name "Acme" --email you@acme.com --password "a private password"
   ```

   It prints your first API key once. Save it.
4. Build the dashboard with your API's URL, serve it, and start the API and the worker.
5. Add your sending domain in the dashboard, publish the DNS records it shows, and Dispatch verifies the domain for you.

The [self-hosting guide](docs/self-hosting/README.md) walks through each step, and [Operations](docs/operations/README.md) lists every setting.

### Learn more

- [API reference](docs/api/README.md) and the [OpenAPI document](docs/api/openapi.json)
- [Webhooks](docs/webhooks.md)
- [Templates](docs/templates) and [React Email](docs/react-email.md)
- [SMTP relay](docs/smtp.md)
- [Deliverability](docs/deliverability/README.md)
- [Local development](docs/local.md)
- [Troubleshooting](docs/troubleshooting.md)
