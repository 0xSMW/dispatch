# Automations

Automations run a sequence of steps when your application fires an event or a contact changes. They are optional: sending a transactional email does not require an automation or an audience.

Build and save an automation while it is disabled, then start it. Pause a running automation to edit it without losing everyone's place. Use its Runs view to inspect each step's result. Email metrics show real sending and engagement per automation and send step; [sandbox activity](api/README.md#sandbox-recipients) is excluded.

## Triggers

Choose one of five trigger types. In a graph definition, the trigger step's `config` has one of these shapes:

| Trigger | Config | Starts when |
|:---|:---|:---|
| Event received | `{ "type": "event", "event_name": "user.signed_up" }` | Your application fires that event. |
| Contact added | `{ "type": "contact_created" }` | A contact is created or explicitly revived. |
| Contact changes | `{ "type": "contact_updated", "field": "plan", "from": "free", "to": "pro" }` | A stored field makes that exact transition. |
| Subscribed to topic | `{ "type": "topic_subscribed", "topic_id": "topic_..." }` | A contact moves from not receiving the topic to receiving it, with its default applied. |
| Added to segment | `{ "type": "segment_added", "segment_id": "seg_..." }` | A new membership is inserted into a static segment. |

Legacy event configs containing only `{ "event_name": "user.signed_up" }` are still accepted and normalized to `type: "event"`. Automation responses keep `trigger` as the event name for event triggers and return null for contact triggers. `trigger_config` carries the full config for either kind.

### Application events

Fire an event with `POST /events/send`:

```json
{
  "event": "user.signed_up",
  "email": "alex@example.com",
  "payload": {
    "first_name": "Alex",
    "plan": "starter"
  }
}
```

The API returns `202` after storing the event and runs. The worker executes the steps. The example address is a sandbox recipient, so any resulting email is inspectable but does not reach a provider.

An event definition under `/events` is optional. If you define a payload schema, Dispatch checks fired payloads against it. Creating a definition does not fire an event.

When a fired event names a new email address, Dispatch creates a subscribed contact before starting runs. It also fills missing first and last names from the payload, without replacing names already present. A deleted contact is not revived. Other payload fields remain event data; they are not automatically stored as contact properties.

Event names starting with `@` are reserved and refused by event sending, event definitions, event triggers, and Wait for event configs. Internal contact triggers use a separate namespace and are hidden from `/fired-events`. They cannot start an event-triggered automation or satisfy a Wait for event step.

### Contact changes

Use a built-in field or a declared property key for `field`, without the `contact.` prefix, such as `first_name`, `unsubscribed`, or `plan`. Leave out `from` and `to` to match any change to that field. Leave out `field` and both values to match any contact change.

From and To use exact typed equality, not coercion: `false` is not `"false"`, `3` is not `"3"`, and date strings match as stored rather than as equivalent instants. An omitted value is not a constraint; an explicit null matches an absent or cleared value. Property definition fallbacks do not supply missing transition values.

A no-op write does not fire a contact-change trigger. A write changing several fields produces one internal change event, and each matching automation starts at most one run for that write. Re-adding an existing segment member or repeating a topic preference that leaves the effective subscription unchanged does not start another run.

These sources dispatch contact triggers:

| Source | Triggers |
|:---|:---|
| `POST /contacts` | Contact added on create or revival; Contact changes on a changed live contact; topic subscriptions and segment additions included in the write. |
| `PATCH /contacts/{id}` | Contact changes. |
| `PATCH /contacts/{id}/topics` | Subscribed to topic when effective receipt changes from off to on. |
| `POST /contacts/{id}/segments/{segment_id}` | Added to segment on new membership. |
| `POST /topics/{id}/subscriptions` | Contact added when needed; Subscribed to topic on the effective transition. |
| `POST /segments/{id}/contacts` | Contact added when needed; Added to segment on new membership. |
| Application event contact resolution | Contact added for a new address; Contact changes when missing names are filled. Deleted contacts stay deleted. |
| Update contact and Add to segment steps | Actual contact changes, new contacts when needed, and new segment memberships. |
| Preference page and one-click unsubscribe | Contact changes for global subscription changes; Subscribed to topic when the preference page opts a contact in. |
| CSV imports with `trigger_automations: true` | Contact added on insert or revival; Subscribed to topic on the effective off-to-on transition; Added to segment on inserted membership. Not Contact changes. |

A contact created only to record an unsubscribe does not fire Contact added. [Import triggers](audience.md#start-automations-during-an-import) default off and honor each import's stored flag. Creating or enabling an automation does not enroll existing contacts or replay earlier changes.

A step cannot trigger its own automation. Cross-automation trigger chains stop at depth five. If the trigger's topic or segment is deleted, it stops matching and enabling the automation is refused until you change its trigger.

### CLI definitions

Existing event commands still work. Choose a contact source with `--trigger-type`, using `--topic` or `--segment` for its resource:

```sh
dispatch automations create Welcome --trigger-type contact_created \
  --steps '[{"type":"delay","duration":"1 hour"}]'
dispatch automations create Newsletter --trigger-type topic_subscribed \
  --topic topic_123 --file newsletter.json
dispatch automations create Trial --trigger-type segment_added \
  --segment seg_123 --file trial.json
```

For exact From and To filters, use a graph definition in `--file`:

```json
{
  "name": "Activation",
  "steps": [
    {
      "key": "start",
      "type": "trigger",
      "config": { "type": "contact_updated", "field": "activated", "from": false, "to": true }
    },
    { "key": "later", "type": "delay", "config": { "duration": "1 hour" } }
  ],
  "connections": [{ "from": "start", "to": "later", "type": "default" }]
}
```

`--trigger` names an event and cannot be combined with a contact trigger type. `--topic` requires `topic_subscribed`; `--segment` requires `segment_added`. For keyed graph steps, flags replace the existing trigger step's config while preserving keys and connections. Update a disabled or paused automation's contact trigger through `automations update --steps` and `--connections`; `--trigger` changes an event trigger name. Human-readable automation lists show contact triggers in words, not internal keys.

See [Audience history](audience.md#change-history) and [the API guide](api/README.md#broadcasts-and-automations).

## Enroll existing contacts

Starting an automation still does not enroll existing contacts or replay history. To explicitly start runs for existing contacts, use `POST /automations/{id}/enroll`. The automation must be enabled, unpaused, and use a contact trigger, not an application event trigger.

Choose exactly one request body:

```json
{ "segment_id": "seg_123" }
```

```json
{ "all": true }
```

The API returns `202` with an `automation_enrollment_job`. Inspect it with `GET /automations/{id}/enroll-jobs/{job_id}`:

```json
{
  "object": "automation_enrollment_job",
  "id": "job_123",
  "automation_id": "auto_123",
  "segment_id": null,
  "status": "queued",
  "counts": { "total": 1000, "processed": 0, "enrolled": 0, "skipped": 0, "failed": 0 },
  "error": null,
  "created_at": "2026-10-03T00:00:00Z",
  "completed_at": null
}
```

`segment_id` is null for all-contact jobs. Status is `queued`, `in_progress`, `completed`, `failed`, or `cancelled`. Counts report total, processed, enrolled, skipped, and failed contacts; `error` and `completed_at` are nullable.

Only live static segments are accepted. `total` is the audience count at creation. Contacts created later are excluded; deleted contacts and later membership changes can make the final processed count differ from that total.

Use an `idempotency-key` header to retry job creation without creating another job. Keys are scoped to the tenant and automation; using the same key with a different audience returns 409. The SDKs accept an optional key, as TypeScript's third argument `{ idempotencyKey }`, Python's `idempotency_key` argument, or Go's optional third string argument.

The worker pages through live contacts in batches of 500, using each contact's current snapshot rather than replaying historical transitions. A Contact changes trigger's `from` and `to` filters are ignored for explicit enrollment. Each job processes each contact at most once, even with `every_time`; lifetime `once` enrollments remain respected. Enrollment itself does not update contacts, topic preferences, segment membership, or contact-change history. The resulting automation steps can still change contacts or send email normally.

Cancel with `DELETE /automations/{id}/enroll-jobs/{job_id}`. It returns the job and stops further enrollment between batches, not runs already created or emails already queued. Use Stop separately if you want to stop active automation runs.

```sh
dispatch automations enroll auto_123 --segment-id seg_123 --yes
dispatch automations enroll auto_123 --all --yes
dispatch automations enroll-jobs get auto_123 job_123
dispatch automations enroll-jobs cancel auto_123 job_123 --yes
```

SDKs use the same job contract:

```ts
const { data: job } = await dispatch.automations.enroll(id, { segmentId: "seg_123" });
// Or: dispatch.automations.enroll(id, { all: true })
await dispatch.automations.getEnrollmentJob(id, job!.id);
await dispatch.automations.cancelEnrollmentJob(id, job!.id);
```

```python
job = dispatch.enroll(id, {"segment_id": "seg_123"})
# Or: dispatch.enroll(id, {"all": True})
dispatch.get_enrollment_job(id, job["id"])
dispatch.cancel_enrollment_job(id, job["id"])
```

```go
job, err := client.Enroll(id, dispatch.AutomationEnrollment{SegmentID: "seg_123"})
// Or: client.Enroll(id, dispatch.AutomationEnrollment{All: true})
if err != nil { return err }
_, err = client.GetEnrollmentJob(id, job.ID)
if err != nil { return err }
_, err = client.CancelEnrollmentJob(id, job.ID)
```

Contact imports also support cancellation: `DELETE /contacts/imports/{id}` returns a `contact_import` with status `cancelled`. It stops between batches without undoing applied contact changes or cancelling runs already created. Use `dispatch contacts imports cancel imp_123 --yes`, `dispatch.contacts.imports.cancel(id)` in TypeScript, `dispatch.cancel_contact_import(id)` in Python, or `client.CancelContactImport(id)` in Go.

### Worker fairness and history retention

Normal-priority runs are claimed before bulk runs from imports and enrollment jobs. Each automation can claim at most two runs per worker tick, keeping a large flow from monopolizing execution.

For self-hosted deployments, `CONTACT_CHANGES_RETENTION_DAYS` defaults to 400 days. Contact-change history older than the retention window is pruned in bounded batches; retention does not replay triggers or reset lifetime once enrollments.

## Conditions

A Condition chooses the met or not-met path. It reads:

- `event.<field>` from the original triggering payload, such as `event.plan`.
- `event.received_at` from the recorded event's timestamp. A payload field with that name cannot replace it.
- `contact.<field>` from the current live contact when the condition executes. Custom properties are flattened, so use `contact.plan`, not `contact.properties.plan`.
- Built-in contact fields: `id`, `email`, `first_name`, `last_name`, `created_at`, and `unsubscribed`. With no live contact, the contact context is null.
- `contact.topics`, the topic IDs the contact receives, with defaults applied and an empty list for a global opt-out.
- `contact.segments`, the contact's live static segment IDs.

Property definition fallbacks are not applied to this condition context. Existing stored properties named `topics` or `segments` retain precedence over the membership lists. Use `exists` or `is_empty` when a field may be absent. Wait-for-event filters use the same context, with `event.received_at` belonging to the event that satisfies the wait.

Filter and Branch steps use these same rules and fresh contact context. Their event context comes from the run's triggering event.

| Operator | Meaning |
|:---|:---|
| `eq`, `neq` | Strict equality or inequality. The number `3` is not the string `"3"`. |
| `gt`, `gte`, `lt`, `lte` | Ordered comparison; numbers, numeric strings, and ISO dates can be compared. Missing or non-comparable values return false. |
| `contains` | Case-sensitive substring match for text, or exact item membership for an array. |
| `not_contains` | The exact negation of `contains`, including when the field is missing. |
| `starts_with`, `ends_with` | Case-sensitive text prefix or suffix match. |
| `exists` | Value is neither missing nor null; an empty string still exists. |
| `is_empty` | Value is missing, null, an empty string, or an empty array. `0` and `false` are not empty. |
| `within`, `not_within` | Tests an ISO date against the inclusive window from now minus a positive finite duration to now, such as `"7 days"`. Missing or invalid dates return false for both. For valid dates, `not_within` is the complement, including future dates. |

Combine rules with `and` (all match) or `or` (any match). For example, a condition's API `config` can be:

```json
{
  "type": "and",
  "rules": [
    { "type": "rule", "field": "event.plan", "operator": "eq", "value": "starter" },
    { "type": "rule", "field": "contact.first_name", "operator": "exists" }
  ]
}
```

Groups allow 1 to 50 child rules and at most 10 nested levels. Custom [property types](audience.md#properties) are string, number, boolean, and date. Use JSON booleans and numbers for typed comparisons, and ISO strings for dates. Date-only values mean UTC midnight.

The field picker uses declared contact properties, the selected event's schema, and topic and segment names. It limits operators to the field's type. Unknown event fields still accept a manually typed field and value.

For example, `{ "type": "rule", "field": "contact.topics", "operator": "contains", "value": "topic_..." }` checks a topic preference. `{ "type": "rule", "field": "event.received_at", "operator": "within", "value": "2 days" }` checks event freshness.

## Steps

| Step | What it does |
|:---|:---|
| Send email | Queues a published template, addressed to the triggering email unless you set To. |
| Delay | Waits for a duration such as `1 hour` or `2 days`, from 1 second to 30 days. |
| Wait for event | Waits for a later event with the configured name and the same email address, matched case-insensitively. An optional timeout takes the timeout path; without one it waits indefinitely. |
| Condition | Chooses the met or not-met path using a rule. |
| Filter | Ends the run when a rule fails, optionally checking it again before all following steps. |
| Branch | Chooses the first matching path from an ordered list, or Otherwise when none match. |
| Exit | Ends the run deliberately, without executing another step. |
| Add to segment | Adds the contact to a static list. |
| Update contact | Writes configured names, properties, or global subscription status. |
| Delete contact | Deletes the contact and removes its segment memberships and once enrollments. |

The run ends naturally when its chosen path has no next step. An Exit step is an explicit ending with empty config and no outgoing connections. The editor creates an Exit step for an empty path so every path has a real target.

A send step can inherit From from its template and override the subject and reply-to. Trigger payload fields are available as template variables, and explicit step variables override them. Recipient fields are available under `contact.*`, plus `FIRST_NAME`, `LAST_NAME`, and `EMAIL`. See [template variables](templates.md#variables).

### Transactional or Marketing

Choose a kind in each Send email step:

| Kind | Config | Behavior |
|:---|:---|:---|
| Transactional | `{ "kind": "transactional", "template": "receipt" }` | No topic. Does not enforce Marketing opt-outs or add unsubscribe links and headers. Delivery, suppression, and sandbox rules still apply. |
| Marketing | `{ "kind": "marketing", "template": "newsletter", "topic_id": "topic_123" }` | Respects global and topic opt-outs, supplies recipient-specific unsubscribe links, and adds one-click headers. Opt-outs are checked again at delivery. |

Transactional cannot have `topic_id`. Marketing skips deleted contacts, global unsubscribes, and topic opt-outs while the run continues. A Transactional step can still send to a deleted contact's address, as an ordinary send without a topic would.

You can save `{ "kind": "marketing", "template": "newsletter" }` while the automation is disabled or paused and choose its topic later. Creating enabled, enabling, or resuming returns `422` until every Marketing step has a live topic. Execution also refuses a Marketing step whose topic is missing or has been deleted. It never silently sends that step as Transactional.

The editor disables Transactional when the selected [template's kind](templates.md#transactional-or-marketing) is Marketing and shows why. The API rejects the same combination. A Transactional template can be used for Marketing; add a footer link if it does not already have one. Missing body links show a warning, not an error: the one-click header is still added.

Legacy send configs without `kind` remain accepted: `topic_id` means Marketing, and no topic means Transactional. Stored configs and automation responses always carry explicit `kind`. TypeScript, Go, and Python export `SendEmailConfig` with optional kind for compatible input. Nested config keys stay snake_case in all three SDKs.

This choice belongs to automation steps. Ordinary `POST /emails`, batches, and SDK `emails.send` still use only `topic_id`, with no new field or setup required. [Broadcasts](api/README.md#sending-from-flows) are always Marketing.

### Variable mappings

Use a send step's field picker, or its optional `variable_mapping` config, to map template variable names to dotted context fields:

```json
{
  "kind": "transactional",
  "template": {
    "id": "template_...",
    "variables": { "PLAN": "starter" }
  },
  "variable_mapping": {
    "PLAN": "contact.plan",
    "RECEIVED_AT": "event.received_at"
  }
}
```

Mappings override literal variables when the source exists. They read only own properties, and missing source values are omitted. Existing `template.variables` values stay literal: `"contact.plan"` is text unless supplied through `variable_mapping`. Automatic event payload variables still work. The server builds fresh contact context for the actual recipient, and reserved recipient and unsubscribe variables cannot be replaced by mappings or event data.

Mapped values retain their JSON type and must match the template variable's declared type. Contact properties and event fields can be boolean or date, but template variable declarations remain string, number, or list. Use boolean contact fields in template conditionals rather than mapping them to a declared string variable.

Update contact and Add to segment skip deleted contacts rather than reviving them. Changing steps on an enabled automation is refused with `409`; [pause it before editing](#editing-while-paused) to keep existing runs, or stop it to cancel them.

### Filter, Branch, and Exit

A Filter uses `{ "rule": Rule, "scope": "next" | "following" }`:

- `next` evaluates the rule once when the Filter executes. A match continues to its next step.
- `following` does the same and saves `{ "filter": "<step key>", "rule": Rule }` in the run's `guards`. Before every later step, including Delay and Wait for event steps and their resumed execution, all saved guards are checked against fresh contact state and the run's event.
- Any failed filter or guard ends the run with `exit_reason: "filter"`. Failure never follows a `default` connection. Multiple saved guards must all match.

For example, filter on `contact.activated` being the JSON boolean `false` with scope `following`. If `PATCH /contacts/{id}` sets it to `true` during a delay, the run exits before the next step sends. A missing property is not `false`; use an explicit rule for missing values if needed. Already queued emails are not cancelled.

A Branch uses `{ "paths": [{ "key": "...", "label": "...", "rule": Rule }] }`, with 2 to 10 paths. Keys must be nonempty, unique within the branch, and not `otherwise`. Paths are evaluated in array order; the first match wins even when several match. Otherwise is implicit and chosen only when none match.

Every branch requires exactly one outgoing connection for each configured path key and one for `otherwise`. These connections use `type: "branch"` and `path: "<key>"`. Only a Branch can use a branch connection or the `path` field. Each connection targets a real step, including Exit; Exit cannot have any outgoing connections. Other connection types (`default`, `condition_met`, `condition_not_met`, `timeout`, and `event_received`) are unchanged.

Here is a keyed graph using all three steps. Replace `welcome` with a published template that stores a sender:

```json
{
  "name": "Onboarding",
  "status": "disabled",
  "steps": [
    { "key": "start", "type": "trigger", "config": { "type": "contact_created" } },
    {
      "key": "audience",
      "type": "filter",
      "config": {
        "rule": { "type": "rule", "field": "contact.activated", "operator": "eq", "value": false },
        "scope": "following"
      }
    },
    { "key": "later", "type": "delay", "config": { "duration": "1 hour" } },
    {
      "key": "plan",
      "type": "branch",
      "config": {
        "paths": [
          { "key": "free", "label": "Free plan", "rule": { "type": "rule", "field": "contact.plan", "operator": "eq", "value": "free" } },
          { "key": "pro", "label": "Pro plan", "rule": { "type": "rule", "field": "contact.plan", "operator": "eq", "value": "pro" } }
        ]
      }
    },
    { "key": "welcome", "type": "send_email", "config": { "kind": "transactional", "template": "welcome" } },
    { "key": "end", "type": "exit", "config": {} }
  ],
  "connections": [
    { "from": "start", "to": "audience", "type": "default" },
    { "from": "audience", "to": "later", "type": "default" },
    { "from": "later", "to": "plan", "type": "default" },
    { "from": "plan", "to": "welcome", "type": "branch", "path": "free" },
    { "from": "plan", "to": "end", "type": "branch", "path": "pro" },
    { "from": "plan", "to": "end", "type": "branch", "path": "otherwise" },
    { "from": "welcome", "to": "end", "type": "default" }
  ]
}
```

SDK graph configs and connections keep the same snake_case wire keys. TypeScript, Go, and Python export `ExitConfig`, `FilterConfig`, `BranchConfig`, and `BranchPath`; connections support `path`. These additions do not change trigger, re-entry, pause, version, or stable step-key rules.

### Run exit reasons

Run list and detail responses include nullable `exit_reason` and `guards` (an array, empty when no following filter was saved). Status remains `running`, `completed`, `failed`, or `cancelled`.

| Exit reason | Status | Meaning |
|:---|:---|:---|
| `completed` | `completed` | The chosen path ended naturally. |
| `exit` | `completed` | An Exit step ended the run. |
| `filter` | `completed` | A Filter or saved guard failed. |
| `stopped` | `cancelled` | Stop or disabling the automation cancelled the run. |
| `stranded` | `cancelled` | A paused graph edit removed or changed the run's next step. |
| null | `running` or `failed` | No normal exit reason; failed runs describe the failure in `error`. |

There is no `failed` exit reason. Detail step `output` records `{ "path": "<key>" }` for a Branch (including `otherwise`). A failed saved guard records `{ "exited": "filter", "filter": "<originating filter step key>" }` on the later step it prevented. [Lifecycle webhooks](webhooks.md#event-types) carry the run's exit reason too.

## Re-entry

The API's `reentry` is `once` or `every_time`, supplied optionally when creating or updating an automation. Responses include the stored value. New contact triggers default to `once`; new event triggers and existing automations default to `every_time`. Changing a trigger keeps its stored rule unless you explicitly change `reentry` too.

With `once`, an identified contact enters once, even if its run completes or fails. Deleting the contact clears its once enrollments, so explicit revival can enter again. A run without an identified contact is not restricted by `once`. With `every_time`, each matching event or actual contact transition starts a run. There is no active-run exclusion.

Repeated `POST /events/send` calls create separate events and can send again. `x-request-id` is for tracing, not event deduplication. Prevent unwanted repeated events in your application.

Starting an automation does not replay events or contact changes recorded while it was disabled.

## Pause

Automation responses report `status` as `enabled`, `paused`, or `disabled`, and a read-only integer `version`. Every graph save increments the version. Before each step, the executor checks the loaded version; if it has changed, execution holds at the next step and reloads the fresh graph on its next execution.

Use `PATCH /automations/{id}` to change status:

| Status | Effect |
|:---|:---|
| `paused` | Holds existing runs at their next step without cancelling them. Allowed only from enabled or paused. |
| `enabled` | Starts accepting new triggers and resumes held runs. Stopped runs do not restart. |
| `disabled` | Stops runs in progress and stops accepting new triggers. |

Legacy request bodies with `enabled: true` or `enabled: false` map to enabled or disabled respectively. Create an automation enabled or disabled; creating it paused is rejected, and changing disabled to paused returns `409`. Filter lists with `GET /automations?status=paused` (enabled and disabled are also accepted).

```sh
dispatch automations update auto_123 --status paused
dispatch automations list --status paused
dispatch automations update auto_123 --status enabled
```

```ts
await dispatch.automations.update(id, { status: "paused" });
await dispatch.automations.update(id, { status: "enabled" });
```

```python
dispatch.update_automation(id, {"status": "paused"})
dispatch.update_automation(id, {"status": "enabled"})
```

```go
client.UpdateAutomation(id, dispatch.AutomationUpdate{Status: dispatch.AutomationPaused})
client.UpdateAutomation(id, dispatch.AutomationUpdate{Status: dispatch.AutomationEnabled})
```

Pause holds execution, not data updates: contact writes and event history continue normally. New triggers do not start or queue runs for the paused automation, and resume does not replay missed triggers. Existing event waits can still receive their matching event while paused; their chosen path executes after resume. Timers keep their original due times, so overdue waits can continue immediately after resume.

Existing explicit enrollment jobs hold their remaining pages while paused and continue after resume. New enrollment requests are refused while paused. Already queued emails are separate resources and are not cancelled by pause.

Resumed steps use current contact state. For time-sensitive flows, check freshness with conditions on `event.received_at` or contact date properties rather than assuming a pause resets the clock. To enroll contacts missed during a pause, use the explicit [enrollment action](#enroll-existing-contacts) after resuming.

The dashboard has dedicated Pause and Resume controls in the automation header. A paused builder stays editable and shows: "Paused. Runs hold their place. New triggers are not started." Stop and cancel runs is a separate action with confirmation and the optional [re-entry reset](#stop-and-cancel-runs). Viewers can inspect automations but cannot pause, resume, edit, preview saves, or stop them.

### Editing while paused

Save `steps` and `connections` through the ordinary `PATCH /automations/{id}` body while disabled or paused. Enabled graph saves still return `409`. A paused save is atomic: Dispatch locks the automation and its active runs, validates the graph, updates it, and maps each run's next step in one transaction.

Step keys identify a run's place. Keep the same key and step type when editing a step's config. Each automation permanently reserves every saved key for its original type, even after the step is removed. Reusing that key for a different type returns `409`, both on a save and a dry run. Use a new key for a different step type, and remove the old key if you mean to replace that step. Reservation history is internal and is not returned by the API.

- A run whose next key still exists with the same type keeps its place.
- Removing its next key strands the run. Replacing a step with a different type under a new key also removes the old place. Saving stops affected runs with the exact error `Its next step was removed or changed while the automation was paused`, and closes their waiting step rows as cancelled.
- A run already waiting on a Delay or Wait for event keeps its stored wait config, including event name, matching rule, and timeout or due time. Editing that step does not reconfigure its existing waits. Runs that reach it later use the new config.
- Other config edits, such as changing a template, apply to runs that reach the step after saving. Completed steps are not repeated.

Legacy linear definitions with index keys are converted to explicit keys on their first paused graph edit, with existing runs mapped by their original index. When editing through the API or CLI, prefer the explicit graph returned by GET and keep its keys stable.

Preview the same update with `PATCH /automations/{id}?dry_run=true`. It applies the same write permissions and validation as saving and returns:

```json
{ "stranded_runs": 12, "by_step": { "old_send": 10, "old_wait": 2 } }
```

`stranded_runs` counts affected active runs; `by_step` groups them by their next step key. No graph, status, version, key reservations, or run state changes during a dry run. A normal update still returns an automation, not preview counts. The preview is not a save reservation; saving checks the current runs again.

The paused builder previews before saving and asks for confirmation when steps were removed: "12 runs are waiting at steps you removed or changed. They will stop." Cancelling the confirmation does not save the graph.

```sh
dispatch automations update auto_123 --status paused
dispatch automations update auto_123 --steps "$STEPS" --connections "$CONNECTIONS" --dry-run
# After reviewing the counts, send the same definition without --dry-run:
dispatch automations update auto_123 --steps "$STEPS" --connections "$CONNECTIONS"
dispatch automations update auto_123 --status enabled
```

The SDKs expose separate preview methods, using the same input as their ordinary update method:

```ts
const { data: preview, error } = await dispatch.automations.dryRun(id, { steps, connections });
if (error) throw new Error(error.message);
// Review preview!.stranded_runs and preview!.by_step before saving:
await dispatch.automations.update(id, { steps, connections });
```

```python
preview = dispatch.dry_run_automation(id, {"steps": steps, "connections": connections})
# Review preview["stranded_runs"] and preview["by_step"] before saving:
dispatch.update_automation(id, {"steps": steps, "connections": connections})
```

```go
input := dispatch.AutomationUpdate{Steps: &steps, Connections: &connections}
preview, err := client.DryRunAutomation(id, input)
if err != nil { return err }
// Review preview.StrandedRuns and preview.ByStep before saving:
_, err = client.UpdateAutomation(id, input)
```

Saving while paused does not resume the automation. Resume explicitly when the edits are ready. Neither saving nor resuming replays missed triggers; new arrivals after resume use the edited definition.

### Stop and cancel runs

Stop, `POST /automations/{id}/stop`, and changing status to disabled (or `enabled: false`) clear any pause and stop runs in progress, including runs waiting on a delay or event.

The Stop dialog loads the current count of every run in progress before confirmation. The count can change before you stop; Stop cancels all runs still in progress, not just that displayed count.

Stop accepts an optional JSON body:

```json
{ "reset_reentry": true }
```

Omitting the body or field, or sending `false`, keeps once enrollments. Sending `true` lets contacts whose active runs were actually cancelled by this stop enter this automation again after it is started. It deletes only their `once` enrollments, not enrollments for completed runs or other automations. A run that finished before Stop is not reset. Resetting enrollments neither starts a run nor replays a trigger.

The dashboard labels this choice "Let cancelled contacts enter again". SDK calls are backward-compatible:

```ts
await dispatch.automations.stop(id, { resetReentry: true });
```

```python
dispatch.stop_automation(id, reset_reentry=True)
```

```go
client.StopAutomation(id, true)
```

Calling Stop with only the ID preserves enrollments.

Starting again accepts future events; it does not resume stopped runs or replay missed triggers. Already queued emails are separate resources and are not cancelled by stopping the automation. Cancel eligible queued or scheduled emails through the [email API](api/README.md#sending).

For run notifications, see [webhooks](webhooks.md).
