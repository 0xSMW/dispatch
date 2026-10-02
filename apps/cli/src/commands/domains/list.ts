import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";

type Domain = { id: string; name: string; status: string; region: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List domains")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"example.com","status":"verified"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch domains list", "dispatch domains list --limit 25 --json"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Domain>(command, {
      call: (api, page) => api.domains.list(page),
      columns: ["Name", "Status", "Region", "ID"],
      row: (domain) => [domain.name, domain.status, domain.region, domain.id],
      empty: "(no domains)",
    });
  });
