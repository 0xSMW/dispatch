import { Command } from "@commander-js/extra-typings";
import { runGet } from "../lib/actions.js";
import { helpText } from "../lib/help.js";

export const system = new Command("system")
  .description("Show worker backlog, webhook attempts, automation states, and log health (Dispatch only)")
  .addHelpText("after", helpText({ output: "The system report as JSON.", codes: ["fetch_error"], examples: ["dispatch system"] }))
  .action(async (_options, command) => {
    await runGet(command, { call: (api) => api.system.get() });
  });
