import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";

type Definition = { id: string; name: string; schema?: Record<string, string> | null; created_at: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List event definitions")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"user.created","schema":{"plan":"string"}}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch events", "dispatch events history"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Definition>(command, {
      call: (api, page) => api.events.list(page),
      columns: ["Name", "Fields", "Created", "ID"],
      row: (event) => [event.name, Object.keys(event.schema ?? {}).join(", "), event.created_at, event.id],
      empty: "(no events)",
    });
  });
