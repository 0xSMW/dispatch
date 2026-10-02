import { Command } from "@commander-js/extra-typings";
import { runDelete } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickApiKey } from "../../lib/pickers.js";

export const remove = new Command("delete")
  .alias("rm")
  .description("Revoke an API key")
  .argument("[id]", "API key ID")
  .option("--yes", "Skip the confirmation prompt")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"api_key","id":"...","deleted":true}',
      codes: ["missing_id", "confirmation_required", "delete_error"],
      examples: ["dispatch api-keys delete key_123 --yes"],
    }),
  )
  .action(async (id, _options, command) => {
    await runDelete(command, {
      noun: "API key",
      id: (globals) => pickApiKey(id, globals),
      call: (api, target) => api.apiKeys.remove(target),
    });
  });
