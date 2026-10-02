import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickTemplate } from "../../lib/pickers.js";

export const get = new Command("get")
  .description("Show a template by ID or alias")
  .argument("[id]", "Template ID or alias")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"template","id":"...","name":"...","alias":"...","html":"..."}',
      codes: ["missing_id", "fetch_error", "not_found"],
      examples: ["dispatch templates get password-reset"],
    }),
  )
  .action(async (id, _options, command) => {
    await runGet(command, {
      prepare: (globals) => pickTemplate(id, globals),
      call: (api, target) => api.templates.get(target),
    });
  });
