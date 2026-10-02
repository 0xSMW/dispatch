import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { collect, many } from "../../../lib/json.js";
import { pickReceived } from "../../../lib/pickers.js";
import { promptMissing } from "../../../lib/prompts.js";

export const forward = new Command("forward")
  .description("Forward a received email to new recipients")
  .argument("[id]", "Received email ID")
  .option("--to <address>", "Recipient. Repeat or comma-separate for several", collect)
  .option("--from <address>", "Sender on one of your domains")
  .addHelpText(
    "after",
    helpText({
      output: '{"id":"email_..."}',
      codes: ["missing_id", "missing_flags", "send_error"],
      examples: ["dispatch emails receiving forward rcv_123 --to team@acme.com --from inbox@acme.com"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      code: "send_error",
      loading: "Forwarding...",
      prepare: async (globals) => {
        const emailId = await pickReceived(id, globals);
        const asked = await promptMissing(
          { to: many(options.to)?.join(","), from: options.from },
          [
            { key: "to", flag: "--to", label: "Forward to" },
            { key: "from", flag: "--from", label: "From" },
          ],
          globals,
        );
        return { emailId, to: many([asked.to])!, from: asked.from };
      },
      call: (api, input) => api.emails.receiving.forward(input),
      done: (sent: { id: string }) => `Forwarded as email ${sent.id}`,
    });
  });
