import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickBroadcast } from "../../lib/pickers.js";
import { broadcastBody, broadcastCommand } from "./body.js";

export const update = broadcastCommand("update")
  .description("Edit a draft broadcast")
  .argument("[id]", "Broadcast ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"id":"..."}',
      codes: ["missing_id", "react_email_build_error", "update_error", "validation_error"],
      examples: [
        'dispatch broadcasts update bc_123 --subject "New subject"',
        "dispatch broadcasts update bc_123 --react-email emails/news.tsx",
      ],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: async (globals) => ({ target: await pickBroadcast(id, globals), payload: await broadcastBody(options) }),
      call: (api, input) => api.broadcasts.update(input.target, input.payload),
      done: (broadcast: { id: string }) => `Updated broadcast ${broadcast.id}`,
    });
  });
