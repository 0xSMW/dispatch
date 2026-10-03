import {
  ApiError,
  assertPublicWebhookTarget,
  publicFetch,
  contentTypeForFilename,
  hash,
  id,
  parseAddress,
  sendSchema,
  stableHash,
  toArray,
} from "@dispatchmail/core";
import { ingestEmail, type IngestEmailResult } from "./emails.js";
import { tx, type Db, type Queryable } from "./index.js";
import { subscriptionLinks } from "./unsubscribe.js";

export type AcceptEmailContext = {
  tenant_id: string;
  api_key_id?: string | null;
  request_id: string;
  idempotency_key?: string;
  domain_name?: string | null;
};

export type AcceptEmailOptions = {
  idempotency?: boolean;
  // Runs on the raw body after the idempotency hash is taken and before validation. The API uses
  // it to turn "in 1 hour" into a timestamp, which would otherwise change the hash on every retry.
  prepare?: (input: unknown) => unknown;
  client?: Queryable;
  publicUrl?: string;
  unsubscribe?: { secret: string; appUrl: string; publicUrl: string };
  storeAttachment?: (storageKey: string, bytes: Buffer) => Promise<void>;
  fetchAttachment?: (path: string, remaining: number) => Promise<Buffer>;
};

export type SendResult = {
  id: string;
  emails?: Array<{ id: string; to: string }>;
};
export type AcceptedEmail = {
  email: IngestEmailResult;
  emails?: Array<{ id: string; to: string }>;
};

export type BatchResult = {
  data: SendResult[];
  errors?: Array<{ index: number; message: string }>;
};

type StoredAttachment = {
  id: string;
  filename: string;
  content_type: string;
  content_id?: string;
  disposition: "attachment" | "inline";
  size_bytes: number;
  content_hash: string;
  storage_key: string;
  bytes: Buffer;
};

export async function claimIdempotency(
  client: Queryable,
  tenantId: string,
  key: string,
  requestHash: string,
): Promise<{ replay: unknown } | null> {
  await client.query(
    "delete from idempotency_keys where tenant_id = $1 and key = $2 and expires_at <= now()",
    [tenantId, key],
  );
  const inserted = await client.query(
    `insert into idempotency_keys (id, tenant_id, key, request_hash, state, expires_at)
     values ($1, $2, $3, $4, 'running', now() + interval '24 hours')
     on conflict (tenant_id, key) do nothing
     returning id`,
    [id("idem"), tenantId, key, requestHash],
  );
  if ((inserted.rowCount ?? 0) !== 0) return null;
  const existing = await client.query(
    "select request_hash, response_json, state from idempotency_keys where tenant_id = $1 and key = $2 and expires_at > now() for update",
    [tenantId, key],
  );
  if (!existing.rows[0]) return null;
  if (existing.rows[0].request_hash !== requestHash) {
    throw new ApiError(
      "invalid_idempotent_request",
      409,
      "Idempotency key was used with a different payload",
    );
  }
  if (existing.rows[0].state === "running") {
    throw new ApiError(
      "concurrent_idempotent_requests",
      409,
      "Idempotency request is still in flight",
    );
  }
  if (existing.rows[0].response_json)
    return { replay: existing.rows[0].response_json };
  return null;
}

