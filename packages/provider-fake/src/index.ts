import { EventType, id } from "@dispatch/core";

export type FakeResult = {
  provider_message_id: string;
  events: Array<{
    type: EventType;
    provider_event_id: string;
    delay_ms: number;
    data: Record<string, unknown>;
  }>;
};

export function sendFake(email: { id: string; recipients: string[]; subject: string; attachments?: number }): FakeResult {
  const providerId = id("ses");
  const lower = email.recipients.join(",").toLowerCase();
  const failure = lower.includes("bounce") ? "email.bounced" : lower.includes("complaint") ? "email.complained" : undefined;
  const terminal: EventType = failure ?? "email.delivered";
  const delayed = !failure && lower.includes("delay");
  const terminalDelayMs = Number(process.env.FAKE_PROVIDER_TERMINAL_DELAY_MS ?? 0);
  const delayedDelayMs = Number(process.env.FAKE_PROVIDER_DELAYED_DELAY_MS ?? 0);

  return {
    provider_message_id: providerId,
    events: [
      {
        type: "email.sent",
        provider_event_id: `${providerId}:sent`,
        delay_ms: 0,
        data: { provider_message_id: providerId, subject: email.subject, attachments: email.attachments ?? 0 }
      },
      ...(delayed
        ? [
            {
              type: "email.delivery_delayed" as EventType,
              provider_event_id: `${providerId}:delayed`,
              delay_ms: delayedDelayMs,
              data: { provider_message_id: providerId, recipients: email.recipients, reason: "local fake delay" }
            }
          ]
        : []),
      {
        type: terminal,
        provider_event_id: `${providerId}:${terminal}`,
        delay_ms: terminalDelayMs,
        data: { provider_message_id: providerId, recipients: email.recipients }
      }
    ]
  };
}
