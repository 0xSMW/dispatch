import { EventType, id, type Provider, type ProviderEmail } from "@dispatchmail/core";

export type FakeResult = {
  provider_message_id: string;
  events: Array<{
    type: EventType;
    provider_event_id: string;
    delay_ms: number;
    recipients?: string[];
    data: Record<string, unknown>;
  }>;
};

// Each recipient gets its own outcome, read from its address: "bounce" bounces, "complaint"
// complains, and "delay" is delayed before it is delivered. One email to a good address and a
// bouncing one delivers the first and bounces the second, as SES would.
export function sendFake(email: { id: string; recipients: string[]; subject: string; attachments?: number }): FakeResult {
  const providerId = id("ses");
  const has = (address: string, word: string) => address.toLowerCase().includes(word);
  const bounced = email.recipients.filter((address) => has(address, "bounce"));
  const complained = email.recipients.filter((address) => !has(address, "bounce") && has(address, "complaint"));
  const delivered = email.recipients.filter((address) => !has(address, "bounce") && !has(address, "complaint"));
  const delayed = delivered.filter((address) => has(address, "delay"));
  const terminalDelayMs = Number(process.env.FAKE_PROVIDER_TERMINAL_DELAY_MS ?? 0);
  const delayedDelayMs = Number(process.env.FAKE_PROVIDER_DELAYED_DELAY_MS ?? 0);

  const events: FakeResult["events"] = [
    {
      type: "email.sent",
      provider_event_id: `${providerId}:sent`,
      delay_ms: 0,
      recipients: email.recipients,
      data: { provider_message_id: providerId, subject: email.subject, attachments: email.attachments ?? 0 }
    }
  ];
  if (delayed.length) {
    events.push({
      type: "email.delivery_delayed",
      provider_event_id: `${providerId}:delayed`,
      delay_ms: delayedDelayMs,
      recipients: delayed,
      data: { provider_message_id: providerId, recipients: delayed, reason: "local fake delay" }
    });
  }
  if (delivered.length) {
    events.push({
      type: "email.delivered",
      provider_event_id: `${providerId}:email.delivered`,
      delay_ms: terminalDelayMs,
      recipients: delivered,
      data: { provider_message_id: providerId, recipients: delivered }
    });
  }
  // One event per bounced address, each naming it, the way the SES consumer writes them.
  for (const address of bounced) {
    events.push({
      type: "email.bounced",
      provider_event_id: bounced.length === 1 ? `${providerId}:email.bounced` : `${providerId}:email.bounced:${address.toLowerCase()}`,
      delay_ms: terminalDelayMs,
      recipients: [address],
      data: {
        provider_message_id: providerId,
        recipients: [address],
        email: address.toLowerCase(),
        bounce: { type: "Permanent", subType: "General", message: "local fake bounce" }
      }
    });
  }
  if (complained.length) {
    events.push({
      type: "email.complained",
      provider_event_id: `${providerId}:email.complained`,
      delay_ms: terminalDelayMs,
      recipients: complained,
      data: { provider_message_id: providerId, recipients: complained }
    });
  }
  return { provider_message_id: providerId, events };
}

export function fakeProvider(): Provider {
  return {
    name: "fake",
    async send(email: ProviderEmail) {
      const result = sendFake({
        id: email.id,
        subject: email.subject,
        recipients: email.recipients.map((recipient) => recipient.email),
        attachments: email.attachments.length
      });
      return result;
    },
    async quota() {
      return { max_24_hour: 100_000, max_per_second: 100, sent_24_hour: 0, sandbox: false };
    }
  };
}
