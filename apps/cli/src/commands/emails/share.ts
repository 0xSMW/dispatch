import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pickEmail } from "../../lib/pickers.js";

export const share = new Command("share")
  .description("Create a public link to an email's content")
  .argument("[id]", "Email ID")
  .option("--expires-in <duration>", "How long the link lives, such as 24h or 7d")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"email","id":"email_...","url":"https://..."}',
      codes: ["missing_id", "share_error"],
      examples: ["dispatch emails share email_123 --expires-in 7d"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      code: "share_error",
      prepare: (globals) => pickEmail(id, globals),
      call: (api, target) => api.emails.share(target, compact({ expiresIn: options.expiresIn })),
      done: (shared: { url: string }) => shared.url,
    });
  });
