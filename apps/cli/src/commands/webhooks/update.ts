import { Command, Option } from "@commander-js/extra-typings";
import { runWrite } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { compact, csv } from "../../lib/json.js";
import { pickWebhook } from "../../lib/pickers.js";

export const update = new Command("update")
  .description("Change a webhook's endpoint, events, or status")
  .argument("[id]", "Webhook ID")
  .option("--endpoint <url>", "New endpoint URL")
  .option("--events <types>", 'Comma-separated event types, or "all"')
  .addOption(new Option("--status <status>", "Turn delivery on or off").choices(["enabled", "disabled"] as const))
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"webhook","id":"..."}',
      codes: ["missing_id", "update_error", "validation_error"],
      examples: ["dispatch webhooks update wh_123 --status disabled", "dispatch webhooks update wh_123 --events all"],
    }),
  )
  .action(async (id, options, command) => {
    await runWrite(command, {
      prepare: (globals) => pickWebhook(id, globals),
      call: (api, target) =>
        api.webhooks.update(target, compact({ endpoint: options.endpoint, events: csv(options.events), status: options.status })),
      done: (hook: { id: string }) => `Updated webhook ${hook.id}`,
    });
  });
