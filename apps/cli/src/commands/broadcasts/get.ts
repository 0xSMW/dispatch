import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickBroadcast } from "../../lib/pickers.js";

export const get = new Command("get")
  .description("Show a broadcast")
  .argument("[id]", "Broadcast ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"broadcast","id":"...","name":"...","status":"sent"}',
      codes: ["missing_id", "fetch_error", "not_found"],
      examples: ["dispatch broadcasts get bc_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runGet(command, {
      prepare: (globals) => pickBroadcast(id, globals),
      call: (api, target) => api.broadcasts.get(target),
    });
  });
