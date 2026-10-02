import { Command } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact, jsonFlag } from "../../lib/json.js";
import { promptMissing } from "../../lib/prompts.js";

export const create = new Command("create")
  .description("Define an event and the shape of its payload")
  .argument("[name]", "Event name, such as user.created")
  .option("--name <name>", "Event name (same as the positional argument)")
  .option("--schema <json>", 'Payload fields and types, such as {"plan":"string"}')
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"event","id":"...","name":"user.created"}',
      codes: ["missing_flags", "invalid_json", "create_error"],
      examples: ['dispatch events create --name user.created --schema \'{"plan":"string","seats":"number"}\''],
    }),
  )
  .action(async (name, options, command) => {
    await runCreate(command, {
      prepare: (globals) => promptMissing({ name: name ?? options.name }, [{ key: "name", flag: "--name", label: "Event name" }], globals),
      call: (api, input) =>
        api.events.create({ name: input.name, ...compact({ schema: jsonFlag<Record<string, string>>(options.schema, "--schema") }) }),
      done: (event: { id: string }) => `Created event ${event.id}`,
    });
  });
