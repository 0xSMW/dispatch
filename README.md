# Dispatch

Dispatch is a self-hosted email API for the email your product sends: password resets, receipts, invitations, and newsletters. You deploy it to your own AWS account. It sends through Amazon SES and keeps every message, event, contact, and log in your Postgres database, with no per-email fee on top of SES. Send with one HTTP request, or with the TypeScript, Python, or Go SDK. Delivery, bounce, open, and click events come back as signed webhooks. A dashboard covers templates, broadcasts, and automations, and shows why any email bounced. Locally it needs no AWS account. A stand-in for SES records each send, and an address with `bounce` in it returns a bounce, so you can test your error handling before you deploy.

## Features

Every email event is traceable, so you can see what's queued, sent, delivered, bounced, opened, and clicked. Fetch any event from the API, receive it as a webhook, or see it on the email's page in the dashboard.

- **Sending API.** Send one email or a batch, schedule one for later, attach files, and retry safely with idempotency keys.
- **SMTP relay.** Send from anything that speaks SMTP, such as a CMS or a framework's mailer, with an API key as the password.
- **Templates.** Sixteen ready-made templates for sign-up, password reset, receipts, invitations, and more, themed with your brand's logo and colors. Each shows Transactional or Marketing. Edit them as code or in a visual editor, or write your own in React Email.
- **Broadcasts.** Always Marketing. Send newsletters and announcements to a segment, now or on a schedule. Before sending, the review step counts recipients, checks every link, and flags a missing unsubscribe link.
- **Contacts and audiences.** Import contacts from CSV, group them into segments, and let people choose topics on a hosted preference page. Every broadcast carries the one-click unsubscribe headers that mail apps turn into an unsubscribe button.
- **Automations.** Run a sequence of emails, waits, and branches when your app sends an event or a contact changes. Choose Transactional (no topic) or Marketing (a topic and opt-out protection) per email step. Build it as a list or on a canvas.
- **Inbound email.** Receive replies and incoming mail on your domains, and pick them up through the API or a webhook.
- **Domains.** Adding a domain returns every DNS record SES needs: DKIM, SPF, DMARC, and MX. Dispatch can publish them to Route 53, and it checks the domain until it verifies.
- **Tracking and metrics.** Track opens and clicks per domain, and follow delivery, bounce, and complaint rates over time.
- **Goals.** Measure event or contact-state conversions retroactively for automation, broadcast and step sends, with current eligibility and explicit history limits. See [Goals](docs/goals.md).
- **Webhooks.** Get a signed event for every delivery, bounce, open, and click. Failed deliveries retry automatically, and you can replay any event.
- **Logs.** Every API request is logged, so you can see exactly what your app sent. Passwords, keys, and other secrets are removed before a log is stored.
- **Suppressions.** A hard bounce or a complaint adds the address to the suppression list. Later sends to it are skipped and reported as `email.suppressed`.
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

The same request in every language is `POST /emails`:

```json
{"from":"hello@example.com","to":"you@example.net","subject":"Welcome aboard","html":"<p>Thanks for signing up.</p>"}
```

#### TypeScript

```sh
pnpm add @dispatchmail/sdk
```

```ts
import { Dispatch } from "@dispatchmail/sdk";

const dispatch = new Dispatch({ apiKey: process.env.DISPATCH_API_KEY, baseUrl: process.env.DISPATCH_API_URL });

const { data, error } = await dispatch.emails.send({
  from: "hello@example.com",
  to: "you@example.net",
  subject: "Welcome aboard",
  html: "<p>Thanks for signing up.</p>",
});
if (error) throw new Error(error.message);
```

#### Python

From a checkout:

```sh
python -m pip install ./packages/sdk-python
```

```python
import os
from dispatch import Dispatch

dispatch = Dispatch(api_key=os.environ["DISPATCH_API_KEY"], base_url=os.environ["DISPATCH_API_URL"])
email = dispatch.send({
    "from": "hello@example.com",
    "to": "you@example.net",
    "subject": "Welcome aboard",
    "html": "<p>Thanks for signing up.</p>",
})
# API errors raise DispatchError.
```

#### Go

The module is `github.com/dispatch/dispatch-go`. To use the SDK from this checkout:

```sh
go mod edit -require=github.com/dispatch/dispatch-go@v0.0.0
go mod edit -replace=github.com/dispatch/dispatch-go=./packages/sdk-go
```

```go
import dispatch "github.com/dispatch/dispatch-go"

client := dispatch.New("") // Reads DISPATCH_API_KEY and DISPATCH_API_URL.
email, err := client.Send(dispatch.Map{
    "from": "hello@example.com", "to": "you@example.net",
    "subject": "Welcome aboard", "html": "<p>Thanks for signing up.</p>",
}, "")
if err != nil { return err }
_ = email
```

Runnable programs are in `examples/`. The `dispatch` CLI does the same from your terminal. See [docs/cli.md](docs/cli.md).

Ordinary sends are **Transactional** when you omit `topic_id` (`topicId` in TypeScript): no contact, topic, or automation is needed. Set it for **Marketing** to respect opt-outs and add recipient-specific unsubscribe links and one-click headers. There is no new `kind` field on the send API or `emails.send`. Automation steps store their kind explicitly; Marketing drafts can wait for a topic but cannot be enabled or resumed without one. See [sending](docs/api/README.md#sending) and [automations](docs/automations.md#transactional-or-marketing).

### Optional lifecycle recipes

Choose one of [six lifecycle recipes](docs/automations/README.md) for newsletter welcome, onboarding, upgrades, win-back, failed payment, or reactivation. Each installs disabled using a verified sender, preserves reused templates unchanged, and documents the app-owned fields/events and review before enabling. Newsletter requires a live topic at install; other Marketing flows can defer their topics but cannot enable without them. [Offline examples](examples/lifecycle/README.md) use the actual SDKs without sending during tests.

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
5. Add your sending domain in the dashboard and publish the DNS records it shows. The worker checks SES and DNS until the domain verifies.

The [self-hosting guide](docs/self-hosting/README.md) walks through each step, and [Operations](docs/operations/README.md) lists every setting.

### Learn more

- [API reference](docs/api/README.md) and the [OpenAPI document](docs/api/openapi.json)
- [Webhooks](docs/webhooks.md)
- [Automations](docs/automations.md), [Audience](docs/audience.md), and [Domains](docs/domains.md)
- [Templates](docs/templates.md), [integration examples](docs/templates/README.md), and [React Email](docs/react-email.md)
- [SMTP relay](docs/smtp.md)
- [Deliverability](docs/deliverability/README.md)
- [Local development](docs/local.md)
- [Troubleshooting](docs/troubleshooting.md)
