import { listCommand } from "../../lib/commands.js";

type Broadcast = {
  id: string;
  name?: string | null;
  status: string;
  segment_id?: string | null;
  scheduled_at?: string | null;
  created_at: string;
};

export const list = listCommand<Broadcast>({
  description: "List broadcasts",
  output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"October news","status":"draft"}]}',
  examples: ["dispatch broadcasts", "dispatch broadcasts list --json"],
  call: (api, page) => api.broadcasts.list(page),
  columns: ["Name", "Status", "Segment", "Scheduled", "ID"],
  row: (item) => [item.name ?? "", item.status, item.segment_id ?? "", item.scheduled_at ?? "", item.id],
  empty: "(no broadcasts)",
});
