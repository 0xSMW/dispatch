import { listCommand } from "../../lib/commands.js";

type Key = { id: string; name: string; permission?: string; scope?: string; created_at: string; last_used_at?: string | null };

export const list = listCommand<Key>({
  description: "List API keys",
  output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Production","created_at":"..."}]}',
  examples: ["dispatch api-keys", "dispatch api-keys list --json"],
  call: (api, page) => api.apiKeys.list(page),
  columns: ["Name", "Permission", "Created", "Last used", "ID"],
  row: (key) => [key.name, key.permission ?? key.scope ?? "", key.created_at, key.last_used_at ?? "", key.id],
  empty: "(no API keys)",
});
