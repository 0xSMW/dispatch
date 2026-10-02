import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pickSegment } from "../../lib/pickers.js";

export const update = new Command("update")
  .description("Rename or describe a segment")
  .argument("[id]", "Segment ID")
  .option("--name <name>", "New name")
  .option("--description <text>", "New description")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"segment","id":"..."}',
      codes: ["missing_id", "update_error"],
      examples: ["dispatch segments update seg_123 --name VIPs"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: (globals) => pickSegment(id, globals),
      call: (api, target) => api.segments.update(target, compact({ name: options.name, description: options.description })),
      done: (segment: { id: string }) => `Updated segment ${segment.id}`,
    });
  });
