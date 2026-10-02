import { Command, Option } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pageOptions } from "../../lib/pagination.js";

type Suppression = { id: string; email: string; origin?: string; reason?: string; created_at: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List suppressed addresses")
  .addOption(new Option("--origin <origin>", "Only suppressions from this source").choices(["bounce", "complaint", "manual"] as const))
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","email":"gone@example.com","origin":"bounce"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch suppressions", "dispatch suppressions list --origin complaint"],
    }),
  )
  .action(async (options, command) => {
    await runList<Suppression>(command, {
      call: (api, page) => api.suppressions.list({ ...page, ...compact({ origin: options.origin }) }),
      columns: ["Email", "Origin", "Reason", "Created", "ID"],
      row: (item) => [item.email, item.origin ?? "", item.reason ?? "", item.created_at, item.id],
      empty: "(no suppressions)",
    });
  });
