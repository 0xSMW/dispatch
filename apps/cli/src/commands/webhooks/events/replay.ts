import { Command, Option } from "@commander-js/extra-typings";
import { runWrite } from "../../../lib/actions.js";
import { unwrap } from "../../../lib/client.js";
import { CliError } from "../../../lib/errors.js";
import { helpText } from "../../../lib/help.js";
import { pickWebhook } from "../../../lib/pickers.js";
import type { WebhookEvent } from "./list.js";

export const replay = new Command("replay")
  .description("Deliver a webhook event again. Without an event ID, replays the latest failed event")
  .argument("[webhookId]", "Webhook ID")
  .argument("[eventId]", "Event ID")
  .addOption(new Option("--event <id>", "Event ID (old flag)").hideHelp())
  .addHelpText(
    "after",
    helpText({
      output: '{"object":"webhook_event","id":"..."}',
      codes: ["missing_id", "replay_error", "not_found"],
      examples: ["dispatch webhooks events replay wh_123 evt_456", "dispatch webhooks events replay wh_123"],
    }),
  )
  .action(async (webhookId, eventId, options, command) => {
    await runWrite(command, {
      code: "replay_error",
      loading: "Replaying...",
      prepare: (globals) => pickWebhook(webhookId, globals),
      call: async (api, hook) => {
        let target = eventId ?? options.event;
        if (!target) {
          const { data } = await unwrap<{ data: WebhookEvent[] }>(api.webhooks.events.list(hook, { limit: 100 }));
          // Only a failed one. Replaying the newest delivered event would make the receiver
          // process it twice.
          target = data.find((event) => event.status === "failed")?.id;
        }
        if (!target) throw new CliError("not_found", "No failed event to replay. Pass an event ID to replay a delivered one");
        return api.webhooks.events.replay(hook, target);
      },
      done: (event: { id?: string }) => `Replay queued${event?.id ? ` for ${event.id}` : ""}`,
    });
  });
