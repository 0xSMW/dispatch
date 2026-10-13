import { listCommand } from "../../lib/commands.js";

type Domain = { id: string; name: string; status: string; region: string };

export const list = listCommand<Domain>({
  description: "List domains",
  output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"example.com","status":"verified"}]}',
  examples: ["dispatch domains list", "dispatch domains list --limit 25 --json"],
  call: (api, page) => api.domains.list(page),
  columns: ["Name", "Status", "Region", "ID"],
  row: (domain) => [domain.name, domain.status, domain.region, domain.id],
  empty: "(no domains)",
});
