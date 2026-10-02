import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { pickAutomation } from "../../../lib/pickers.js";
import { pick } from "../../../lib/prompts.js";
import type { Run } from "./list.js";

export const get = new Command("get")
  .description("Show one automation run with its step results")
  .argument("[automationId]", "Automation ID")
  .argument("[runId]", "Run ID")
  .option("--automation-id <id>", "Automation ID (same as the first argument)")
  .option("--run-id <id>", "Run ID (same as the second argument)")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"automation_run","id":"...","status":"completed","steps":[...]}',
      codes: ["missing_id", "fetch_error", "not_found"],
      examples: [
        "dispatch automations runs get --automation-id auto_123 --run-id run_456",
        "dispatch automations runs get auto_123 run_456",
      ],
    }),
  )
  .action(async (automationId, runId, options, command) => {
    await runGet(command, {
      prepare: async (globals) => {
        const automation = await pickAutomation(automationId ?? options.automationId, globals);
        const run = await pick<Run>(runId ?? options.runId, {
          globals,
          noun: "run",
          list: (api) => api.automations.runs.list(automation, { limit: 100 }),
          label: (item) => `${item.status} ${item.created_at}`,
        });
        return { automation, run };
      },
      call: (api, target) => api.automations.runs.get(target.automation, target.run),
    });
  });
