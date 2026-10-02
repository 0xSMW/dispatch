import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickApiKey } from "../../lib/pickers.js";
import { promptMissing } from "../../lib/prompts.js";

export const update = new Command("update")
  .description("Rename an API key")
  .argument("[id]", "API key ID")
  .option("--name <name>", "New name")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"api_key","id":"..."}',
      codes: ["missing_id", "missing_flags", "update_error"],
      examples: ["dispatch api-keys update key_123 --name Staging"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: async (globals) => {
        const target = await pickApiKey(id, globals);
        const { name } = await promptMissing({ name: options.name }, [{ key: "name", flag: "--name", label: "New name" }], globals);
        return { target, name };
      },
      call: (api, input) => api.apiKeys.update(input.target, { name: input.name }),
      done: (key: { id: string }) => `Updated API key ${key.id}`,
    });
  });
