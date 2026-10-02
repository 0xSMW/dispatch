import { pickWebhook } from "../../../lib/pickers.js";
import { pick } from "../../../lib/prompts.js";
import type { Globals } from "../../../lib/tty.js";
import type { WebhookEvent } from "./list.js";

export async function pickWebhookEvent(webhookId: string | undefined, eventId: string | undefined, globals: Globals) {
  const hook = await pickWebhook(webhookId, globals);
  const event = await pick<WebhookEvent>(eventId, {
    globals,
    noun: "event",
    list: (api) => api.webhooks.events.list(hook, { limit: 100 }),
    label: (item) => `${item.type} (${item.status}) ${item.created_at}`,
  });
  return { webhookId: hook, eventId: event };
}
