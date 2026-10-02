import { Command } from "@commander-js/extra-typings";
import { runList } from "../../../lib/actions.js";
import { helpText } from "../../../lib/help.js";
import { pageOptions } from "../../../lib/pagination.js";
import { pickWebhookEvent } from "./pick.js";

type Attempt = { id: string; http_status_code: number | null; response: string | null; sent_at: string | null };

export const attempts = pageOptions(new Command("attempts"))
  .description("List delivery attempts for one webhook event")
  .argument("[webhookId]", "Webhook ID")
  .argument("[eventId]", "Event ID")
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"list","has_more":false,"data":[{"id":"...","http_status_code":200,"sent_at":"..."}]}',
      codes: ["missing_id", "list_error"],
      examples: ["dispatch webhooks events attempts wh_123 evt_456"],
    }),
  )
  .action(async (webhookId, eventId, _options, command) => {
    await runList<Attempt, { webhookId: string; eventId: string }>(command, {
      prepare: (globals) => pickWebhookEvent(webhookId, eventId, globals),
      call: (api, page, target) => api.webhooks.events.attempts(target.webhookId, target.eventId, page),
      columns: ["Status", "Sent", "Response", "ID"],
      row: (attempt) => [attempt.http_status_code ?? "error", attempt.sent_at ?? "", (attempt.response ?? "").slice(0, 60), attempt.id],
      empty: "(no attempts)",
    });
  });
