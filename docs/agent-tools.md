# Agent tooling

The API drawer's Agent tab copies the canonical prompt for the current page. Its [llms index](llms.txt) and [full public documentation](llms-full.txt) include only reviewed, Git-tracked public guides, never local plans or security reports. Maintainers regenerate both with `pnpm llms` after public docs change; `pnpm llms --check` checks freshness.

## Local stdio MCP

`@dispatchmail/mcp` wraps the TypeScript Dispatch SDK with the official TypeScript MCP SDK. It runs over stdin/stdout only. There is no hosted MCP service or OAuth marketplace.

Configure your MCP client to start `dispatch-mcp` from an installed `@dispatchmail/mcp` package, with `DISPATCH_API_URL` and `DISPATCH_API_KEY` passed in its environment. Keep the key out of command arguments, prompts and saved logs. Use a key for your own install and permitted resources.

```json
{
  "mcpServers": {
    "dispatch": {
      "command": "dispatch-mcp",
      "args": ["--read-only"]
    }
  }
}
```

The process inherits `DISPATCH_API_URL` (default `http://localhost:3100`) and requires `DISPATCH_API_KEY`. Configure these in the client's secret/environment settings rather than embedding a key in this JSON. The package's executable is built with `pnpm --filter @dispatchmail/mcp build` in a source checkout after dependency setup.

Tools use the shipped TypeScript SDK's camelCase inputs:

| Tool | Main inputs | Effect |
| --- | --- | --- |
| `send_email` | `from`, `to`, `subject`, `html` or `template`, optional `idempotencyKey` | Sends |
| `get_email` | `id` | Reads |
| `list_emails` | optional paging and filters | Reads |
| `send_event` | `event`, exactly one `contactId` or `email`, optional `payload` | Writes |
| `upsert_contact` | `email`, optional `firstName`, `lastName`, `properties` | Writes via `contacts.create` |
| `list_automations` | optional paging and `status` | Reads |
| `install_preset` | `slug`, `from`, optional `name`, `topicId` | Installs disabled |
| `get_metrics` | optional `startDate`, `endDate`, metrics/dimensions and resource filters | Reads |
| `list_templates` | optional paging, `q`, `status` | Reads |
| `render_template` | `idOrAlias`, optional `variables`, `draft` | Reads, despite its API POST |

`--read-only` removes all four write tools from discovery and rejects their direct invocation before any SDK request. There is no arbitrary API-call tool. Ordinary mode, without the flag, permits sends and installation subject to API permissions. SDK failures return explicit MCP errors; HTTP response headers are not tool results.

Sending a transactional email does not require contacts, topics or automations. Installing a lifecycle preset requires a verified sender. Newsletter welcome also requires a live tenant topic; other Marketing presets may install disabled without a topic but cannot be enabled until configured. Review reused templates and the disabled flow before enabling.

## Ask your agent

```text
Help me send a transactional email with Dispatch without requiring contacts, topics, or automations. Use the public documentation for my running Dispatch version and only shipped endpoints and SDK methods. Read DISPATCH_API_URL and DISPATCH_API_KEY from my environment; never print or embed the key. Respect my current permissions and ask for confirmation before sending email, publishing, deleting, or changing live configuration.
```
