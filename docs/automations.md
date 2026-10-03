# Automations

Automations run a sequence of steps when your application fires an event. They are optional: sending a transactional email does not require an automation or an audience.

Build and save an automation while it is disabled, then start it. Use its Runs view to inspect each step's result. Email metrics show real sending and engagement per automation and send step; [sandbox activity](api/README.md#sandbox-recipients) is excluded.

## Triggers

A trigger matches an event name, such as `user.signed_up`. Fire it with `POST /events/send`:

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

Contact creation and property changes are not automation triggers by themselves. To start a signup flow today, fire your application event when signup happens. See [the API guide](api/README.md#broadcasts-and-automations).

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

Each matching fired event starts a new run for every enabled automation with that trigger. There is no once-per-contact setting or active-run exclusion: the same contact can have several runs at once.

Repeated `POST /events/send` calls create separate events and can send again. `x-request-id` is for tracing, not event deduplication. Prevent unwanted repeated events in your application.

Starting an automation does not replay events fired while it was disabled.

## Pause

Automations currently have Start and Stop, not a pause that preserves runs. Stop, `POST /automations/{id}/stop`, and changing an enabled automation to `enabled: false` disable new triggers and stop runs in progress, including runs waiting on a delay or event.

The Stop dialog loads the current count of every run in progress before confirmation. The count can change before you stop; Stop cancels all runs still in progress, not just that displayed count.

Starting again accepts future events; it does not resume stopped runs or replay missed triggers. Already queued emails are separate resources and are not cancelled by stopping the automation. Cancel eligible queued or scheduled emails through the [email API](api/README.md#sending).

For run notifications, see [webhooks](webhooks.md).
