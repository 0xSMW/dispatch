import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { EventType } from "@dispatchmail/core";
import { appendEvent, fanoutEvent, type Queryable } from "@dispatchmail/db";

export type SqsClient = {
  send(command: unknown): Promise<{ Messages?: Array<{ Body?: string; ReceiptHandle?: string }> }>;
};

type SesRecipient = { emailAddress?: string; diagnosticCode?: string };

export type SesEvent = {
  eventType?: string;
  mail?: {
    messageId?: string;
    destination?: string[];
    tags?: Record<string, string[]>;
  };
  delivery?: { recipients?: string[] };
  bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: SesRecipient[] };
  complaint?: { complainedRecipients?: SesRecipient[] };
  deliveryDelay?: { delayedRecipients?: SesRecipient[] };
};

export type MappedSesEvent = {
  type: EventType;
  tenantId: string;
  emailId: string;
  providerEventId: string;
  recipients: string[];
  data: Record<string, unknown>;
} | null;

function addresses(rows?: SesRecipient[]) {
  return (rows ?? []).map((row) => row.emailAddress).filter((email): email is string => Boolean(email));
}

export function mapSesEvent(message: SesEvent): MappedSesEvent {
  const emailId = message.mail?.tags?.dispatch_email_id?.[0];
  const tenantId = message.mail?.tags?.dispatch_tenant_id?.[0];
  const messageId = message.mail?.messageId;
  if (!emailId || !tenantId || !messageId || !message.eventType) return null;
  if (message.eventType === "Open" || message.eventType === "Click") return null;
  const type = eventType(message.eventType);
  if (!type) return null;
  const recipients = recipientsFor(message);
  const providerEventId = message.eventType === "Send" ? `${messageId}:sent` : `${messageId}:${message.eventType}:${recipients[0] ?? "all"}`;
  return {
    type,
    tenantId,
    emailId,
    providerEventId,
    recipients,
    data: eventData(message)
  };
}

function eventType(value: string): EventType | null {
  switch (value) {
    case "Send": return "email.sent";
    case "Delivery": return "email.delivered";
    case "Bounce": return "email.bounced";
    case "Complaint": return "email.complained";
    case "DeliveryDelay": return "email.delivery_delayed";
    case "Reject":
    case "Rendering Failure":
      return "email.failed";
    default:
      return null;
  }
}

function recipientsFor(message: SesEvent) {
  switch (message.eventType) {
    case "Delivery": return message.delivery?.recipients ?? [];
    case "Bounce": return addresses(message.bounce?.bouncedRecipients);
    case "Complaint": return addresses(message.complaint?.complainedRecipients);
    case "DeliveryDelay": return addresses(message.deliveryDelay?.delayedRecipients);
    default: return message.mail?.destination ?? [];
  }
}

// One event is written per bounced address, and each carries that address's own diagnostic.
function eventData(message: SesEvent, address?: string) {
  if (message.eventType === "Bounce") {
    const bounced = message.bounce?.bouncedRecipients ?? [];
    const recipient = bounced.find((row) => row.emailAddress?.toLowerCase() === address?.toLowerCase()) ?? bounced[0];
    return {
      bounce: { type: message.bounce?.bounceType, subType: message.bounce?.bounceSubType, message: recipient?.diagnosticCode ?? "" },
      // The address that bounced, so a reader never has to guess it from the To line.
      ...(recipient?.emailAddress ? { email: recipient.emailAddress.toLowerCase() } : {}),
    };
  }
  if (message.eventType === "Reject" || message.eventType === "Rendering Failure") {
    return { failed: { reason: message.eventType } };
  }
  return { provider_message_id: message.mail?.messageId };
}

export async function applySesEvent(client: Queryable, message: SesEvent, provider = "ses") {
  const mapped = mapSesEvent(message);
  if (!mapped) return null;
  // The tenant and email come from tags on the SES message. They are trusted only when the
  // event's message ID is the one SES gave us for that email, so an event can never be booked
  // against another tenant's email.
  const owner = await client.query<{ provider_message_id: string | null }>(
    "select provider_message_id from emails where tenant_id = $1 and id = $2",
    [mapped.tenantId, mapped.emailId],
  );
  const stored = owner.rows[0];
  if (!stored) return null;
  // The event can arrive before the worker has stored the ID. Throwing leaves the message on the
  // queue, and it is applied on the next delivery.
  if (!stored.provider_message_id) throw new Error(`SES event for ${mapped.emailId} arrived before its message ID was stored`);
  if (stored.provider_message_id !== message.mail?.messageId) return null;
  const oneEach = mapped.type === "email.sent" ? [mapped.recipients] : mapped.recipients.map((recipient) => [recipient]);
  const rows = [];
  for (const recipients of oneEach) {
    const providerEventId = mapped.type === "email.sent" ? mapped.providerEventId : `${message.mail?.messageId}:${message.eventType}:${recipients[0]}`;
    const row = await appendEvent(client, {
      tenantId: mapped.tenantId,
      requestId: `ses_${message.mail?.messageId}`,
      emailId: mapped.emailId,
      type: mapped.type,
      providerEventId,
      data: mapped.type === "email.bounced" ? eventData(message, recipients[0]) : mapped.data,
      mode: "delivery",
      recipients,
      provider
    });
    if (row) {
      await fanoutEvent(client, row);
      rows.push(row);
    }
  }
  return rows;
}

export async function consumeOnce(client: SqsClient, queueUrl: string, handle: (body: unknown) => Promise<void>) {
  const batch = await client.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 20
  }));
  for (const message of batch.Messages ?? []) {
    await handle(JSON.parse(message.Body ?? "{}"));
    await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }
  return batch.Messages?.length ?? 0;
}
