import { Command } from "@commander-js/extra-typings";
import { runList } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { compact } from "../../../lib/json.js";
import { pageOptions } from "../../../lib/pagination.js";
import { pickAutomation } from "../../../lib/pickers.js";

export type Run = { id: string; status: string; contact_id?: string | null; email?: string | null; created_at: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List an automation's runs")
  .argument("[automationId]", "Automation ID")
  .option("--status <status>", "Only runs in this state")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","status":"completed"}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch automations runs auto_123", "dispatch automations runs list auto_123 --status failed"],
    }),
  )
  .action(async (automationId, options, command) => {
    await runList<Run, string>(command, {
      prepare: (globals) => pickAutomation(automationId, globals),
      call: (api, page, target) => api.automations.runs.list(target, { ...page, ...compact({ status: options.status }) }),
      columns: ["Status", "Contact", "Started", "ID"],
      row: (run) => [run.status, run.email ?? run.contact_id ?? "", run.created_at, run.id],
      empty: "(no runs)",
    });
  });
