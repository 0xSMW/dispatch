# Audience

Audience holds contacts, custom properties, static lists, dynamic filters, and topic preferences. None is required to send a transactional email.

Contacts are identified by email, matched case-insensitively. Create them through the dashboard, the contact API, or a CSV import. [Firing an event](automations.md#triggers) with a new email address also creates a contact.

## Contact triggers

Enabled automations can start when a contact is added, changes, subscribes to a topic, or joins a static segment. Explicitly creating a previously deleted contact revives it and fires Contact added. Events never revive deleted contacts.

Contact API writes, topic subscriptions, segment additions, event-created contacts and filled names, automation contact steps, and preference-page changes dispatch their actual changes. A contact created solely to record an unsubscribe does not fire Contact added. CSV imports can start matching automations when their stored `trigger_automations` flag is on; see [CSV imports](#csv-imports).

Identical writes do not fire Contact changes. Re-adding a segment member is a no-op. Topic triggers use the effective preference, with the topic's default applied, and fire only when it moves from not receiving to receiving. An explicit opt-in that merely repeats an Opt in default is not a new subscription transition.

For exact change matching, use raw typed From and To values: boolean `false`, number `3`, or the stored date string, not string versions of booleans or numbers. An omitted value leaves that side unconstrained; explicit null matches an absent or cleared value. A multi-field write starts at most one run per matching automation. See [contact trigger configs and sources](automations.md#contact-changes).

## Change history

Contact field changes are recorded from the release that adds contact triggers onward, even when no automation matches. Earlier changes are not backfilled. No-op writes create no change rows. Each changed field records its raw before and after values, request ID, and timestamp; a multi-field write has several history rows but one internal trigger event.

Contact changes are separate from public fired events and automation-run history. Internal `@` events do not appear in the public fired-event list or satisfy event waits. History is not a replay or enrollment mechanism.

## Properties

Properties store application-owned values such as `plan`, `project_count`, `activated`, or `last_active_at`.

1. Add a property under Audience → Properties.
2. Choose a key of 1 to 50 letters, digits, or underscores. New definitions cannot use `topics` or `segments`.
3. Choose String, Number, Boolean, or Date. The key and type cannot change after creation; the saved fallback can.
4. Write contact values through the API or an automation's Update contact step.

For example, `PATCH /contacts/{id}` accepts:

```json
{
  "properties": {
    "plan": "starter",
    "project_count": 3,
    "activated": false,
    "last_active_at": "2026-10-03T09:30:00Z"
  }
}
```

Send raw values when writing. Contact responses wrap each stored property as `{ "value": ..., "type": ... }`. Defined number properties require finite JSON numbers, boolean properties require `true` or `false`, and string properties require strings. Date properties require ISO strings: `YYYY-MM-DD`, or a timestamp with seconds, optional fractional seconds, and `Z` or a numeric offset. Invalid calendar dates, unzoned timestamps, and other date formats are refused. Dates stay as supplied, without normalization; date-only values mean UTC midnight in rules.

A contact API patch merges properties; setting a property to null removes that stored key. Undeclared keys remain allowed. Existing live property definitions named `topics` or `segments` keep their type and can still update their fallback. Their stored contact values take precedence over the membership fields in automation context.

Creating or updating a property definition's `fallback_value` requires the same type as the definition, or null to clear it. For example, a Boolean fallback must be `false`, not `"false"`.

Use `contact.plan` in [automation conditions](automations.md#conditions) and `{{{contact.plan}}}` in broadcast or automation templates. Conditions read stored values, not property definition fallbacks. The current send renderer does not automatically apply the fallback saved on a property definition either; use a [template inline fallback](templates.md#variables), such as `{{{contact.plan|starter}}}`, when needed.

Deleting a property definition leaves values already stored on contacts. Treat definitions as types and metadata, not as a way to erase contact data.

## CSV imports

`POST /contacts/imports` accepts a multipart CSV file and a JSON `column_map` field. Map custom columns under `properties`:

```json
{
  "properties": {
    "activated": { "column": "Activated", "type": "boolean" },
    "last_active_at": { "column": "Last active", "type": "date" }
  }
}
```

A declared property's type takes precedence over the map's type. Undeclared properties can use any of the four types. Boolean property cells accept `true`/`false`, `yes`/`no`, or `1`/`0`, case-insensitively. Date cells accept the same ISO strings as the contact API. Surrounding whitespace is trimmed; empty property cells are omitted. An invalid nonempty boolean or date cell fails that row, increments `counts.failed`, and does not stop valid rows from importing. The existing `unsubscribed` column remains a separate consent flag.

### Start automations during an import

Imports default to not starting automations. The tenant setting [`import_trigger_automations`](settings.md) supplies the default. The dashboard's "Start automations for these contacts" switch overrides it for that import.

The multipart API accepts an optional `trigger_automations` field containing exactly `true` or `false`. These encode a boolean, not `1`, `0`, or a truthy string. Explicit `false` overrides a tenant default of `true`. Omission resolves the tenant default when the import is created and stores that value; changing the setting later does not change queued imports.

Creation returns:

```json
{ "object": "contact_import", "id": "import_...", "trigger_automations": true }
```

The API also includes `request_id`. `GET /contacts/imports` entries and `GET /contacts/imports/{id}` include the same stored boolean.

With the flag on, an import can start enabled automations for:

- Contact added when a row inserts or revives a deleted contact.
- Subscribed to topic only when effective receipt moves from off to on, with the topic's default applied.
- Added to segment only when a membership is actually inserted.

Imports do not fire Contact changes, even when they update an existing contact's fields. Skipped, invalid, and unchanged rows do not create these transitions. Worker retries of the same import do not repeat triggers for changes already applied. A separate upload creates a new import.

Runs started by imports have bulk priority. Enabling this flag does not create or enable automations, clear opt-outs, or grant permission to send Marketing email. Matching flows may send immediately or after their configured waits; Marketing steps still honor global unsubscribes, topic preferences, and suppressions. [Re-entry rules](automations.md#re-entry) still apply.

SDK inputs are optional and preserve omission:

```ts
await dispatch.contacts.imports.create({ file: csv, triggerAutomations: false });
```

```python
dispatch.import_contacts(csv, trigger_automations=False)
```

```go
off := false
client.ImportContacts(dispatch.ContactImportInput{
    File: csv, TriggerAutomations: &off,
})
```

Omit the TypeScript/Python option, or leave the Go pointer nil, to use the tenant default.

## Segments

Choose **Static list** for manual membership, or **Filter** for contacts matching current state. Static membership changes when you add or remove a contact. Dynamic membership changes automatically as contact properties, preferences, or recorded email activity change.

Create a segment under Audience → Segments, then manage members from the segment or contact page. The API supports:

- `POST /segments` with `{ "name": "Trial users" }`.
- `POST /segments/{id}/contacts` with `{ "email": "alex@example.com" }` (creates the contact if needed).
- `DELETE /segments/{id}/contacts/{contact_id}`.

An automation's Add to segment step can add its contact. Adding an existing member does not create duplicate membership.

An Added to segment trigger starts only on new membership. Deleting its segment stops matching; the automation cannot be enabled again until its trigger changes.

Use a segment to choose a broadcast's audience. Being in a segment is not permission to receive Marketing email: global unsubscribes, topic preferences, and suppressions still apply. Deleting a contact removes its segment memberships.

### Dynamic filters

`POST /segments` accepts an optional `rule`. Null or omission creates a static list. For example:

```json
{
  "name": "Active trial users",
  "rule": {
    "type": "and",
    "rules": [
      { "type": "rule", "field": "contact.plan", "operator": "eq", "value": "trial" },
      { "type": "rule", "field": "email.opened", "operator": "eq", "value": true, "window": "30 days" }
    ]
  }
}
```

Declare `plan` as a String property first. Filters support declared contact properties, built-ins, receiving `contact.topics`, and static `contact.segments`. Rules allow five total node levels and twenty conditions. Membership cannot reference another dynamic filter; event fields are not segment fields. Existing own properties named `topics` or `segments` retain precedence.

Email facts are `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, and `email.bounced`. They accept boolean `eq`/`neq`. Optional scope is exactly one of `{"automation_id":"auto_..."}` or `{"broadcast_id":"broadcast_..."}`. Save and preview require a live same-tenant scope; deleting it later means no matching facts, not an unscoped fallback. Optional positive-duration `window` includes both bounds, from statement time minus the duration through statement time. Without a window, all recorded history is eligible. Facts test existence, not event counts. Negative facts also match contacts never sent mail. Sandbox events do not count; recipient-specific events cannot count a different recipient.

`POST /segments/preview` with `{ "rule": ... }` returns an uncached `{ "count": number, "sample": [...] }`, with at most ten contacts from one statement snapshot. Viewers may preview but cannot save. The dashboard debounces this preview while editing.

`GET /segments` returns `type`, `rule`, and `contacts: null` for dynamic rows. Detail returns a numeric count, cached for up to 30 seconds. Editing, conversion, and deletion invalidate that segment's count. Filtered contact lists, contact segment context, broadcast review, and snapshots use SQL matching, not application-side contact filtering.

`PATCH /segments/{id}` preserves the rule when omitted; explicit `rule: null` converts to an empty static list. Remove a static list's members explicitly before converting it to a filter. A static list used by another filter cannot become dynamic. Dynamic membership add/delete, contact segment arrays, imports, Add to segment steps, and Added to segment triggers are refused. Predicate changes do not emit Added to segment events.

Snapshots copy recipients in one database statement and remain unchanged by later contact edits. Review counts can change before the snapshot. Consent, suppressions, and mailbox deduplication still apply.

SQL supports valid finite numeric and ISO values and safely guards malformed legacy shapes. It does not promise universal JavaScript `Number()`/locale-date parsing or arbitrary manually stored large-number precision equivalence. Automation evaluation remains unchanged and explicitly refuses unresolved email-engagement rules.

```ts
const rule = { type: "rule", field: "email.clicked", operator: "eq", value: true } as const;
await dispatch.segments.preview(rule);
await dispatch.segments.create({ name: "Clicked", rule });
await dispatch.segments.update("seg_...", { rule: null });
```

Python uses `preview_segment(rule)`, `create_segment({"name": "Clicked", "rule": rule})`, and `update_segment(id, {"rule": None})`. Go uses `PreviewSegment(rule)`, `CreateSegment(SegmentInput{Name: "Clicked", Rule: rule})`, and `UpdateSegment(id, Map{"rule": nil})`; an omitted field preserves the existing filter.

## Topics

Topics describe categories of Marketing email, such as Product updates or Newsletters. They are preferences, not audience lists.

Form submissions can create **Pending confirmation** preferences. Pending is not Opt in: Marketing ingest, receiving-topic rules, broadcast review and snapshots exclude it, even for topics that default to Opt in.

## Signup forms

Under Audience → Forms, choose live topics, declared properties, a sender on a verified sending-enabled domain, and exact allowed website origins. Double opt-in defaults on. Copy the HTML or browser fetch snippet; neither contains an API key.

Management uses authenticated `GET/POST /forms` and `GET/PATCH/DELETE /forms/{id}`. Public submission uses `POST /forms/{key}`, with the random public **key**, not the management ID. Viewers can inspect forms and copy snippets but cannot create, change or delete them.

Public JSON accepts `email`, optional `first_name` and `last_name`, a `properties` object containing only configured keys, and an empty `website` honeypot. A plain HTML form uses `properties.KEY` fields. Form-encoded numbers and `true`/`false` booleans are converted to their declared types. JSON uses native declared types. Requests are capped at 16 KB. An exact configured `Origin` is required; OPTIONS permits POST and `content-type` only. Missing or foreign origins are refused. The per-IP public limit applies to the route, not each key.

Successful, duplicate, quota-refused and honeypot submissions receive the same message: “Thank you. Check your email if confirmation is needed.” They never reveal subscription state. Confirmation email is limited to one per address and form per rolling 24 hours, plus the tenant's [UTC daily cap](settings.md). Contact, pending consent, token, quota reservations and enqueue commit together; failed enqueue never grants receiving consent.

Double opt-in sets the selected topics to Pending and sends the built-in `confirm-subscription` template. A globally opted-out or deleted contact requires confirmation even if the form has double opt-in off. Submission never revives a deleted contact. A new ordinary single-opt-in contact subscribes immediately.

Confirmation links expire after seven days. Opening `/confirm/{token}` only displays the form and a Confirm button, without a session. The deliberate POST can revive the contact, clear its global opt-out and subscribe the original token-bound topics. Concurrent or repeated POSTs produce the actual topic transition once. Reusing a consumed link after a later opt-out cannot resubscribe. Tokens are purpose-scoped, tenant/form/contact-bound, and backed by durable single-use state. A form's configured HTTPS redirect is the only redirect destination; request fields and query strings cannot replace it.

TypeScript management:

```ts
const result = await dispatch.forms.create({
  name: "Newsletter", topicIds: ["topic_..."], fromEmail: "hello@your-verified-domain.com",
  allowedOrigins: ["https://your-site.com"], doubleOptIn: true,
});
await dispatch.forms.list();
await dispatch.forms.update(result.data!.id, { redirectUrl: "https://your-site.com/thanks" });
```

Python exposes `forms`, `form`, `create_form`, `update_form`, and `delete_form`, with snake_case inputs. Go exposes `Forms`, `Form`, `CreateForm`, `UpdateForm`, and `DeleteForm`; `FormInput.DoubleOptIn` is a pointer so nil preserves the server default. These clients manage forms. Browser snippets submit publicly without credentials.

## Topic defaults and visibility

Choose these settings when creating a topic:

- **Defaults to Opt in:** a contact with no explicit preference receives the topic.
- **Defaults to Opt out:** only contacts explicitly opted in receive it.
- **Public:** shown on the preference page.
- **Private:** shown only when the contact currently receives it, including through an Opt in default.

The default subscription cannot change after creation. Visibility, name, and description can.

Set per-contact preferences on the contact page or with `PATCH /contacts/{id}/topics`:

```json
{
  "topics": [
    { "id": "topic_...", "subscription": "opt_in" }
  ]
}
```

Use `opt_out` to opt out of one topic. A contact's global `unsubscribed` flag blocks all Marketing email even when a topic is opted in.

A Subscribed to topic trigger starts when effective receipt changes from off to on, not on every preference write. Preference-page opt-ins can start it. A global unsubscribe can start a Contact changes trigger watching `unsubscribed`; a new contact created only to store that unsubscribe does not start Contact added. Deleting a trigger's topic stops matching and prevents enabling the automation until its trigger changes.

Give an ordinary send a `topic_id`, or choose a Topic on an automation send step, to make it Marketing. Dispatch adds one-click unsubscribe headers and fills the template's unsubscribe placeholders with signed, recipient-specific preference links. It rechecks opt-outs at delivery. Broadcasts are Marketing and respect global unsubscribes and any selected topic.

Without a topic, an ordinary send is Transactional and does not use marketing subscription checks. Automation steps store kind explicitly: a Marketing draft without a topic stays Marketing and cannot enable or resume without a live topic. Use that for requested receipts or password resets, not to bypass a person's marketing preference.

Suppressions are separate from subscriptions: manual suppressions, permanent bounces, and complaints can block delivery regardless of topic preference. Open Suppressions from either Audience or Emails, or inspect them through the API.

See [Marketing sending behavior](api/README.md#sending), [templates](templates.md#variables), and [unsubscribe webhooks](webhooks.md).

## App-owned lifecycle state

[Lifecycle recipes](automations/README.md) declare activated (boolean), plan (string), or last_active_at (date) as needed. Your app writes actual values at signup, activation, billing changes and meaningful activity. Payloads do not update properties; installed definitions do not populate state. Preserve consent rather than resetting subscription flags to make a flow run.

## Ask your agent

```text
Help me add and inspect Dispatch contacts while preserving their consent preferences. Use the public documentation for my running Dispatch version and only shipped endpoints and SDK methods. Read DISPATCH_API_URL and DISPATCH_API_KEY from my environment; never print or embed the key. Respect my current permissions and ask for confirmation before sending email, publishing, deleting, or changing live configuration.
```
