# Audience

Audience holds contacts, custom properties, static segments, and topic preferences. None is required to send a transactional email.

Contacts are identified by email, matched case-insensitively. Create them through the dashboard, the contact API, or a CSV import. [Firing an event](automations.md#triggers) with a new email address also creates a contact.

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

## Segments

Segments are static lists. Membership changes when you add or remove a contact, not when the contact's properties change.

Create a segment under Audience → Segments, then manage members from the segment or contact page. The API supports:

- `POST /segments` with `{ "name": "Trial users" }`.
- `POST /segments/{id}/contacts` with `{ "email": "alex@example.com" }` (creates the contact if needed).
- `DELETE /segments/{id}/contacts/{contact_id}`.

An automation's Add to segment step can add its contact. Adding an existing member does not create duplicate membership.

Use a segment to choose a broadcast's audience. Being in a segment is not permission to receive Marketing email: global unsubscribes, topic preferences, and suppressions still apply. Deleting a contact removes its segment memberships.

There are no rule-based dynamic segments in the current release.

## Topics

Topics describe categories of Marketing email, such as Product updates or Newsletters. They are preferences, not audience lists.

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

Give an ordinary send a `topic_id`, or choose a Topic on an automation send step, to make it Marketing. Dispatch adds one-click unsubscribe headers and fills the template's unsubscribe placeholders with signed, recipient-specific preference links. It rechecks opt-outs at delivery. Broadcasts are Marketing and respect global unsubscribes and any selected topic.

Without a topic, an ordinary or automation send is Transactional and does not use marketing subscription checks. Use that for requested receipts or password resets, not to bypass a person's marketing preference.

Suppressions are separate from subscriptions: manual suppressions, permanent bounces, and complaints can block delivery regardless of topic preference. Open Suppressions from either Audience or Emails, or inspect them through the API.

See [Marketing sending behavior](api/README.md#sending), [templates](templates.md#variables), and [unsubscribe webhooks](webhooks.md).
