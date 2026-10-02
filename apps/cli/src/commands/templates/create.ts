import { Option } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { CliError } from "../../lib/errors.js";
import { helpText } from "../../lib/help.js";
import { promptMissing } from "../../lib/prompts.js";
import { templateBody, templateCommand } from "./body.js";

export const create = templateCommand("create")
  .description("Create a template as a draft")
  .argument("[name]", "Template name")
  .option("--name <name>", "Template name (same as the positional argument)")
  .option("--alias <alias>", "Stable alias to send by, such as password-reset")
  .addOption(new Option("--variables <keys>", "Comma-separated variable keys (old flag)").hideHelp())
  .option("--publish", "Publish right away")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"template","id":"..."}',
      codes: ["missing_flags", "invalid_flag", "react_email_build_error", "create_error", "validation_error"],
      examples: [
        'dispatch templates create --name Welcome --alias welcome --subject "Hi {{{NAME}}}" --html-file welcome.html --var NAME:string:there',
        "dispatch templates create --name Welcome --react-email emails/welcome.tsx --publish",
      ],
    }),
  )
  .action(async (name, options, command) => {
    await runCreate(command, {
      prepare: async (globals) => {
        const asked = await promptMissing(
          { name: name ?? options.name },
          [{ key: "name", flag: "--name", label: "Template name" }],
          globals,
        );
        const body = await templateBody(options);
        if (!body.html && !body.text) {
          throw new CliError("missing_flags", "Missing required flags: --html, --html-file, --text, --text-file, or --react-email");
        }
        return { name: asked.name, alias: options.alias, ...body, publish: Boolean(options.publish) };
      },
      call: (api, payload) => api.templates.create(payload),
      done: (template: { id: string }) => `Created template ${template.id}${options.publish ? " and published it" : " as a draft"}`,
    });
  });
