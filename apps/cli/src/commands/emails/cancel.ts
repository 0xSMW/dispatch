import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickEmail } from "../../lib/pickers.js";

export const cancel = new Command("cancel")
  .description("Cancel a scheduled email")
  .argument("[id]", "Email ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"email","id":"email_..."}',
      codes: ["missing_id", "cancel_error", "not_found"],
      examples: ["dispatch emails cancel email_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runWrite(command, {
      code: "cancel_error",
      prepare: (globals) => pickEmail(id, globals),
      call: (api, target) => api.emails.cancel(target),
      done: (email: { id: string }) => `Canceled email ${email.id}`,
    });
  });
