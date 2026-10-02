import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";

type Broadcast = {
  id: string;
  name?: string | null;
  status: string;
  segment_id?: string | null;
  scheduled_at?: string | null;
  created_at: string;
};

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List broadcasts")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"October news","status":"draft"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch broadcasts", "dispatch broadcasts list --json"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Broadcast>(command, {
      call: (api, page) => api.broadcasts.list(page),
      columns: ["Name", "Status", "Segment", "Scheduled", "ID"],
      row: (item) => [item.name ?? "", item.status, item.segment_id ?? "", item.scheduled_at ?? "", item.id],
      empty: "(no broadcasts)",
    });
  });
