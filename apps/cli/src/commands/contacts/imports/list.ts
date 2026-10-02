import { Command } from "@commander-js/extra-typings";
import { runList } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { compact } from "../../../lib/json.js";
import { pageOptions } from "../../../lib/pagination.js";

type Import = { id: string; status: string; filename?: string | null; created_at: string; imported?: number; failed?: number };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List contact imports")
  .option("--status <status>", "Only imports in this state")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","status":"completed"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch contacts imports"],
    }),
  )
  .action(async (options, command) => {
    await runList<Import>(command, {
      call: (api, page) => api.contacts.imports.list({ ...page, ...compact({ status: options.status }) }),
      columns: ["File", "Status", "Imported", "Failed", "Created", "ID"],
      row: (item) => [item.filename ?? "", item.status, item.imported ?? "", item.failed ?? "", item.created_at, item.id],
      empty: "(no imports)",
    });
  });
