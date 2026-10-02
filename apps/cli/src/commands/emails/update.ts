import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { read } from "../../lib/files.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pickEmail } from "../../lib/pickers.js";

export const update = new Command("update")
  .description("Reschedule a scheduled email, or edit a queued email's content")
  .argument("[id]", "Email ID")
  .option("--scheduled-at <time>", "New send time")
  .option("--subject <subject>", "New subject")
  .option("--html <html>", "New HTML body")
  .option("--html-file <path>", "Read the new HTML body from a file, or - for stdin")
  .option("--text <text>", "New plain-text body")
  .option("--text-file <path>", "Read the new plain-text body from a file, or - for stdin")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"email","id":"email_..."}',
      codes: ["missing_id", "update_error", "validation_error"],
      examples: ['dispatch emails update email_123 --scheduled-at "2026-10-02T09:00:00Z"'],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: (globals) => pickEmail(id, globals),
      call: async (api, target) =>
        api.emails.update({
          id: target,
          ...compact({
            scheduledAt: options.scheduledAt,
            subject: options.subject,
            html: options.htmlFile ? await read(options.htmlFile) : options.html,
            text: options.textFile ? await read(options.textFile) : options.text,
          }),
        }),
      done: (email: { id: string }) => `Updated email ${email.id}`,
    });
  });
