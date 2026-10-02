import { Command } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pickTemplate } from "../../lib/pickers.js";

export const duplicate = new Command("duplicate")
  .description("Copy a template into a new draft")
  .argument("[id]", "Template ID or alias")
  .option("--name <name>", "Name for the copy")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"template","id":"..."}',
      codes: ["missing_id", "create_error"],
      examples: ['dispatch templates duplicate welcome --name "Welcome v2"'],
    }),
  )
  .action(async (id, options, command) => {
    await runCreate(command, {
      prepare: (globals) => pickTemplate(id, globals),
      call: (api, target) => api.templates.duplicate(target, compact({ name: options.name })),
      done: (template: { id: string }) => `Duplicated as template ${template.id}`,
    });
  });
