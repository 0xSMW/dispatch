import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickEmail } from "../../lib/pickers.js";

export const retry = new Command("retry")
  .description("Queue a retry for a failed email (Dispatch only)")
  .argument("[id]", "Email ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"email_job","id":"..."}',
      codes: ["missing_id", "retry_error"],
      examples: ["dispatch emails retry email_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runWrite(command, {
      code: "retry_error",
      prepare: (globals) => pickEmail(id, globals),
      call: (api, target) => api.emails.retry(target),
      done: () => "Retry queued",
    });
  });
