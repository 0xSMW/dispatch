import { Command } from "@commander-js/extra-typings";
import { runDelete } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickTemplate } from "../../lib/pickers.js";

export const remove = new Command("delete")
  .alias("rm")
  .description("Delete a template")
  .argument("[id]", "Template ID or alias")
  .option("--yes", "Skip the confirmation prompt")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"template","id":"...","deleted":true}',
      codes: ["missing_id", "confirmation_required", "delete_error"],
      examples: ["dispatch templates delete welcome --yes"],
    }),
  )
  .action(async (id, _options, command) => {
    await runDelete(command, {
      noun: "template",
      id: (globals) => pickTemplate(id, globals),
      call: (api, target) => api.templates.remove(target),
    });
  });
