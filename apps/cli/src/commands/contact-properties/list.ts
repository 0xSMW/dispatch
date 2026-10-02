import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";

type Property = { id: string; key: string; type: string; fallback_value?: unknown };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List contact properties")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","key":"plan","type":"string","fallback_value":"free"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch contact-properties"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Property>(command, {
      call: (api, page) => api.contactProperties.list(page),
      columns: ["Key", "Type", "Fallback", "ID"],
      row: (property) => [property.key, property.type, property.fallback_value ?? "", property.id],
      empty: "(no contact properties)",
    });
  });
