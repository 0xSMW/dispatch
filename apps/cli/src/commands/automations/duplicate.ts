import { Command } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickAutomation } from "../../lib/pickers.js";

export const duplicate = new Command("duplicate")
  .description("Copy an automation, disabled")
  .argument("[id]", "Automation ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"automation","id":"..."}',
      codes: ["missing_id", "create_error"],
      examples: ["dispatch automations duplicate auto_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runCreate(command, {
      prepare: (globals) => pickAutomation(id, globals),
      call: (api, target) => api.automations.duplicate(target),
      done: (automation: { id: string }) => `Duplicated as automation ${automation.id}`,
    });
  });
