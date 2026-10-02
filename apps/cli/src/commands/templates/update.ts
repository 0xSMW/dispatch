import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact } from "../../lib/json.js";
import { pickTemplate } from "../../lib/pickers.js";
import { templateBody, templateCommand } from "./body.js";

export const update = templateCommand("update")
  .description("Update a template. Content changes go into the latest draft, or a new draft when the latest version is published")
  .argument("[id]", "Template ID or alias")
  .option("--name <name>", "New name")
  .option("--alias <alias>", "New alias")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"template","id":"..."}',
      codes: ["missing_id", "react_email_build_error", "update_error", "validation_error"],
      examples: [
        "dispatch templates update welcome --html-file welcome.html",
        "dispatch templates update welcome --react-email emails/welcome.tsx",
      ],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: async (globals) => ({
        target: await pickTemplate(id, globals),
        payload: { ...compact({ name: options.name, alias: options.alias }), ...(await templateBody(options)) },
      }),
      call: (api, input) => api.templates.update(input.target, input.payload),
      done: (template: { id: string }) => `Updated template ${template.id}`,
    });
  });
