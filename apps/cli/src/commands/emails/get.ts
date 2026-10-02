import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickEmail } from "../../lib/pickers.js";

export const get = new Command("get")
  .description("Show one sent email")
  .argument("[id]", "Email ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"email","id":"email_...","from":"...","to":["..."],"subject":"...","last_event":"delivered"}',
      codes: ["missing_id", "fetch_error", "not_found"],
      examples: ["dispatch emails get email_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runGet(command, {
      prepare: (globals) => pickEmail(id, globals),
      call: (api, target) => api.emails.get(target),
    });
  });
