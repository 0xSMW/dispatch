# Settings

Settings apply to one tenant. Read them with `GET /settings` and change supplied keys with `PATCH /settings`. Only full-access users can change them. Viewers can read them.

| Key | Default | Meaning |
|:--|:--|:--|
| `import_trigger_automations` | `false` | The default for starting matching automations during contact imports. Each import can override it. |
| `sandbox_domains` | `[]` | Up to 50 additional hostnames whose emails are stored for testing rather than sent to SES. |

Changes preserve keys you omit. Set `sandbox_domains` to an empty array to remove your additions. Reserved test domains remain sandbox domains regardless of this setting.

```json
{
  "import_trigger_automations": false,
  "sandbox_domains": ["qa.example.test"]
}
```

The dashboard exposes these settings under Settings, General. Import execution and sandbox delivery use them once those capabilities are installed.
