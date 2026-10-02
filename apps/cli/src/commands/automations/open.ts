import { Command } from "@commander-js/extra-typings";
import { openPath } from "../../lib/browser.js";
import { helpText } from "../../lib/help.js";
import { pickAutomation } from "../../lib/pickers.js";

export const open = new Command("open")
  .description("Open an automation in the dashboard")
  .argument("[id]", "Automation ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"url":"...","opened":true}',
      codes: ["missing_id", "open_error"],
      examples: ["dispatch automations open auto_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await openPath(command, async (globals) => `/automations/${encodeURIComponent(await pickAutomation(id, globals))}/editor`);
  });
