import { ingestReceived, verdict, type Queryable } from "@dispatchmail/db";
import type { Storage } from "@dispatchmail/storage";
import PostalMime from "postal-mime";

export type SesReceipt = {
  mail?: { messageId?: string; source?: string };
  receipt?: {
    recipients?: string[];
    spfVerdict?: { status?: string };
    dkimVerdict?: { status?: string };
    dmarcVerdict?: { status?: string };
    action?: { objectKey?: string };
  };
};

type Address = { address?: string; name?: string };
type Parsed = {
  from?: Address;
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  subject?: string;
  html?: string;
  text?: string;
  messageId?: string;
  headers?: Array<{ key: string; value: string }>;
  attachments?: Array<{ filename?: string; mimeType?: string; contentId?: string; content?: ArrayBuffer | Uint8Array }>;
};

function addresses(value?: Address[]) {
  return (value ?? []).map((item) => item.address).filter((address): address is string => Boolean(address));
}

export async function parseInbound(bytes: Buffer) {
  const email = (await new PostalMime().parse(bytes)) as Parsed;
  const headers = Object.fromEntries((email.headers ?? []).map((header) => [header.key, header.value]));
  return {
    from: email.from?.address ?? "",
    to: addresses(email.to),
    cc: addresses(email.cc),
    bcc: addresses(email.bcc),
    replyTo: addresses(email.replyTo),
    subject: email.subject ?? "",
    html: email.html ?? null,
    text: email.text ?? null,
    messageId: email.messageId ?? null,
    headers,
    attachments: (email.attachments ?? []).map((attachment) => ({
      filename: attachment.filename || "attachment",
      content_type: attachment.mimeType || "application/octet-stream",
      content_id: attachment.contentId?.replace(/^<|>$/g, "") ?? null,
      bytes: Buffer.from(new Uint8Array(attachment.content ?? new ArrayBuffer(0)))
    }))
  };
}

export async function applyInbound(
  db: Queryable,
  storage: Storage,
  notification: SesReceipt,
  options: { requestId?: string; region?: string | null } = {}
) {
  const objectKey = notification.receipt?.action?.objectKey;
  const recipient = notification.receipt?.recipients?.[0];
  if (!objectKey || !recipient?.includes("@")) return null;
  const domain = recipient.split("@")[1].toLowerCase();
  // SES identities are per region, so two tenants can both hold a row for one name. Mail goes
  // only to a tenant that has verified the domain in the region the message arrived in, and to
  // nobody when more than one tenant qualifies.
  const owners = await db.query<{ tenant_id: string }>(
    `select tenant_id from domains
     where lower(name) = $1 and deleted_at is null and receiving = 'enabled'
       and status in ('verified', 'partially_verified')
       and ($2::text is null or region = $2)
     limit 2`,
    [domain, options.region ?? null]
  );
  if (owners.rows.length !== 1) return null;
  const tenantId = owners.rows[0].tenant_id;
  // SQS redelivers a notification when the worker stops before deleting it.
  const messageId = notification.mail?.messageId;
  const dedupeKey = messageId ? `ses:${messageId}:received` : undefined;
  if (dedupeKey) {
    const seen = await db.query("select 1 from email_events where provider_event_id = $1", [dedupeKey]);
    if (seen.rows[0]) return null;
  }
  const bytes = await storage.get(objectKey);
  const parsed = await parseInbound(bytes);
  return ingestReceived(db, {
    tenantId,
    requestId: options.requestId ?? "ses_inbound",
    dedupeKey,
    from: parsed.from || notification.mail?.source || "unknown@localhost",
    to: parsed.to.length > 0 ? parsed.to : [recipient],
    cc: parsed.cc,
    bcc: parsed.bcc,
    replyTo: parsed.replyTo,
    subject: parsed.subject || "(no subject)",
    html: parsed.html,
    text: parsed.text,
    headers: parsed.headers,
    messageId: parsed.messageId ?? notification.mail?.messageId ?? null,
    authentication: {
      spf: verdict(notification.receipt?.spfVerdict?.status),
      dkim: verdict(notification.receipt?.dkimVerdict?.status),
      dmarc: verdict(notification.receipt?.dmarcVerdict?.status)
    },
    rawBytes: bytes,
    attachments: parsed.attachments,
    storeAttachment: (key, body) => storage.put(key, body)
  });
}
