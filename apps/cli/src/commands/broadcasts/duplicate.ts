import { Command } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pickBroadcast } from "../../lib/pickers.js";

export const duplicate = new Command("duplicate")
  .description("Copy a broadcast into a new draft")
  .argument("[id]", "Broadcast ID")
  .option("--name <name>", "Name for the copy")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"broadcast","id":"..."}',
      codes: ["missing_id", "create_error"],
      examples: ["dispatch broadcasts duplicate bc_123"],
    }),
  )
  .action(async (id, options, command) => {
    await runCreate(command, {
      prepare: (globals) => pickBroadcast(id, globals),
      call: (api, target) => api.broadcasts.duplicate(target, compact({ name: options.name })),
      done: (broadcast: { id: string }) => `Duplicated as broadcast ${broadcast.id}`,
    });
  });
