import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";
import { pickBroadcast } from "../../lib/pickers.js";

type Link = { id?: string; url: string; clicks?: number; unique_clicks?: number };

export const clickedLinks = pageOptions(new Command("clicked-links"))
  .description("List the links clicked in a broadcast")
  .argument("[id]", "Broadcast ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"url":"https://...","clicks":12}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch broadcasts clicked-links bc_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runList<Link, string>(command, {
      prepare: (globals) => pickBroadcast(id, globals),
      call: (api, page, target) => api.broadcasts.clickedLinks(target, page),
      columns: ["URL", "Clicks", "Unique"],
      row: (link) => [link.url, link.clicks ?? "", link.unique_clicks ?? ""],
      empty: "(no clicks)",
      cursor: (link) => link.id ?? link.url,
    });
  });
