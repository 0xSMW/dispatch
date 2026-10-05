# Templates

Store reusable HTML and plain text with a subject, sender, and variables. Send by template ID or alias. Saving changes creates or updates a draft; sends use the published version until you publish again.

Use the dashboard to edit and preview, or write components locally with [React Email](react-email.md). Authentication and billing integration examples are in [the template guides](templates/README.md).

## Transactional or Marketing

The library, template list, and template detail show each template's kind:

- **Transactional** is suitable for receipts, password resets, and other product email that does not depend on Marketing subscriptions.
- **Marketing** is intended for newsletters and lifecycle email that respects opt-outs and carries unsubscribe links and one-click headers.

`GET /templates` and `GET /templates/{id}` return `kind: "transactional" | "marketing"`. It is derived from the library's saved `source.send_kind` or unsubscribe placeholders in the content, not a new field you must set when creating a template. `source.kind` describes provenance, such as `library` or `react-email`; it is not the sending kind.

Editing a Marketing library template keeps its Marketing kind even when its body changes. The edited copy has custom provenance, so preserving its kind does not mark it as an untouched library template.

A Marketing template cannot be used in a Transactional automation step. Choose Marketing and a topic before enabling or resuming the automation. A Marketing draft can wait for its topic while disabled or paused. A Transactional template can be used for Marketing, but include an unsubscribe link in its body; the automation editor warns when it is missing.

