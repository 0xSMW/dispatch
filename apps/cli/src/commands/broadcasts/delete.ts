import { Command } from "@commander-js/extra-typings";
import { runDelete } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickBroadcast } from "../../lib/pickers.js";

export const remove = new Command("delete")
  .alias("rm")
  .description("Delete a draft broadcast")
  .argument("[id]", "Broadcast ID")
  .option("--yes", "Skip the confirmation prompt")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"broadcast","id":"...","deleted":true}',
      codes: ["missing_id", "confirmation_required", "delete_error"],
      examples: ["dispatch broadcasts delete bc_123 --yes"],
    }),
  )
  .action(async (id, _options, command) => {
    await runDelete(command, {
      noun: "broadcast",
      id: (globals) => pickBroadcast(id, globals),
      call: (api, target) => api.broadcasts.remove(target),
    });
  });
