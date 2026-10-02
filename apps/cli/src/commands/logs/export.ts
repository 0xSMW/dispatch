import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";

export const exportCommand = new Command("export")
  .description("Print the latest API logs in bulk (Dispatch only)")
  .addHelpText("after", helpText({ output: "The export as JSON.", codes: ["fetch_error"], examples: ["dispatch logs export > logs.json"] }))
  .action(async (_options, command) => {
    await runGet(command, {
      loading: "Exporting...",
      call: (api) => api.logs.export(),
      human: (data) => console.log(JSON.stringify(data, null, 2)),
    });
  });
