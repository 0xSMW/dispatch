import { Command } from "@commander-js/extra-typings";
import { runList } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pageOptions } from "../../lib/pagination.js";

type Automation = { id: string; name: string; status?: string; enabled?: boolean; trigger?: string; created_at: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List automations")
  .option("--status <status>", "Only automations in this state, such as enabled")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","name":"Onboarding","status":"enabled"}]}',
      codes: ["invalid_limit", "invalid_pagination", "list_error"],
      examples: ["dispatch automations", "dispatch automations list --status enabled"],
    }),
  )
  .action(async (options, command) => {
    await runList<Automation>(command, {
      call: (api, page) => api.automations.list({ ...page, ...compact({ status: options.status }) }),
      columns: ["Name", "Status", "Trigger", "Created", "ID"],
      row: (item) => [item.name, item.status ?? (item.enabled ? "enabled" : "disabled"), item.trigger ?? "", item.created_at, item.id],
      empty: "(no automations)",
    });
  });
