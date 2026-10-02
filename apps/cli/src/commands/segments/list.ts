import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";

type Segment = { id: string; name: string; description?: string | null; created_at: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List segments")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Customers"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch segments"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Segment>(command, {
      call: (api, page) => api.segments.list(page),
      columns: ["Name", "Description", "Created", "ID"],
      row: (segment) => [segment.name, segment.description ?? "", segment.created_at, segment.id],
      empty: "(no segments)",
    });
  });
