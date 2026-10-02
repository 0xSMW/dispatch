import { Command } from "@commander-js/extra-typings";
import { openPath } from "../../lib/browser.js";
import { helpText } from "../../lib/help.js";
import { pickLog } from "../../lib/pickers.js";

export const open = new Command("open")
  .description("Open a log in the dashboard")
  .argument("[id]", "Log ID")
  .addHelpText(
    "after",
    helpText({ output: '{"url":"...","opened":true}', codes: ["missing_id", "open_error"], examples: ["dispatch logs open log_123"] }),
  )
  .action(async (id, _options, command) => {
    await openPath(command, async (globals) => `/logs/${encodeURIComponent(await pickLog(id, globals))}`);
  });
