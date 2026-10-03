# Automations

Automations run a sequence of steps when your application fires an event or a contact changes. They are optional: sending a transactional email does not require an automation or an audience.

Build and save an automation while it is disabled, then start it. Use its Runs view to inspect each step's result. Email metrics show real sending and engagement per automation and send step; [sandbox activity](api/README.md#sandbox-recipients) is excluded.

## Triggers

Choose one of five trigger types. In a graph definition, the trigger step's `config` has one of these shapes:

| Trigger | Config | Starts when |
|:---|:---|:---|
| Event received | `{ "type": "event", "event_name": "user.signed_up" }` | Your application fires that event. |
| Contact added | `{ "type": "contact_created" }` | A contact is created or explicitly revived. |
| Contact changes | `{ "type": "contact_updated", "field": "plan", "from": "free", "to": "pro" }` | A stored field makes that exact transition. |
| Subscribed to topic | `{ "type": "topic_subscribed", "topic_id": "topic_..." }` | A contact moves from not receiving the topic to receiving it, with its default applied. |
| Added to segment | `{ "type": "segment_added", "segment_id": "seg_..." }` | A contact joins a static segment for the first time. |

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

A contact created only to record an unsubscribe does not fire Contact added. CSV import triggers and explicit enrollment jobs are not shipped yet. Creating or enabling an automation does not enroll existing contacts or replay earlier changes.

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

`--trigger` names an event and cannot be combined with a contact trigger type. `--topic` requires `topic_subscribed`; `--segment` requires `segment_added`. For keyed graph steps, flags replace the existing trigger step's config while preserving keys and connections. Update a disabled automation's contact trigger through `automations update --steps` and `--connections`; `--trigger` changes an event trigger name. Human-readable automation lists show contact triggers in words, not internal keys.

See [Audience history](audience.md#change-history) and [the API guide](api/README.md#broadcasts-and-automations).

## Conditions

A Condition chooses the met or not-met path. It reads:

- `event.<field>` from the original triggering payload, such as `event.plan`.
- `event.received_at` from the recorded event's timestamp. A payload field with that name cannot replace it.
- `contact.<field>` from the current live contact when the condition executes. Custom properties are flattened, so use `contact.plan`, not `contact.properties.plan`.
- Built-in contact fields: `id`, `email`, `first_name`, `last_name`, `created_at`, and `unsubscribed`. With no live contact, the contact context is null.
- `contact.topics`, the topic IDs the contact receives, with defaults applied and an empty list for a global opt-out.
- `contact.segments`, the contact's live static segment IDs.

Property definition fallbacks are not applied to this condition context. Existing stored properties named `topics` or `segments` retain precedence over the membership lists. Use `exists` or `is_empty` when a field may be absent. Wait-for-event filters use the same context, with `event.received_at` belonging to the event that satisfies the wait.

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
| Add to segment | Adds the contact to a static list. |
| Update contact | Writes configured names, properties, or global subscription status. |
| Delete contact | Deletes the contact and removes its segment memberships. |

The run ends when its chosen path has no next step. The editor's End marker is not a separate configurable step.

A send step can inherit From from its template and override the subject and reply-to. Trigger payload fields are available as template variables, and explicit step variables override them. Recipient fields are available under `contact.*`, plus `FIRST_NAME`, `LAST_NAME`, and `EMAIL`. See [template variables](templates.md#variables).

### Variable mappings

Use a send step's field picker, or its optional `variable_mapping` config, to map template variable names to dotted context fields:

```json
{
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

Set a Topic on the send step for Marketing email. It skips deleted contacts, global unsubscribes, and topic opt-outs, adds recipient-specific unsubscribe links and one-click headers, and checks opt-outs again at delivery. With no topic, the step is Transactional and does not enforce marketing subscriptions, including for a deleted contact's address. A template that prints an unsubscribe link needs a topic.

Update contact and Add to segment skip deleted contacts rather than reviving them. Changing steps on an enabled automation is refused; stop it before editing.

## Re-entry

The API's `reentry` is `once` or `every_time`. New contact triggers default to `once`; new event triggers and existing automations default to `every_time`. Changing a trigger keeps its stored rule. With `once`, an identified contact enters once until it is deleted and explicitly revived. With `every_time`, each matching event or actual contact transition starts a run. There is no active-run exclusion.

Repeated `POST /events/send` calls create separate events and can send again. `x-request-id` is for tracing, not event deduplication. Prevent unwanted repeated events in your application.

Starting an automation does not replay events or contact changes recorded while it was disabled.

## Pause

Automations currently have Start and Stop, not a pause that preserves runs. Stop, `POST /automations/{id}/stop`, and changing an enabled automation to `enabled: false` disable new triggers and stop runs in progress, including runs waiting on a delay or event.

The Stop dialog loads the current count of every run in progress before confirmation. The count can change before you stop; Stop cancels all runs still in progress, not just that displayed count.

Starting again accepts future events; it does not resume stopped runs or replay missed triggers. Already queued emails are separate resources and are not cancelled by stopping the automation. Cancel eligible queued or scheduled emails through the [email API](api/README.md#sending).

For run notifications, see [webhooks](webhooks.md).
