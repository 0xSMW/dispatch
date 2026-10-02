import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../../lib/actions.js";
import { CliError } from "../../../lib/errors.js";
import { helpText } from "../../../lib/help.js";
import { pickReceived } from "../../../lib/pickers.js";

export const attachment = new Command("attachment")
  .description("Show one attachment of a received email")
  .argument("[id]", "Received email ID")
  .argument("[attachmentId]", "Attachment ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"attachment","id":"...","filename":"...","download_url":"..."}',
      codes: ["missing_id", "fetch_error", "not_found"],
      examples: ["dispatch emails receiving attachment rcv_123 att_456"],
    }),
  )
  .action(async (id, attachmentId, _options, command) => {
    await runGet(command, {
      prepare: async (globals) => {
        const emailId = await pickReceived(id, globals);
        if (!attachmentId) throw new CliError("missing_id", "Missing attachment id");
        return { emailId, attachmentId };
      },
      call: (api, target) => api.emails.receiving.attachments.get({ emailId: target.emailId, id: target.attachmentId }),
    });
  });