export async function acceptEmail(
  db: Db | Queryable,
  input: unknown,
  context: AcceptEmailContext,
  options: AcceptEmailOptions = {},
): Promise<AcceptedEmail> {
  const idemKey =
    options.idempotency === false ? undefined : context.idempotency_key;
  const requestHash = idemKey ? stableHash(input) : null;
  const parsed = sendSchema.parse(
    options.prepare ? options.prepare(input) : input,
  );
  const from = parsed.from
    ? parseAddress(parsed.from)
    : { email: "", name: null };
  // Checked again in ingestEmail once a template has supplied the sender. This early check fails
  // a restricted key before anything is fetched or written.
  if (
    context.domain_name &&
    from.email &&
    from.email.split("@")[1]?.toLowerCase() !==
      context.domain_name.toLowerCase()
  ) {
    throw new ApiError(
      "validation_error",
      403,
      "API key is restricted to another domain",
    );
  }
  const scheduledAt = parsed.scheduled_at
    ? new Date(parsed.scheduled_at)
    : null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    throw new ApiError(
      "validation_error",
      422,
      "scheduled_at must be ISO 8601 or a phrase like 'in 1 hour'",
    );
  }
  const attachments = await resolveAttachments(
    parsed.attachments ?? [],
    options.fetchAttachment,
  );

  const run = async (client: Queryable) => {
    if (idemKey && requestHash) {
      const claim = await claimIdempotency(
        client,
        context.tenant_id,
        idemKey,
        requestHash,
      );
      if (claim) return claim.replay as AcceptedEmail;
    }

    const addresses = [
      ...toArray(parsed.to).map((email) => ({ email, role: "to" })),
      ...toArray(parsed.cc).map((email) => ({ email, role: "cc" })),
      ...toArray(parsed.bcc).map((email) => ({ email, role: "bcc" })),
    ];
    if (addresses.length > 50)
      throw new ApiError(
        "validation_error",
        422,
        "An email can have at most 50 recipients",
      );
    const seen = new Set<string>();
    const unique = addresses.filter((recipient) => {
      const email = recipient.email.toLowerCase();
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });
    const split = Boolean(parsed.topic_id) && addresses.length > 1;
    const recipients = parsed.topic_id ? unique : [null];
    const accepted: IngestEmailResult[] = [];
    for (const recipient of recipients) {
      const emailId = id("email");
      let contactId: string | null = null;
      let subscription: ReturnType<typeof subscriptionLinks> | undefined;
      if (parsed.topic_id && recipient) {
        const contact = await client.query<{ id: string }>(
          "select id from contacts where tenant_id = $1 and lower(email) = lower($2) and deleted_at is null",
          [context.tenant_id, recipient.email],
        );
        contactId = contact.rows[0]?.id ?? null;
        subscription = subscriptionLinks({
          tenantId: context.tenant_id,
          contactId,
          email: recipient.email,
          topicId: parsed.topic_id,
          emailId,
          ...options.unsubscribe,
        });
      }
      const stored = prepareAttachments(
        context.tenant_id,
        emailId,
        attachments,
      );
      for (const attachment of stored) {
        if (options.storeAttachment)
          await options.storeAttachment(
            attachment.storage_key,
            attachment.bytes,
          );
      }

      const { email } = await ingestEmail(client, {
        tenantId: context.tenant_id,
        requestId: context.request_id,
        emailId,
        from: from.email,
        fromName: from.name,
        to: recipient ? recipient.email : parsed.to,
        cc: recipient ? undefined : parsed.cc,
        bcc: recipient ? undefined : parsed.bcc,
        replyTo: toArray(parsed.reply_to).map((value) => {
          const parsedAddress = parseAddress(value);
          return parsedAddress.name
            ? `${parsedAddress.name} <${parsedAddress.email}>`
            : parsedAddress.email;
        }),
        subject: parsed.subject,
        html: parsed.html,
        text: parsed.text,
        template: parsed.template?.id,
        variables: parsed.template?.variables ?? parsed.variables,
        headers: subscription
          ? {
              ...Object.fromEntries(
                Object.entries(parsed.headers ?? {}).filter(
                  ([key]) =>
                    !["list-unsubscribe", "list-unsubscribe-post"].includes(
                      key.toLowerCase(),
                    ),
                ),
              ),
              ...subscription.headers,
            }
          : parsed.headers,
        context: subscription?.context,
        contactId,
        tags:
          split && recipient
            ? { ...parsed.tags, split_role: recipient.role }
            : parsed.tags,
        topicId: parsed.topic_id,
        scheduledAt,
        idempotencyKey: idemKey,
        apiKeyId: context.api_key_id ?? null,
        publicUrl: options.publicUrl,
        restrictDomain: context.domain_name,
      });
      if (stored.length > 0) {
        await client.query(
          `insert into email_attachments (
          id, tenant_id, email_id, filename, content_type, content_id, disposition, size_bytes, content_hash, storage_key
        )
         select * from unnest(
          $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
          $6::text[], $7::text[], $8::integer[], $9::text[], $10::text[]
        )`,
          [
            stored.map((attachment) => attachment.id),
            stored.map(() => context.tenant_id),
            stored.map(() => emailId),
            stored.map((attachment) => attachment.filename),
            stored.map((attachment) => attachment.content_type),
            stored.map((attachment) => attachment.content_id ?? null),
            stored.map((attachment) => attachment.disposition),
            stored.map((attachment) => attachment.size_bytes),
            stored.map((attachment) => attachment.content_hash),
            stored.map((attachment) => attachment.storage_key),
          ],
        );
      }

      accepted.push(email);
    }

    const response: AcceptedEmail = {
      email: accepted[0]!,
      ...(split
        ? {
            emails: accepted.map((email, index) => ({
              id: email.id,
              to: unique[index]!.email,
            })),
          }
        : {}),
    };
    if (idemKey) {
      await client.query(
        "update idempotency_keys set response_json = $3, state = 'done' where tenant_id = $1 and key = $2",
        [context.tenant_id, idemKey, JSON.stringify(response)],
      );
    }
    return response;
  };

  if (options.client) return run(options.client);
  return tx(db as Db, run);
}

