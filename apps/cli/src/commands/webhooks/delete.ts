import { Command } from "@commander-js/extra-typings";
import { runDelete } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickWebhook } from "../../lib/pickers.js";

export const remove = new Command("delete")
  .alias("rm")
  .description("Delete a webhook")
  .argument("[id]", "Webhook ID")
  .option("--yes", "Skip the confirmation prompt")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"webhook","id":"...","deleted":true}',
      codes: ["missing_id", "confirmation_required", "delete_error"],
      examples: ["dispatch webhooks delete wh_123 --yes"],
    }),
  )
  .action(async (id, _options, command) => {
    await runDelete(command, {
      noun: "webhook",
      id: (globals) => pickWebhook(id, globals),
      call: (api, target) => api.webhooks.remove(target),
    });
  });
