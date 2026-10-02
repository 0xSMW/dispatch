import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { jsonFlag } from "../../lib/json.js";
import { pickEvent } from "../../lib/pickers.js";
import { promptMissing } from "../../lib/prompts.js";

export const update = new Command("update")
  .description("Change an event's payload schema")
  .argument("[id]", "Event ID or name")
  .option("--schema <json>", 'Payload fields and types, such as {"plan":"string"}')
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"event","id":"..."}',
      codes: ["missing_id", "missing_flags", "invalid_json", "update_error"],
      examples: ['dispatch events update user.created --schema \'{"plan":"string"}\''],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: async (globals) => {
        const target = await pickEvent(id, globals);
        const { schema } = await promptMissing(
          { schema: options.schema },
          [{ key: "schema", flag: "--schema", label: "Schema (JSON)" }],
          globals,
        );
        return { target, schema: jsonFlag<Record<string, string>>(schema, "--schema")! };
      },
      call: (api, input) => api.events.update(input.target, { schema: input.schema }),
      done: (event: { id: string }) => `Updated event ${event.id}`,
    });
  });
