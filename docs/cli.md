# CLI

The CLI is named `dispatch` in command examples. During local development, run it through pnpm:

```sh
pnpm --filter @dispatch/cli start -- doctor
```

## Commands

- `doctor` checks Docker, Postgres, Redis, Mailpit, setup, API health, worker backlog, domains, emails, and webhooks.
- `dev up` starts the Docker services.
- `dev seed` creates a tenant, key, domain, and webhook-ready state.
- `send` sends one local test email. Add `--template <alias-or-id> --variables '{"name":"Ada"}'` to render a published template, or `--attachment ./file.pdf --attachment-type application/pdf` to include a local file.
- `batch [--to one@example.com] [--to two@example.com]` sends a compatibility batch with one idempotency key. Add `--emails '[{"from":"hello@example.com","to":"you@example.com","subject":"Subject","text":"Body"}]'` for an explicit payload.
- `domains` lists domains.
- `domains create <name> [--region us-east-1]` creates a domain.
- `domains verify <domain-id>` verifies a local domain.
- `domains doctor [domain-id]` shows DNS readiness checks.
- `keys` lists API keys.
- `keys create [name] [--scope full]` creates a key and prints the secret once.
- `keys delete <key-id>` revokes a key.
- `templates` lists templates.
- `templates create <name> --subject subject [--text body] [--html html] [--alias alias]` creates and publishes a template.
- `templates render <template-id> --variables '{"name":"Ada"}'` previews rendering.
- `contacts` lists contacts.
- `contacts create <email> [--first first] [--last last]` creates or updates a contact.
- `suppressions` lists active suppressions.
- `suppressions create <email> [--reason reason]` blocks a recipient.
- `suppressions delete <suppression-id>` removes a manual suppression.
- `topics` lists topics.
- `topics create <name> [--key product-updates] [--default subscribed]` creates a topic.
- `topics subscribe <topic-id> <email> [--status subscribed]` sets a contact's topic status.
- `topics subscriptions <topic-id>` lists explicit topic subscriptions.
- `segments` lists static segments.
- `segments create <name> [--description text]` creates a segment.
- `segments add <segment-id> <email>` adds or creates a contact in a segment.
- `segments remove <segment-id> <segment-contact-id>` removes a segment membership.
- `segments contacts <segment-id>` lists segment contacts.
- `broadcasts` lists broadcasts.
- `broadcasts create <name> --subject subject [--text body] [--html html] [--topic id] [--segment id]` creates a draft.
- `broadcasts send <broadcast-id>` snapshots eligible contacts and sends locally.
- `broadcasts get <broadcast-id>` retrieves a broadcast with recipient snapshot rows.
- `broadcasts pause|resume|cancel <broadcast-id>` changes broadcast send state.
- `broadcasts clone <broadcast-id> [--name name]` creates a new draft from an existing broadcast.
- `automations` lists automations.
- `automations create <name> --trigger event.name --steps '[{"type":"send_email","from":"hello@example.com","template":"welcome"}]'` creates an event-triggered workflow.
- `automations get <automation-id>` retrieves a workflow.
- `automations runs <automation-id>` lists workflow runs.
- `automations run <run-id>` retrieves a run with step results.
- `automations stop <automation-id>` disables a workflow and stops active runs.
- `emails` lists emails.
- `emails get <email-id>` retrieves one email with recipients, attachments, and events.
- `emails update <email-id> [--subject subject] [--text body] [--html html] [--scheduled-at iso]` updates queued or scheduled email content.
- `emails retry <email-id>` queues a retry job for a failed terminal email.
- `emails events <email-id>` lists one email timeline.
- `emails attachments <email-id> [attachment-id]` lists or retrieves sent attachment content.
- `received` lists received emails.
- `received simulate [--from sender@example.net] [--to inbound@example.com] [--text body]` creates a local received email.
- `received get <received-email-id>` retrieves one received email with recipients and attachments.
- `received attachments <received-email-id> [attachment-id]` lists or retrieves received attachment content.
- `events` lists custom events.
- `events create <name> [--email user@example.com] [--data '{}']` creates a custom event and runs matching automations.
- `events get <event-id>` retrieves one custom event.
- `events update <event-id> [--name name] [--email user@example.com] [--data '{}']` updates event metadata.
- `events delete <event-id>` hides a custom event from lists without removing linked run history.
- `events email <email-id>` lists one email timeline.
- `logs` lists API logs.
- `logs export` prints the latest 1000 API logs.
- `timeline` shows emails, events, inbound, webhooks, automations, and API logs in one feed.
- `usage` shows daily local usage counters.
- `system` shows worker backlog, webhook attempts, automation states, and log health.
- `webhooks` lists webhook endpoints.
- `webhooks create <url> [--events email.sent,email.delivered]` creates a webhook.
- `webhooks test` emits a signed sample event.
- `webhooks attempts <webhook-id>` lists delivery attempts.
- `replay <webhook-id>` requeues the latest failed attempt, or a targeted `--attempt`/`--event`.
- `tail` streams email status changes.
- `listen [--port 8787]` starts a local webhook receiver.
- `test-webhook` is kept as a short alias for `webhooks test`.
- `verify-domain [domain-id]` is kept as a short alias for `domains doctor`.
