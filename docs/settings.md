# Settings

Settings apply to one tenant. Read them with `GET /settings` and change supplied keys with `PATCH /settings`. Only full-access users can change them. Viewers can read them.

| Key | Default | Meaning |
|:--|:--|:--|
| `import_trigger_automations` | `false` | The default for starting matching automations during contact imports. Each import can override it. |
| `sandbox_domains` | `[]` | Up to 50 additional recipient hostnames, including their subdomains, whose emails are rendered and stored for testing rather than sent to the provider. |
| `confirmation_daily_limit` | `500` | Signup confirmation emails per tenant per UTC day. Whole number from 0 to 100000. Zero disables confirmation sends. Per-address/form rolling 24-hour limits still apply. |

Changes preserve keys you omit. Set `sandbox_domains` to an empty array to remove your additions. Reserved test domains remain sandbox domains regardless of this setting.

```json
{
  "import_trigger_automations": false,
  "sandbox_domains": ["qa.example.test"]
}
```

The dashboard exposes these settings under Settings, General.

## Import automations

`import_trigger_automations` defaults to `false`. It supplies the default for a new [contact import](audience.md#start-automations-during-an-import), not a rule applied while the worker processes it.

An import's optional multipart `trigger_automations` boolean overrides the default. Send the field as `true` or `false`; explicit `false` also overrides a tenant default of `true`. Omission resolves and stores the tenant default at import creation. Later settings changes apply to new imports only. Import creation, list entries, and detail responses include the resolved `trigger_automations` boolean.

When enabled, imports can start matching enabled Contact added, Subscribed to topic, and Added to segment automations for actual changes. They do not fire Contact changes. The flag does not create or enable flows, bypass their re-entry rules, or clear opt-outs. Review matching flows before importing: they may send immediately or after their configured waits.

## Sandbox domains

Dispatch always treats `example.com`, `example.net`, `example.org`, and their subdomains, plus domains under `.test`, `.example`, and `.invalid`, as sandbox recipient domains. Your additions follow the same rule in every environment, including production. Matching is case-insensitive and uses hostname boundaries: `qa.acme.com` includes `team.qa.acme.com`, not `notqa.acme.com`.

Sandbox recipients never reach SES or another provider. Emails are accepted, rendered, and stored for inspection. All-sandbox emails have `sandbox: true` and record simulated `email.delivered` events with `data.sandbox: true`, without a real provider message ID. Mixed emails have `sandbox: false`; only real recipients are sent, and the API's `recipients` array identifies sandbox recipients individually. Sandbox events do not count toward real email metrics.

This is not the SES account sandbox. AWS's sandbox restricts real sending until your account receives production access. Dispatch's sandbox-domain rule bypasses the provider even after that access is granted. Do not add a domain whose recipients should receive real email.

## Ask your agent

```text
Help me review Dispatch import-trigger defaults and sandbox domains before changing settings. Use the public documentation for my running Dispatch version and only shipped endpoints and SDK methods. Read DISPATCH_API_URL and DISPATCH_API_KEY from my environment; never print or embed the key. Respect my current permissions and ask for confirmation before sending email, publishing, deleting, or changing live configuration.
```
