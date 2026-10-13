import { listCommand } from "../../lib/commands.js";

type Segment = { id: string; name: string; description?: string | null; created_at: string };

export const list = listCommand<Segment>({
  description: "List segments",
  output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Customers"}]}',
  examples: ["dispatch segments"],
  call: (api, page) => api.segments.list(page),
  columns: ["Name", "Description", "Created", "ID"],
  row: (segment) => [segment.name, segment.description ?? "", segment.created_at, segment.id],
  empty: "(no segments)",
});
