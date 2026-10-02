import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";

type Template = {
  id: string;
  name: string;
  alias?: string | null;
  status?: string;
  published_at?: string | null;
  updated_at?: string;
  created_at: string;
};

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List templates")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Welcome","alias":"welcome","status":"published"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch templates", "dispatch templates list --limit 50"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Template>(command, {
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
  });
