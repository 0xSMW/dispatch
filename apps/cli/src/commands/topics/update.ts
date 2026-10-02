import { Command, Option } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pickTopic } from "../../lib/pickers.js";

export const update = new Command("update")
  .description("Change a topic's name, description, or visibility")
  .argument("[id]", "Topic ID")
  .option("--name <name>", "New name")
  .option("--description <text>", "New description")
  .addOption(new Option("--visibility <visibility>", "Show on the preference page").choices(["public", "private"] as const))
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"topic","id":"..."}',
      codes: ["missing_id", "update_error"],
      examples: ["dispatch topics update top_123 --visibility private"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: (globals) => pickTopic(id, globals),
      call: (api, target) =>
        api.topics.update({
          id: target,
          ...compact({ name: options.name, description: options.description, visibility: options.visibility }),
        }),
      done: (topic: { id: string }) => `Updated topic ${topic.id}`,
    });
  });
