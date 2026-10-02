import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { collect, jsonFlag, pairs } from "../../lib/json.js";
import { pickTemplate } from "../../lib/pickers.js";
import { safe } from "../../lib/safe.js";

// Template content is written by teammates. Control characters are removed before it reaches
// the terminal, and line breaks and tabs are kept.
const printable = (value: string) => value.split("\n").map((line) => line.split("\t").map((part) => safe(part)).join("\t")).join("\n");

export const render = new Command("render")
  .description("Render a template with variables, without sending (Dispatch only)")
  .argument("[id]", "Template ID or alias")
  .option("--var <key=value>", "Variable value. Repeatable", collect)
  .option("--variables <json>", "Variables as JSON")
  .addHelpText(
    "after",
    helpText({
      output: '{"rendered":{"subject":"...","html":"...","text":"..."}}',
      codes: ["missing_id", "invalid_json", "fetch_error"],
      examples: ["dispatch templates render welcome --var NAME=Ada", 'dispatch templates render welcome --variables \'{"NAME":"Ada"}\''],
    }),
  )
  .action(async (id, options, command) => {
    await runGet(command, {
      loading: "Rendering...",
      prepare: (globals) => pickTemplate(id, globals),
      call: (api, target) =>
        api.templates.render(target, {
          ...jsonFlag<Record<string, unknown>>(options.variables, "--variables"),
          ...pairs(options.var, "--var"),
        }),
      human: (data: { rendered?: { subject?: string; html?: string; text?: string } }) => {
        const rendered = data.rendered ?? {};
        if (rendered.subject) console.log(`Subject: ${safe(rendered.subject)}\n`);
        console.log(printable(rendered.text ?? rendered.html ?? ""));
      },
    });
  });
