import { Command } from "@commander-js/extra-typings";
import { runGet } from "../lib/actions.js";
import { helpText } from "../lib/help.js";

export const usage = new Command("usage")
  .description("Show usage counters for this account")
  .addHelpText("after", helpText({ output: "The usage response as JSON.", codes: ["fetch_error"], examples: ["dispatch usage"] }))
  .action(async (_options, command) => {
    await runGet(command, { call: (api) => api.usage.get() });
  });
