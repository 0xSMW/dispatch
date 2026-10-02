import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { collect } from "../../../lib/json.js";
import { addresses } from "./emails.js";

export const add = new Command("add")
  .description("Suppress many addresses at once")
  .option("--emails <emails>", "Comma-separated addresses. Repeatable", collect)
  .option("--file <path>", "One address per line, or a JSON array, or - for stdin")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","data":[{"id":"...","email":"..."}]}',
      codes: ["missing_flags", "create_error"],
      examples: [
        "dispatch suppressions batch add --emails a@example.com,b@example.com",
        "dispatch suppressions batch add --file bounced.txt",
      ],
    }),
  )
  .action(async (options, command) => {
    await runWrite(command, {
      code: "create_error",
      prepare: () => addresses(options),
      call: (api, emails) => api.suppressions.batchAdd(emails),
      done: () => "Suppressed",
    });
  });
