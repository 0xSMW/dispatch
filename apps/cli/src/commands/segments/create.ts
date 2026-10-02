import { Command } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { promptMissing } from "../../lib/prompts.js";

export const create = new Command("create")
  .description("Create a segment")
  .argument("[name]", "Segment name")
  .option("--name <name>", "Segment name (same as the positional argument)")
  .option("--description <text>", "Description")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"segment","id":"..."}',
      codes: ["missing_flags", "create_error"],
      examples: ['dispatch segments create --name Customers --description "Paying accounts"'],
    }),
  )
  .action(async (name, options, command) => {
    await runCreate(command, {
      prepare: (globals) =>
        promptMissing({ name: name ?? options.name }, [{ key: "name", flag: "--name", label: "Segment name" }], globals),
      call: (api, input) => api.segments.create({ name: input.name, ...compact({ description: options.description }) }),
      done: (segment: { id: string }) => `Created segment ${segment.id}`,
    });
  });