export async function acceptBatch(
  db: Db,
  emails: unknown[],
  context: AcceptEmailContext,
  options: AcceptEmailOptions & { validation?: "strict" | "permissive" } = {},
): Promise<BatchResult> {
  const validation =
    options.validation === "permissive" ? "permissive" : "strict";
  const idemKey = context.idempotency_key;
  const requestHash = idemKey ? stableHash({ emails, validation }) : null;
  return tx(db, async (client) => {
    if (idemKey && requestHash) {
      const claim = await claimIdempotency(
        client,
        context.tenant_id,
        idemKey,
        requestHash,
      );
      if (claim) return claim.replay as BatchResult;
    }
    const data: SendResult[] = [];
    const errors: Array<{ index: number; message: string }> = [];
    for (const [index, email] of emails.entries()) {
      const acceptOne = async () => {
        if (email && typeof email === "object" && "attachments" in email) {
          throw new ApiError(
            "validation_error",
            400,
            "attachments are not supported in batch sends",
          );
        }
        return acceptEmail(
          db,
          email,
          { ...context, idempotency_key: undefined },
          { ...options, idempotency: false, client },
        );
      };
      if (validation === "strict") {
        const result = await acceptOne();
        data.push({
          id: result.email.id,
          ...(result.emails ? { emails: result.emails } : {}),
        });
        continue;
      }
      await client.query("savepoint batch_item");
      try {
        const result = await acceptOne();
        data.push({
          id: result.email.id,
          ...(result.emails ? { emails: result.emails } : {}),
        });
        await client.query("release savepoint batch_item");
      } catch (error) {
        await client.query("rollback to savepoint batch_item");
        errors.push({ index, message: errorMessage(error) });
      }
    }
    const body: BatchResult =
      validation === "permissive" ? { data, errors } : { data };
    if (idemKey) {
      await client.query(
        "update idempotency_keys set response_json = $3, state = 'done' where tenant_id = $1 and key = $2",
        [context.tenant_id, idemKey, JSON.stringify(body)],
      );
    }
    return body;
  });
}

// A ZodError's own message is a JSON dump of every issue. The first issue's text is what a caller can act on.
function errorMessage(error: unknown) {
  const issues = (
    error as {
      issues?: Array<{ message?: string; path?: Array<string | number> }>;
    }
  ).issues;
  if (Array.isArray(issues) && issues[0]?.message) {
    const path = (issues[0].path ?? []).join(".");
    return path && !issues[0].message.includes(path)
      ? `${path}: ${issues[0].message}`
      : issues[0].message;
  }
  return error instanceof Error ? error.message : "Invalid email";
}

