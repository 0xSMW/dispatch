import { Command } from "@commander-js/extra-typings";
import { runGet } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { pickWebhookEvent } from "./pick.js";

export const get = new Command("get")
  .description("Show one webhook event and its payload")
  .argument("[webhookId]", "Webhook ID")
  .argument("[eventId]", "Event ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"webhook_event","id":"...","type":"email.delivered","status":"delivered"}',
      codes: ["missing_id", "fetch_error", "not_found"],
      examples: ["dispatch webhooks events get wh_123 evt_456"],
    }),
  )
  .action(async (webhookId, eventId, _options, command) => {
    await runGet(command, {
      prepare: (globals) => pickWebhookEvent(webhookId, eventId, globals),
      call: (api, target) => api.webhooks.events.get(target.webhookId, target.eventId),
    });
  });
