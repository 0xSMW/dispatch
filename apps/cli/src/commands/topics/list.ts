import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";

type Topic = { id: string; name: string; key?: string; default_subscription?: string; visibility?: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List topics")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Product updates","default_subscription":"opt_in"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch topics"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Topic>(command, {
      call: (api, page) => api.topics.list(page),
      columns: ["Name", "Key", "Default", "Visibility", "ID"],
      row: (topic) => [topic.name, topic.key ?? "", topic.default_subscription ?? "", topic.visibility ?? "", topic.id],
      empty: "(no topics)",
    });
  });
