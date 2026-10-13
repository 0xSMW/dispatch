import { listCommand } from "../../lib/commands.js";

type Template = {
  id: string;
  name: string;
  alias?: string | null;
  status?: string;
  published_at?: string | null;
  updated_at?: string;
  created_at: string;
};

export const list = listCommand<Template>({
  description: "List templates",
  output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Welcome","alias":"welcome","status":"published"}]}',
  examples: ["dispatch templates", "dispatch templates list --limit 50"],
  call: (api, page) => api.templates.list(page),
  columns: ["Name", "Alias", "Status", "Updated", "ID"],
  row: (template) => [
    template.name,
    template.alias ?? "",
    template.status ?? "",
    template.updated_at ?? template.created_at,
    template.id,
  ],
  empty: "(no templates)",
});
