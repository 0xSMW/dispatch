import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../../lib/actions.js";
import { CliError } from "../../../lib/errors.js";
import { helpText } from "../../../lib/help.js";
import { collect, many } from "../../../lib/json.js";
import { confirm } from "../../../lib/prompts.js";
import { addresses } from "./emails.js";

export const remove = new Command("remove")
  .description("Remove many suppressions at once, by email or by ID")
  .option("--emails <emails>", "Comma-separated addresses. Repeatable", collect)
  .option("--ids <ids>", "Comma-separated suppression IDs. Repeatable", collect)
  .option("--file <path>", "One address per line, or a JSON array, or - for stdin")
  .option("--yes", "Skip the confirmation prompt")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","data":[...]}',
      codes: ["missing_flags", "invalid_flags", "confirmation_required", "delete_error"],
      examples: [
        "dispatch suppressions batch remove --emails a@example.com --yes",
        "dispatch suppressions batch remove --ids sup_1,sup_2 --yes",
      ],
    }),
  )
  .action(async (options, command) => {
    await runWrite(command, {
      code: "delete_error",
      prepare: async (globals) => {
        const ids = many(options.ids);
        if (ids && (options.emails || options.file)) throw new CliError("invalid_flags", "Use --ids or --emails/--file, not both");
        const emails = ids ? undefined : await addresses(options);
        await confirm(`Remove ${(ids ?? emails)!.length} suppressions?`, options.yes, globals);
        return ids ? { ids } : { emails: emails! };
      },
      call: (api, input) => api.suppressions.batchRemove(input),
      done: () => "Removed",
    });
  });
