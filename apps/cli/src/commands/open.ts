import { Command } from "@commander-js/extra-typings";
import { openPath } from "../lib/browser.js";
import { helpText } from "../lib/help.js";

export const open = new Command("open")
  .description("Open the dashboard (APP_URL)")
  .argument("[path]", "Dashboard path, such as /emails")
  .addHelpText(
    "after",
    helpText({
      output: '{"url":"http://localhost:5173/","opened":true}',
      codes: ["open_error"],
      examples: ["dispatch open", "dispatch open /domains"],
    }),
  )
  .action(async (path, _options, command) => {
    await openPath(command, () => (path ? (path.startsWith("/") ? path : `/${path}`) : "/"));
  });
