import { listCommand } from "../../lib/commands.js";

type Topic = { id: string; name: string; key?: string; default_subscription?: string; visibility?: string };

export const list = listCommand<Topic>({
  description: "List topics",
  output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Product updates","default_subscription":"opt_in"}]}',
  examples: ["dispatch topics"],
  call: (api, page) => api.topics.list(page),
  columns: ["Name", "Key", "Default", "Visibility", "ID"],
  row: (topic) => [topic.name, topic.key ?? "", topic.default_subscription ?? "", topic.visibility ?? "", topic.id],
  empty: "(no topics)",
});
