import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pickBroadcast } from "../../lib/pickers.js";

export const send = new Command("send")
  .description("Send a draft broadcast now or at a set time")
  .argument("[id]", "Broadcast ID")
  .option("--scheduled-at <time>", "Send at this time instead of now")
  .addHelpText(
    "after",
    helpText({
      output: '{"id":"..."}',
      codes: ["missing_id", "send_error"],
      examples: ["dispatch broadcasts send bc_123", 'dispatch broadcasts send bc_123 --scheduled-at "tomorrow 9am"'],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      code: "send_error",
      loading: "Sending...",
      prepare: (globals) => pickBroadcast(id, globals),
      call: (api, target) => api.broadcasts.send(target, compact({ scheduledAt: options.scheduledAt })),
      done: (broadcast: { id: string }) => `${options.scheduledAt ? "Scheduled" : "Sending"} broadcast ${broadcast.id}`,
    });
  });
