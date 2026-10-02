import { Command } from "@commander-js/extra-typings";
import { runList } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { pageOptions } from "../../../lib/pagination.js";
import { pickWebhook } from "../../../lib/pickers.js";

export type WebhookEvent = { id: string; type: string; status: string; created_at: string };

export const list = pageOptions(new Command("list"))
  .alias("ls")
  .description("List events delivered to a webhook")
  .argument("[webhookId]", "Webhook ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","type":"email.delivered","status":"delivered"}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch webhooks events list wh_123"],
    }),
  )
  .action(async (webhookId, _options, command) => {
    await runList<WebhookEvent, string>(command, {
      prepare: (globals) => pickWebhook(webhookId, globals),
      call: (api, page, target) => api.webhooks.events.list(target, page),
      columns: ["Type", "Status", "Created", "ID"],
      row: (event) => [event.type, event.status, event.created_at, event.id],
      empty: "(no events)",
    });
  });
