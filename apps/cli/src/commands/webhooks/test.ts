import { Command } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";

export const test = new Command("test")
  .description("Emit a signed sample event to your webhooks (Dispatch only)")
  .addHelpText(
    "after",
    helpText({
      output: "The test event as JSON.",
      codes: ["test_error"],
      examples: ["dispatch webhooks test"],
    }),
  )
  .action(async (_options, command) => {
    await runWrite(command, {
      code: "test_error",
      loading: "Sending test event...",
      call: (api) => api.webhooks.test(),
      done: () => "Test event sent",
    });
  });