const attachmentByteLimit = 40 * 1024 * 1024;

async function resolveAttachments(
  attachments: Array<{
    filename: string;
    content?: string;
    path?: string;
    content_type?: string;
    content_id?: string;
    disposition?: "attachment" | "inline";
  }>,
  fetchImpl: AcceptEmailOptions["fetchAttachment"] = fetchAttachment,
) {
  let remaining = attachmentByteLimit;
  const resolved = [];
  for (const attachment of attachments) {
    const contentType =
      attachment.content_type ?? contentTypeForFilename(attachment.filename);
    if (attachment.path) {
      const bytes = await fetchImpl(attachment.path, remaining);
      remaining -= bytes.byteLength;
      resolved.push({
        ...attachment,
        content: bytes.toString("base64"),
        content_type: contentType,
      });
      continue;
    }
    resolved.push({
      ...attachment,
      content: attachment.content ?? "",
      content_type: contentType,
    });
  }
  return resolved;
}

export async function fetchAttachment(
  path: string,
  remaining: number,
  // Refuses a private address at the moment it connects, not only in the check below.
  fetchImpl: typeof fetch = publicFetch as typeof fetch,
) {
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    throw new ApiError(
      "invalid_attachment",
      422,
      "Attachment path must be http or https",
    );
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ApiError(
      "invalid_attachment",
      422,
      "Attachment path must be http or https",
    );
  }
  try {
    await assertPublicWebhookTarget(url.hostname);
  } catch {
    throw new ApiError(
      "invalid_attachment",
      422,
      "Attachment host is not allowed",
    );
  }
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new ApiError(
      "invalid_attachment",
      422,
      `Attachment fetch failed with ${response.status}`,
    );
  }
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > remaining) {
    throw new ApiError("invalid_attachment", 422, "Attachments exceed 40 MB");
  }
  // A server that sends no content-length can stream without end. Count the bytes as they arrive
  // and stop reading at the limit, so the body is never buffered past it.
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > remaining) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError("invalid_attachment", 422, "Attachments exceed 40 MB");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

function prepareAttachments(
  tenantId: string,
  ownerId: string,
  attachments: Array<{
    filename: string;
    content: string;
    content_type?: string;
    content_id?: string;
    disposition?: "attachment" | "inline";
  }>,
) {
  let total = 0;
  return attachments.map((attachment) => {
    const bytes = decodeAttachment(attachment.content);
    total += Buffer.byteLength(attachment.content, "utf8");
    if (total > attachmentByteLimit) {
      throw new ApiError(
        "invalid_attachment",
        422,
        "Attachments exceed 40 MB after base64 encoding",
      );
    }
    const attachmentId = id("att");
    return {
      id: attachmentId,
      filename: attachment.filename,
      content_type: attachment.content_type ?? "application/octet-stream",
      content_id: attachment.content_id,
      disposition: attachment.disposition ?? "attachment",
      size_bytes: bytes.byteLength,
      content_hash: hash(bytes.toString("base64")),
      storage_key: `attachments/${tenantId}/${ownerId}/${attachmentId}`,
      bytes,
    } satisfies StoredAttachment;
  });
}

function decodeAttachment(content: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content) || content.length % 4 !== 0) {
    throw new ApiError(
      "invalid_attachment",
      422,
      "Attachment content must be base64",
    );
  }
  const bytes = Buffer.from(content, "base64");
  if (
    bytes.length === 0 ||
    bytes.toString("base64").replace(/=+$/, "") !== content.replace(/=+$/, "")
  ) {
    throw new ApiError(
      "invalid_attachment",
      422,
      "Attachment content must be base64",
    );
  }
  return bytes;
}
