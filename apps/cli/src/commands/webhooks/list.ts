import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pageOptions } from "../../lib/pagination.js";

type Webhook = { id: string; endpoint: string; events: string[]; status: string; created_at: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List webhooks")
  .addHelpText(
    "after",
    helpText({
      output:
        '{"object":"list","has_more":false,"data":[{"id":"...","endpoint":"https://...","events":["email.sent"],"status":"enabled"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch webhooks", "dispatch webhooks list --json"],
    }),
  )
  .action(async (_options, command) => {
    await runList<Webhook>(command, {
      call: (api, page) => api.webhooks.list(page),
      columns: ["Endpoint", "Events", "Status", "ID"],
      row: (hook) => [hook.endpoint, (hook.events ?? []).join(", "), hook.status, hook.id],
      empty: "(no webhooks)",
    });
  });
