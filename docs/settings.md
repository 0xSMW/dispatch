# Settings

Settings apply to one tenant. Read them with `GET /settings` and change supplied keys with `PATCH /settings`. Only full-access users can change them. Viewers can read them.

| Key | Default | Meaning |
|:--|:--|:--|
| `import_trigger_automations` | `false` | The default for starting matching automations during contact imports. Each import can override it. |
| `sandbox_domains` | `[]` | Up to 50 additional recipient hostnames, including their subdomains, whose emails are rendered and stored for testing rather than sent to the provider. |

Changes preserve keys you omit. Set `sandbox_domains` to an empty array to remove your additions. Reserved test domains remain sandbox domains regardless of this setting.

```json
{
  "import_trigger_automations": false,
  "sandbox_domains": ["qa.example.test"]
}
```

The dashboard exposes these settings under Settings, General.

## Sandbox domains

Dispatch always treats `example.com`, `example.net`, `example.org`, and their subdomains, plus domains under `.test`, `.example`, and `.invalid`, as sandbox recipient domains. Your additions follow the same rule in every environment, including production. Matching is case-insensitive and uses hostname boundaries: `qa.acme.com` includes `team.qa.acme.com`, not `notqa.acme.com`.

Sandbox recipients never reach SES or another provider. Emails are accepted, rendered, and stored for inspection. All-sandbox emails have `sandbox: true` and record simulated `email.delivered` events with `data.sandbox: true`, without a real provider message ID. Mixed emails have `sandbox: false`; only real recipients are sent, and the API's `recipients` array identifies sandbox recipients individually. Sandbox events do not count toward real email metrics.

This is not the SES account sandbox. AWS's sandbox restricts real sending until your account receives production access. Dispatch's sandbox-domain rule bypasses the provider even after that access is granted. Do not add a domain whose recipients should receive real email.
