import { GetAccountCommand, SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { classifySesError, formatAddress, parseAddress, type Provider, type ProviderEmail, type ProviderQuota } from "@dispatchmail/core";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { sesClient } from "./identity.js";

export type SesSender = {
  send(command: unknown): Promise<{ MessageId?: string; SendQuota?: { Max24HourSend?: number; MaxSendRate?: number; SentLast24Hours?: number }; ProductionAccessEnabled?: boolean }>;
};

const quotaTtlMs = 60_000;

export function configurationSet(tls: ProviderEmail["tls"]) {
  return tls === "enforced" ? "dispatch-tls-required" : "dispatch-default";
}

export function simple(email: ProviderEmail) {
  return {
    Subject: { Data: email.subject, Charset: "UTF-8" },
    Body: {
      ...(email.html ? { Html: { Data: email.html, Charset: "UTF-8" } } : {}),
      ...(email.text ? { Text: { Data: email.text, Charset: "UTF-8" } } : {})
    },
    Headers: Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value }))
  };
}

// The stored form is `Name <email>` with the name as the sender typed it. SES takes a header
// value, so a name with a comma or a character outside ASCII has to be quoted or encoded first.
function header(value: string) {
  const parsed = parseAddress(value);
  return formatAddress(parsed.email, parsed.name);
}

// nodemailer quotes and encodes names itself when it is given the parts.
function mailbox(value: string) {
  const parsed = parseAddress(value);
  return { name: parsed.name ?? "", address: parsed.email };
}

export async function mime(email: ProviderEmail) {
  const pick = (kind: "to" | "cc" | "bcc") => email.recipients.filter((recipient) => recipient.kind === kind).map((recipient) => recipient.email);
  const composer = new MailComposer({
    from: mailbox(email.from),
    to: pick("to"),
    cc: pick("cc"),
    bcc: pick("bcc"),
    replyTo: email.reply_to.map(mailbox),
    subject: email.subject,
    html: email.html ?? undefined,
    text: email.text ?? undefined,
    headers: email.headers,
    attachments: email.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.bytes,
      contentType: attachment.content_type,
      cid: attachment.content_id ?? undefined,
      contentDisposition: attachment.disposition
    }))
  });
  return composer.compile().build();
}

export function createSesProvider(options: { clientFor?: (region: string) => SesSender; now?: () => number } = {}): Provider {
  const clientFor = options.clientFor ?? ((region: string) => sesClient(region) as unknown as SesSender);
  const now = options.now ?? Date.now;
  const quotas = new Map<string, { at: number; value: ProviderQuota }>();
  return {
    name: "ses",
    async send(email) {
      const pick = (kind: string) => email.recipients.filter((recipient) => recipient.kind === kind).map((recipient) => recipient.email);
      const content = email.attachments.length > 0
        ? { Raw: { Data: await mime(email) } }
        : { Simple: simple(email) };
      try {
        const result = await clientFor(email.region).send(new SendEmailCommand({
          FromEmailAddress: header(email.from),
          Destination: { ToAddresses: pick("to"), CcAddresses: pick("cc"), BccAddresses: pick("bcc") },
          ReplyToAddresses: email.reply_to.map(header),
          ConfigurationSetName: configurationSet(email.tls),
          EmailTags: [
            { Name: "dispatch_email_id", Value: email.id },
            { Name: "dispatch_tenant_id", Value: email.tenant_id }
          ],
          Content: content
        }));
        const id = result.MessageId ?? "";
        return {
          provider_message_id: id,
          message_id: `<${id}@${email.region}.amazonses.com>`,
          events: [{ type: "email.sent" as const, provider_event_id: `${id}:sent`, delay_ms: 0, recipients: email.recipients.map((recipient) => recipient.email), data: { provider_message_id: id } }]
        };
      } catch (error) {
        throw classifySesError(error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } });
      }
    },
    async quota(region) {
      const cached = quotas.get(region);
      if (cached && now() - cached.at < quotaTtlMs) return cached.value;
      const account = await clientFor(region).send(new GetAccountCommand({}));
      const value: ProviderQuota = {
        max_24_hour: account.SendQuota?.Max24HourSend ?? 0,
        max_per_second: account.SendQuota?.MaxSendRate ?? 0,
        sent_24_hour: account.SendQuota?.SentLast24Hours ?? 0,
        sandbox: !account.ProductionAccessEnabled
      };
      quotas.set(region, { at: now(), value });
      return value;
    }
  };
}

export const ses = createSesProvider();

export { SESv2Client };
