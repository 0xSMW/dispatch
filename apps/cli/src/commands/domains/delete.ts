import { Command } from "@commander-js/extra-typings";
import { runDelete } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickDomain } from "../../lib/pickers.js";

export const remove = new Command("delete")
  .alias("rm")
  .description("Delete a domain")
  .argument("[id]", "Domain ID")
  .option("--yes", "Skip the confirmation prompt")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"domain","id":"...","deleted":true}',
      codes: ["missing_id", "confirmation_required", "delete_error"],
      examples: ["dispatch domains delete domain_123 --yes"],
    }),
  )
  .action(async (id, _options, command) => {
    await runDelete(command, {
      noun: "domain",
      id: (globals) => pickDomain(id, globals),
      call: (api, target) => api.domains.remove(target),
    });
  });
