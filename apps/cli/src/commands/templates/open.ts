import { Command } from "@commander-js/extra-typings";
import { openPath } from "../../lib/browser.js";
import { helpText } from "../../lib/help.js";
import { pickTemplate } from "../../lib/pickers.js";

export const open = new Command("open")
  .description("Open a template in the dashboard")
  .argument("[id]", "Template ID or alias")
  .addHelpText(
    "after",
    helpText({ output: '{"url":"...","opened":true}', codes: ["missing_id", "open_error"], examples: ["dispatch templates open welcome"] }),
  )
  .action(async (id, _options, command) => {
    await openPath(command, async (globals) => `/templates/${encodeURIComponent(await pickTemplate(id, globals))}`);
  });
