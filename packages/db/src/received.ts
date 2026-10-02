import { ApiError, hash, id, toArray, type InboundInput } from "@dispatchmail/core";
import { appendEvent, fanoutEvent } from "./events.js";
import type { Queryable } from "./index.js";

export type ReceivedAttachmentInput = {
  filename: string;
  content_type?: string;
  content_id?: string | null;
  bytes: Buffer;
};

export type IngestReceivedInput = {
  tenantId: string;
  requestId: string;
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  messageId?: string | null;
  authentication?: { spf: string; dkim: string; dmarc: string } | null;
  raw?: unknown;
  rawBytes?: Buffer;
  attachments?: ReceivedAttachmentInput[];
  storeAttachment?: (storageKey: string, bytes: Buffer) => Promise<void>;
  // Set by the SES consumer so a redelivered notification is dropped instead of stored twice.
  dedupeKey?: string;
};

function decodeAttachment(content: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content) || content.length % 4 !== 0) {
    throw new ApiError("invalid_attachment", 422, "Attachment content must be base64");
  }
  const bytes = Buffer.from(content, "base64");
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== content.replace(/=+$/, "")) {
    throw new ApiError("invalid_attachment", 422, "Attachment content must be base64");
  }
  return bytes;
}

export function attachmentsFromInbound(attachments: InboundInput["attachments"]): ReceivedAttachmentInput[] {
  return (attachments ?? []).map((attachment) => ({
    filename: attachment.filename,
    content_type: attachment.content_type,
    bytes: decodeAttachment(attachment.content)
  }));
}

export function verdict(status?: string | null) {
  return (status ?? "gray").toLowerCase();
}

export function applyHtmlFormat(
  html: string | null | undefined,
  format: string | undefined,
  attachments: Array<{ content_id?: string | null; content_type: string; bytes?: Buffer }>
) {
  if (!html || format === "cid") return html ?? null;
  let next = html;
  for (const attachment of attachments) {
    if (!attachment.content_id || !attachment.bytes) continue;
    const uri = `data:${attachment.content_type};base64,${attachment.bytes.toString("base64")}`;
    next = next.replaceAll(`cid:${attachment.content_id}`, uri);
  }
  return next;
}

export async function ingestReceived(client: Queryable, input: IngestReceivedInput) {
  const emailId = id("recv");
  const recipients = [
    ...toArray(input.to).map((email) => ({ email, kind: "to" })),
    ...toArray(input.cc).map((email) => ({ email, kind: "cc" })),
    ...toArray(input.bcc).map((email) => ({ email, kind: "bcc" }))
  ];
  if (recipients.length > 50) {
    throw new ApiError("validation_error", 422, "A received email can have at most 50 recipients");
  }
  const rawKey = input.rawBytes ? `raw/${input.tenantId}/${emailId}` : null;
  if (rawKey && input.rawBytes && input.storeAttachment) await input.storeAttachment(rawKey, input.rawBytes);

  const row = await client.query(
    `insert into received_emails (id, tenant_id, request_id, from_email, subject, html, text, headers, raw, message_id, reply_to, authentication, raw_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id, request_id, from_email as from, subject, html, text, headers, message_id, reply_to, authentication, raw_key, created_at`,
    [
      emailId,
      input.tenantId,
      input.requestId,
      input.from,
      input.subject,
      input.html ?? null,
      input.text ?? null,
      JSON.stringify(input.headers ?? {}),
      JSON.stringify(input.raw ?? {}),
      input.messageId ?? null,
      JSON.stringify(input.replyTo ?? []),
      input.authentication ? JSON.stringify(input.authentication) : null,
      rawKey
    ]
  );

  if (recipients.length > 0) {
    await client.query(
      `insert into received_recipients (id, tenant_id, received_email_id, email, kind)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])`,
      [
        recipients.map(() => id("rr")),
        recipients.map(() => input.tenantId),
        recipients.map(() => emailId),
        recipients.map((recipient) => recipient.email),
        recipients.map((recipient) => recipient.kind)
      ]
    );
  }

  const attachments = (input.attachments ?? []).map((attachment) => {
    const attachmentId = id("ratt");
    return {
      id: attachmentId,
      filename: attachment.filename,
      content_type: attachment.content_type ?? "application/octet-stream",
      content_id: attachment.content_id ?? null,
      size_bytes: attachment.bytes.byteLength,
      content_hash: hash(attachment.bytes.toString("base64")),
      storage_key: `received/${input.tenantId}/${emailId}/${attachmentId}`,
      bytes: attachment.bytes
    };
  });
  for (const attachment of attachments) {
    if (input.storeAttachment) await input.storeAttachment(attachment.storage_key, attachment.bytes);
  }
  if (attachments.length > 0) {
    await client.query(
      `insert into received_attachments (id, tenant_id, received_email_id, filename, content_type, size_bytes, content_hash, storage_key, content_id)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::integer[], $7::text[], $8::text[], $9::text[])`,
      [
        attachments.map((attachment) => attachment.id),
        attachments.map(() => input.tenantId),
        attachments.map(() => emailId),
        attachments.map((attachment) => attachment.filename),
        attachments.map((attachment) => attachment.content_type),
        attachments.map((attachment) => attachment.size_bytes),
        attachments.map((attachment) => attachment.content_hash),
        attachments.map((attachment) => attachment.storage_key),
        attachments.map((attachment) => attachment.content_id)
      ]
    );
  }

  const to = recipients.filter((recipient) => recipient.kind === "to").map((recipient) => recipient.email);
  const event = await appendEvent(client, {
    tenantId: input.tenantId,
    requestId: input.requestId,
    emailId: null,
    type: "email.received",
    providerEventId: input.dedupeKey ?? `${emailId}:received`,
    data: {
      email_id: emailId,
      created_at: row.rows[0]?.created_at,
      from: input.from,
      to,
      cc: recipients.filter((recipient) => recipient.kind === "cc").map((recipient) => recipient.email),
      bcc: recipients.filter((recipient) => recipient.kind === "bcc").map((recipient) => recipient.email),
      received_for: to,
      subject: input.subject,
      message_id: input.messageId ?? null,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        content_type: attachment.content_type,
        content_id: attachment.content_id,
        size: attachment.size_bytes
      }))
    }
  });
  if (event) await fanoutEvent(client, event);

  return {
    ...row.rows[0],
    to,
    cc: recipients.filter((recipient) => recipient.kind === "cc").map((recipient) => recipient.email),
    bcc: recipients.filter((recipient) => recipient.kind === "bcc").map((recipient) => recipient.email),
    received_for: to,
    attachments: attachments.map(({ bytes: _bytes, ...attachment }) => attachment)
  };
}
