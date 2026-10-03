# Changelog

## Unreleased

- Require Node 24 LTS and pnpm 10.28.0 for development and builds.
- Fix portable AWS credential-provider declarations for frozen-lockfile builds and document the existing deployment callbacks in OpenAPI.
- Add tenant settings to the API, SDKs, and dashboard, with import automation defaults off and configurable additional sandbox domains.
- Add signed, recipient-specific unsubscribe links and protected one-click headers to Marketing sends. Multi-recipient requests with `topic_id` now produce separate To-only emails, with an optional `emails` response array. Batch items follow the same rule. Transactional sends are unchanged.
- Recheck Marketing opt-outs before delivery, including scheduled sends and deleted contacts. Automation templates now receive the recipient's contact fields.
- Attribute automation emails to their flow and step, with per-email metrics in the dashboard and `automation` and `step` API dimensions. Legacy messages have no recoverable step key.
- Show fired events and automation runs in contact history, with stable paged IDs and links to each run.
- Deliver `email.unsubscribed` and automation run started, completed, and failed webhooks once per transition.
