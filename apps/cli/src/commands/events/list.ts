import { listCommand } from "../../lib/commands.js";

type Definition = { id: string; name: string; schema?: Record<string, string> | null; created_at: string };

export const list = listCommand<Definition>({
  description: "List event definitions",
  output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"user.created","schema":{"plan":"string"}}]}',
  examples: ["dispatch events", "dispatch events history"],
  call: (api, page) => api.events.list(page),
  columns: ["Name", "Fields", "Created", "ID"],
  row: (event) => [event.name, Object.keys(event.schema ?? {}).join(", "), event.created_at, event.id],
  empty: "(no events)",
});
