import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";

type Key = { id: string; name: string; permission?: string; scope?: string; created_at: string; last_used_at?: string | null };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List API keys")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Production","created_at":"..."}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch api-keys", "dispatch api-keys list --json"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Key>(command, {
      call: (api, page) => api.apiKeys.list(page),
      columns: ["Name", "Permission", "Created", "Last used", "ID"],
      row: (key) => [key.name, key.permission ?? key.scope ?? "", key.created_at, key.last_used_at ?? "", key.id],
      empty: "(no API keys)",
    });
  });
