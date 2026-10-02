import { Command } from "@commander-js/extra-typings";
import { runCreate } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { promptMissing } from "../../lib/prompts.js";

export const add = new Command("add")
  .description("Stop sending to an address")
  .argument("[email]", "Email address")
  .option("--email <email>", "Email address (same as the positional argument)")
  .option("--reason <reason>", "Why it is suppressed", "manual")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"suppression","id":"...","email":"..."}',
      codes: ["missing_flags", "create_error"],
      examples: ["dispatch suppressions add gone@example.com --reason requested"],
    }),
  )
  .action(async (email, options, command) => {
    await runCreate(command, {
      prepare: (globals) => promptMissing({ email: email ?? options.email }, [{ key: "email", flag: "--email", label: "Email" }], globals),
      call: (api, input) => api.suppressions.add({ email: input.email, reason: options.reason }),
      done: (item: { email?: string; id: string }) => `Suppressed ${item.email ?? item.id}`,
    });
  });
