import { Command } from "@commander-js/extra-typings";
import type { Rule } from "@dispatchmail/sdk";
import { runWrite } from "../../lib/actions.js";
import { jsonFlag } from "../../lib/json.js";

export const preview = new Command("preview")
  .description("Read-only count and sample for a segment filter")
  .requiredOption("--rule <json>", "Filter rule JSON")
  .action(async (options, command) => {
    await runWrite(command, {
      prepare: async () => jsonFlag<Rule>(options.rule, "--rule")!,
      call: (api, rule) => api.segments.preview(rule),
      done: (result: { count: number }) => `${result.count} matching contacts`,
    });
  });
