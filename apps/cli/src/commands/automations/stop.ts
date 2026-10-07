import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickAutomation } from "../../lib/pickers.js";
import { confirm } from "../../lib/prompts.js";

export const stop = new Command("stop")
  .description("Disable an automation and stop its active runs")
  .argument("[id]", "Automation ID")
  .option("--yes", "Skip the confirmation prompt")
  .option("--reset-reentry", "Allow contacts to enter again after the automation is re-enabled")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"automation","id":"..."}',
      codes: ["missing_id", "confirmation_required", "stop_error"],
      examples: ["dispatch automations stop auto_123 --yes"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      code: "stop_error",
      prepare: async (globals) => {
        const target = await pickAutomation(id, globals);
        await confirm(`Stop automation ${target} and its active runs?`, options.yes, globals);
        return target;
      },
      call: (api, target) => options.resetReentry
        ? api.automations.stop(target, { resetReentry: true })
        : api.automations.stop(target),
      done: (automation: { id: string }) => `Stopped automation ${automation.id}`,
    });
  });
