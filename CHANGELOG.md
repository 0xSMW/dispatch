# Changelog

## Unreleased

- Add explicit asynchronous enrollment of existing live contacts into enabled, unpaused contact automations, for one segment or all contacts. Jobs page 500 contacts using current snapshots, ignore Contact changes From/To filters, process each contact once per job, and preserve lifetime once re-entry without changing contact history. API, CLI, and SDKs expose job counts and cancellation between batches; cancelling enrollment or a contact import does not cancel runs already created. Claim normal runs before bulk runs, with at most two runs per automation per tick, and prune contact-change history in bounded batches using `CONTACT_CHANGES_RETENTION_DAYS` (default 400).
- Add once-per-contact re-entry, defaulting new contact-triggered automations to `once` and event-triggered automations to `every_time`; existing automations keep `every_time`. Trigger edits preserve the chosen rule. Contact deletion clears once enrollments, and revival can enter again. Stop optionally resets only once enrollments for contacts whose active runs it actually cancels; completed runs keep theirs.
- Let contact imports start matching enabled Contact added, Subscribed to topic, and Added to segment automations, but not Contact changes. This defaults off; an explicit per-import boolean overrides the tenant default, which is resolved and stored at creation. Import runs have bulk priority, retries do not repeat applied transitions, and enabling triggers does not clear opt-outs. Matching flows may send immediately or after configured waits. Import responses expose the stored flag, and SDK import and stop options preserve omission and explicit `false`. Transactional send requirements are unchanged.
- Add contact-added, contact-change, topic-subscription and static-segment triggers alongside existing event triggers. Match typed From/To changes, ignore no-ops, and record transactional contact history even without a matching flow. Separate internal events from app events, prevent step self-entry and stop trigger chains at depth five. API, CLI, SDKs and both automation editors use the same five trigger shapes.
- Add Boolean and Date contact properties with typed fallbacks and CSV imports. Dates stay ISO strings; boolean property cells accept true/false, yes/no, and 1/0. Invalid nonempty boolean/date cells now fail the row instead of silently becoming false or text. Undeclared keys remain allowed.
- Add fresh topic/static-segment membership and recorded event time to automation context, plus `not_contains`, `within`, and `not_within` rules and typed field pickers. Reserve `topics` and `segments` for new property definitions while preserving live legacy definitions and values.
- Add optional `send_email.variable_mapping` for dotted event/contact fields. Existing template variables remain literal, automatic event payload variables still work, and recipient and unsubscribe context stays protected. Transactional send requirements are unchanged.

- Clarify topic subscriptions, static segments, event-created contacts, delay examples and canvas endings. Link Suppressions from Audience as well as Emails. Stop confirmation shows the current count and warns that every run in progress is cancelled, not paused.
- Download a domain's actual DNS records as a BIND zone file for import into DNS hosts other than Route 53, including from a viewer session.
- Keep canvas step and ending buttons clickable inside React Flow's non-selectable wrappers.

- Show Required/Optional template variable controls with saved fallbacks, keep lists fixed Required, and add a visual placeholder panel for names, requirements, fallbacks, and list-item scope. The stored variable model and rendering rules are unchanged.
- Keep each visual list-item fallback when its inspector is dismissed and reopened. Preserve literal inline defaults, including ampersands, quotes, angle brackets, and entity-looking text, through visual saves and reloads.
- Reject unsafe raw HTML in visual paste and drop, including positioned markup inside placeholder fallbacks, without replacing the selection.

- Add public automation, template, audience, and domain guides, with Learn chips pinned to the dashboard version or a configured docs directory. Unavailable guides and anchors stay hidden.

- Require Node 24 LTS and pnpm 10.28.0 for development and builds.
- Fix portable AWS credential-provider declarations for frozen-lockfile builds and document the existing deployment callbacks in OpenAPI.
- Add tenant settings to the API, SDKs, and dashboard, with import automation defaults off and configurable additional sandbox domains.
- Stop sending to `example.com`, `example.net`, `example.org` and their subdomains, domains under `.test`, `.example`, or `.invalid`, and tenant-configured sandbox domains and their subdomains, even in production. These emails are rendered and stored with sandbox flags and simulated delivery events, not real provider delivery. Mixed emails send only real recipients. Sandbox activity is excluded from real email metrics. This is separate from the SES account sandbox.
- Reconcile broadcast Sent counts when queued recipients become sandbox. A simulated retry excludes new sandbox activity without removing earlier real sends, automation step metrics, or click history.
- Add signed, recipient-specific unsubscribe links and protected one-click headers to Marketing sends. Multi-recipient requests with `topic_id` now produce separate To-only emails, with an optional `emails` response array. Batch items follow the same rule. Transactional sends are unchanged.
- Recheck Marketing opt-outs before delivery, including scheduled sends and deleted contacts. Automation templates now receive the recipient's contact fields.
- Attribute automation emails to their flow and step, with per-email metrics in the dashboard and `automation` and `step` API dimensions. Legacy messages have no recoverable step key.
- Show fired events and automation runs in contact history, with stable paged IDs and links to each run.
- Deliver `email.unsubscribed` and automation run started, completed, and failed webhooks once per transition.
- Clarify Marketing and broadcast unsubscribe webhook fanout once per email, including repeated link use. Contact activity shows completed run states (`done`, `failed`, `stopped`) with dashboard run links and CLI labels and run attribution.