Template kind does not add a field to ordinary sends. `POST /emails` and batches still use `topic_id` to select Marketing behavior. Without a topic they remain Transactional, and a template that needs an unsubscribe link cannot render. Broadcasts are always Marketing. See [sending](api/README.md#sending) and [automation send kinds](automations.md#transactional-or-marketing).

## Variables

Placeholders work in the subject, HTML, and plain text:

```html
<p>Hello {{{NAME|there}}},</p>
<p>Your {{{PLAN}}} account is ready.</p>
```

Pass values in the send's template reference:

```json
{
  "from": "Acme <hello@acme.com>",
  "to": "alex@example.com",
  "template": {
    "id": "welcome",
    "variables": { "NAME": "Alex", "PLAN": "starter" }
  }
}
```

`welcome` must be a published alias and the sender domain must be verified. This recipient is a [sandbox address](api/README.md#sandbox-recipients).

Declare custom variables as `string`, `number`, or `list`. Keys are case-sensitive, 1–50 letters, digits, or underscores; built-in names are reserved. A supplied number must be a JSON number, not a numeric string.

For a printed placeholder, Dispatch uses the supplied or context value, then an inline fallback such as `{{{NAME|there}}}`, then the variable's saved `fallback_value`. Missing, null, and empty-string values use fallbacks. Without a value or fallback, rendering fails with `422` and names the missing variable. A placeholder inside an omitted conditional block does not need a value.

The editor detects custom placeholders and lets you configure their type, requirement, and sample. **Required** stores `fallback_value: null`. **Optional** reveals the saved fallback, including an empty string or numeric zero. Switching to Required hides the fallback; switching back during the same editing session restores it. Lists stay fixed Required and have no saved fallback. Samples are for preview and test sends; they are not saved defaults for production sends.

These controls do not change inline fallbacks or conditional rendering. A printed placeholder with an inline fallback can still render without a supplied value even when its saved setting is Required.

Replacement values are HTML-escaped in HTML, even with triple braces; they cannot inject raw HTML. Subject and plain-text replacements are not HTML-escaped.

### Conditional content and lists

```html
{{{#if contact.first_name}}}
<p>Hello {{{contact.first_name}}}.</p>
{{{/if}}}
{{{#unless contact.first_name}}}
<p>Hello there.</p>
{{{/unless}}}

{{{#each ITEMS}}}
<p>{{{name}}}: {{{price}}}</p>
{{{/each}}}
```

`if` includes content for a present value; `unless` includes it otherwise. Missing, null, empty string, `false`, and an empty array count as absent; `0` counts as present. Blocks may nest and must close correctly before publication.

A declared list accepts an array of objects whose field values are strings or numbers, for example `"ITEMS": [{"name": "Widget", "price": 12}]`. Within `each`, use the item's field name directly. Rendering repeats at most 200 items.

### Contact and event values

Broadcasts and automation sends supply recipient values under `contact.*`, including custom properties, plus `FIRST_NAME`, `LAST_NAME`, and `EMAIL`. Automation sends also supply the triggering payload as top-level variables and under `event.*`; explicit step variables override payload values.

Ordinary `POST /emails` calls do not automatically look up a contact. Pass the values your template needs. Broadcasts render missing contact fields as blanks; ordinary sends and automation sends fail on an unresolved printed field. Use an inline fallback or `if` for names that may be missing.

Marketing sends supply `UNSUBSCRIBE_URL`, `RESEND_UNSUBSCRIBE_URL`, and `DISPATCH_UNSUBSCRIBE_URL`. Put one in your footer, for example `<a href="{{{UNSUBSCRIBE_URL}}}">Manage preferences</a>`. These are signed per-recipient links, not caller-provided values. A template printing one needs `topic_id` for an ordinary or automation send. See [topics](audience.md#topics) and [sending](api/README.md#sending).

## Visual editor

The HTML tab has Code and Visual modes sharing the same saved HTML. Plain text is edited separately.

Visual mode opens an empty template or HTML it previously produced and can reproduce unchanged. Hand-written or React Email HTML may need a confirmed conversion. Conversion rebuilds the layout on your first edit and can lose formatting such as colors, widths, and backgrounds.

If opening the content would lose placeholders, links, images, or unsupported content, Visual mode refuses it. Keep that template in Code mode instead. Switching modes is not permission to silently rewrite your source.

Place the cursor in a visible placeholder to open its side panel. Name changes only that occurrence; Required/Optional and the saved fallback use the same settings as the variable table. **List item** shows whether the placeholder reads a field inside an `each` block. Its scope comes from the block, not a separate stored flag. For an item field, Optional edits that occurrence's inline fallback instead of declaring a global variable. Edit block boundaries and attribute placeholders (such as link URLs) in Code mode. Selecting a placeholder alone never rewrites the HTML.

An item field keeps its hidden fallback when you dismiss and reopen the panel in the same visual document. Repeated fields keep separate fallbacks, including after nearby text edits or renaming a field. Loading a replacement document clears hidden item defaults. Inline defaults are literal text: `R&D`, `<em>plain</em>`, and `&amp;` keep those exact values after saving and reloading. Dispatch escapes them when rendering, so they do not become markup.

Image-file uploads, pastes, and drops are not supported. Add an image URL in Code mode. Preview with real sample values and send a test before publishing.

## Brand

Brand settings are shared across the tenant and filled when a template is rendered or sent. Updating Brand affects future renders without republishing templates; it does not rewrite already queued email content.

| Placeholder | Value |
|:---|:---|
| `PRODUCT_NAME` | Product name, falling back to the tenant name. |
| `PRODUCT_URL` | Product URL, falling back to `https://` plus the tenant's stored domain, or blank. |
| `LOGO_URL` | Logo URL, or blank. |
| `BRAND_COLOR` | Six-digit hex color, default `#18181b`. |
| `BRAND_TEXT_COLOR` | Black or white, whichever has better contrast against Brand color. |
| `SUPPORT_EMAIL` | Support email, falling back to the sender address, or blank. |
| `SUPPORT_URL`, `PRIVACY_URL` | Configured URLs, or blank. |
| `COMPANY_NAME` | Company name, falling back to Product name. |
| `COMPANY_ADDRESS` | Company address, or blank. |
| `CURRENT_YEAR` | Current year. |

Reference them with placeholders such as `{{{PRODUCT_NAME}}}` and `{{{BRAND_COLOR}}}`; do not declare them as custom variables. Brand URL settings require HTTPS. Optional blank values used as printed placeholders need a fallback or conditional block, for example `{{{#if LOGO_URL}}}<img src="{{{LOGO_URL}}}" alt="Logo">{{{/if}}}`.

Brand also sets the heading and description on the public unsubscribe page. It does not set a static unsubscribe URL: Marketing links are generated for each recipient.

Brand is available through `GET /brand` and `PATCH /brand`. See [the API reference](api/README.md#routes) and [React Email's brand prop](react-email.md#brand-values).

## Lifecycle library

[Lifecycle recipes](automations/README.md) install an entire disabled flow. Library partitions by stage first, so staged Transactional onboarding and billing templates also appear under Lifecycle. Missing copies are created published; reused edited/draft aliases are never overwritten or auto-published. Inspect variables, kind and publication before enabling. Edit shared [Brand](#brand) values without rewriting content.

## Ask your agent

```text
Help me create a reusable Dispatch email template and declare its required variables and optional fallbacks. Use the public documentation for my running Dispatch version and only shipped endpoints and SDK methods. Read DISPATCH_API_URL and DISPATCH_API_KEY from my environment; never print or embed the key. Respect my current permissions and ask for confirmation before sending email, publishing, deleting, or changing live configuration.
```
