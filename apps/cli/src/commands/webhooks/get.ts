import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../lib/actions.js";
import { helpText } from "../../lib/help.js";
import { pickWebhook } from "../../lib/pickers.js";

export const get = new Command("get")
  .description("Show a webhook")
  .argument("[id]", "Webhook ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"webhook","id":"...","endpoint":"https://...","events":[...],"status":"enabled"}',
      codes: ["missing_id", "fetch_error", "not_found"],
      examples: ["dispatch webhooks get wh_123"],
    }),
  )
  .action(async (id, _options, command) => {
    await runGet(command, {
      prepare: (globals) => pickWebhook(id, globals),
      call: (api, target) => api.webhooks.get(target),
    });
  });
