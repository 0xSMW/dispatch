# Changelog

## Unreleased

- Require Node 24 LTS and pnpm 10.28.0 for development and builds.
- Fix portable AWS credential-provider declarations for frozen-lockfile builds and document the existing deployment callbacks in OpenAPI.
- Add tenant settings to the API, SDKs, and dashboard, with import automation defaults off and configurable additional sandbox domains.
- Stop sending to `example.com`, `example.net`, `example.org` and their subdomains, domains under `.test`, `.example`, or `.invalid`, and tenant-configured sandbox domains and their subdomains, even in production. These emails are rendered and stored with sandbox flags and simulated delivery events, not real provider delivery. Mixed emails send only real recipients. Sandbox activity is excluded from real email metrics. This is separate from the SES account sandbox.
- Add signed, recipient-specific unsubscribe links and protected one-click headers to Marketing sends. Multi-recipient requests with `topic_id` now produce separate To-only emails, with an optional `emails` response array. Batch items follow the same rule. Transactional sends are unchanged.
- Recheck Marketing opt-outs before delivery, including scheduled sends and deleted contacts. Automation templates now receive the recipient's contact fields.
- Attribute automation emails to their flow and step, with per-email metrics in the dashboard and `automation` and `step` API dimensions. Legacy messages have no recoverable step key.
- Show fired events and automation runs in contact history, with stable paged IDs and links to each run.
- Deliver `email.unsubscribed` and automation run started, completed, and failed webhooks once per transition.
- Clarify Marketing and broadcast unsubscribe webhook fanout once per email, including repeated link use. Contact activity shows completed run states (`done`, `failed`, `stopped`) with dashboard run links and CLI labels and run attribution.
