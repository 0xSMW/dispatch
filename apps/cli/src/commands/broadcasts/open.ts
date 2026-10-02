import { Command } from "@commander-js/extra-typings";
import { openPath } from "../../lib/browser.js";
import { helpText } from "../../lib/help.js";
import { pickBroadcast } from "../../lib/pickers.js";

export const open = new Command("open")
  .description("Open a broadcast in the dashboard")
  .argument("[id]", "Broadcast ID")
  .addHelpText(
    "after",
    helpText({ output: '{"url":"...","opened":true}', codes: ["missing_id", "open_error"], examples: ["dispatch broadcasts open bc_123"] }),
  )
  .action(async (id, _options, command) => {
    await openPath(command, async (globals) => `/broadcasts/${encodeURIComponent(await pickBroadcast(id, globals))}`);
  });
