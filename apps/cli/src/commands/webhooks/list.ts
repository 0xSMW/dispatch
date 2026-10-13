import { listCommand } from "../../lib/commands.js";

type Webhook = { id: string; endpoint: string; events: string[]; status: string; created_at: string };

export const list = listCommand<Webhook>({
  description: "List webhooks",
  output: '{"object":"list","has_more":false,"data":[{"id":"...","endpoint":"https://...","events":["email.sent"],"status":"enabled"}]}',
  examples: ["dispatch webhooks", "dispatch webhooks list --json"],
  call: (api, page) => api.webhooks.list(page),
  columns: ["Endpoint", "Events", "Status", "ID"],
  row: (hook) => [hook.endpoint, (hook.events ?? []).join(", "), hook.status, hook.id],
  empty: "(no webhooks)",
});
