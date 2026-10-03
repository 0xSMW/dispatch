import "@dispatchmail/core/env";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ApiError, hash, rateKey, rateLimitValue, requestId, requireSecret, requireUrl, reservedHeader, type SendInput } from "@dispatchmail/core";
import {
  acceptEmail,
  connect,
  findApiKey,
  type Db,
  type Queryable,
} from "@dispatchmail/db";
import { createStorage, type Storage } from "@dispatchmail/storage";
import { Redis } from "ioredis";
import PostalMime, {
  type Address,
  type Attachment,
  type Email,
  type Mailbox,
} from "postal-mime";
import {
  SMTPServer,
  type SMTPServerDataStream,
  type SMTPServerEnvelope,
} from "smtp-server";

export const usernames = ["dispatch", "resend"];
export const maxBytes = 40 * 1024 * 1024;
export const maxRecipients = 50;


export type Auth = {
  tenant_id: string;
  api_key_id: string;
  scope: "full" | "send";
  domain_name: string | null;
};

export type Reply = { code: number; message: string };

export type Envelope = Pick<SMTPServerEnvelope, "rcptTo"> & {
  mailFrom?: SMTPServerEnvelope["mailFrom"];
};

export type Deps = {
  db: Db | Queryable;
  storage: Pick<Storage, "put">;
  pepper: string;
  publicUrl?: string;
  limit?: (tenantId: string) => Promise<void>;
  accept?: typeof acceptEmail;
};

// Headers that postal-mime already maps to send fields, or that describe the
// MIME structure and transport. Everything else passes through as a custom header.
const skipped = new Set([
  "from",
  "sender",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "received",
  "return-path",
  "delivered-to",
  "dkim-signature",
  "x-mailer",
  "dispatch-idempotency-key",
  "resend-idempotency-key",
]);

export async function authenticate(
  deps: Pick<Deps, "db" | "pepper">,
  username?: string,
  password?: string,
): Promise<Auth> {
  if (!username || !usernames.includes(username.trim().toLowerCase())) {
    throw new ApiError(
      "invalid_api_key",
      403,
      "Username must be dispatch or resend",
    );
  }
  const secret = password?.trim();
  if (!secret) throw new ApiError("missing_api_key", 401, "Missing API key");
  const key = await findApiKey(deps.db, secret, deps.pepper);
  if (!key) throw new ApiError("invalid_api_key", 403, "Invalid API key");
  const lastUsed = key.last_used_at ? new Date(key.last_used_at).getTime() : 0;
  if (Date.now() - lastUsed > 60_000) {
    await deps.db.query(
      "update api_keys set last_used_at = now() where id = $1",
      [key.id],
    );
  }
  return {
    tenant_id: key.tenant_id,
    api_key_id: key.id,
    scope: key.scope,
    domain_name: key.domain_name,
  };
}

export async function handleMessage(
  deps: Deps,
  auth: Auth,
  raw: Buffer,
  envelope: Envelope,
) {
  if (raw.byteLength > maxBytes) throw tooLarge();
  if (envelope.rcptTo.length > maxRecipients) throw tooMany();
  if (deps.limit) await deps.limit(auth.tenant_id);

  // A message the parser cannot read will not parse on a retry either, so it is a permanent
  // failure. Left as a plain error it would get a 451 and the client would retry it for days.
  let email: Email;
  try {
    email = await PostalMime.parse(raw);
  } catch (error) {
    throw new ApiError("validation_error", 422, `Message could not be parsed: ${error instanceof Error ? error.message : "invalid MIME"}`);
  }
  const inputs = toSendInputs(email, envelope);
  if (inputs.length === 0) throw new ApiError("validation_error", 422, "The message has no recipients");

  const accept = deps.accept ?? acceptEmail;
  const key = deliveryKey(email, envelope);
  const ids: string[] = [];
  for (const [index, input] of inputs.entries()) {
    // AUTH can outlive a key's authority. Check each acceptance, including later
    // messages on the same connection, and use the current domain restriction.
    const current = await deps.db.query<Auth & { domain_id: string | null }>(
      `select k.id as api_key_id, k.tenant_id, k.scope, k.domain_id, d.name as domain_name
       from api_keys k
       left join domains d on d.id = k.domain_id and d.tenant_id = k.tenant_id
       where k.id = $1 and k.tenant_id = $2 and k.revoked_at is null`,
      [auth.api_key_id, auth.tenant_id],
    );
    const authority = current.rows[0];
    if (!authority) throw new ApiError("invalid_api_key", 403, "Invalid API key");
    if (!["full", "send"].includes(authority.scope) || (authority.domain_id && !authority.domain_name)) {
      throw new ApiError("restricted_api_key", 403, "API key cannot send email");
    }
    const result = await accept(
      deps.db,
      input,
      {
        tenant_id: auth.tenant_id,
        api_key_id: auth.api_key_id,
        request_id: requestId(),
        // One key per email this message becomes.
        idempotency_key: key && inputs.length > 1 ? `${key}:${index}` : key,
        domain_name: authority.domain_name,
      },
      {
        publicUrl: deps.publicUrl,
        storeAttachment: (storageKey, bytes) => deps.storage.put(storageKey, bytes),
      },
    );
    ids.push(result.email.id);
  }
  return ids[0]!;
}

// Turns one SMTP message into the emails to send.
//
// The envelope decides who receives it. A header recipient the envelope does not name is
// dropped, so a client that sends one message in several envelopes causes no duplicates.
// An envelope recipient that neither To nor Cc names is a hidden recipient. Beside visible
// recipients it goes out as Bcc. When nobody is visible, each hidden recipient gets an email of
// their own: putting them together in To would show each of them the others' addresses.
export function toSendInputs(email: Email, envelope: Envelope): SendInput[] {
  const from = mailboxes(email.from ? [email.from] : [])[0];
  const envelopeFrom = envelope.mailFrom ? envelope.mailFrom.address : "";
  const accepted = new Set(
    envelope.rcptTo.map(({ address }) => address.toLowerCase()).filter(Boolean),
  );
  const delivered = (list: string[]) =>
    accepted.size === 0 ? list : list.filter((value) => accepted.has(value.toLowerCase()));
  let to = delivered(addresses(email.to));
  let cc = delivered(addresses(email.cc));

  const visible = new Set([...to, ...cc].map((value) => value.toLowerCase()));
  const hidden: string[] = [];
  for (const address of [...delivered(addresses(email.bcc)), ...envelope.rcptTo.map((item) => item.address)]) {
    if (!address || visible.has(address.toLowerCase())) continue;
    visible.add(address.toLowerCase());
    hidden.push(address);
  }
  // The Cc recipients were visible to each other anyway, so with no To they take its place.
  if (to.length === 0 && cc.length > 0) {
    to = cc;
    cc = [];
  }

  const replyTo = mailboxes(email.replyTo ?? []).map(format);
  const headers = customHeaders(email);
  // An empty part carries nothing and the API refuses a zero-byte attachment.
  const attachments = (email.attachments ?? []).map(toAttachment).filter((attachment) => attachment.content.length > 0);

  const base: Omit<SendInput, "to"> = {
    from: from ? format(from) : envelopeFrom,
    subject: email.subject || undefined,
    html: email.html || undefined,
    // A message that is only an attachment, as a scanner sends, still needs a body.
    text: email.text || (!email.html && attachments.length > 0 ? " " : undefined),
  };
  if (replyTo.length) base.reply_to = replyTo;
  if (Object.keys(headers).length) base.headers = headers;
  if (attachments.length) base.attachments = attachments;

  if (to.length > 0) {
    if ([...to, ...cc, ...hidden].length > maxRecipients) throw tooMany();
    const input: SendInput = { ...base, to };
    if (cc.length) input.cc = cc;
    if (hidden.length) input.bcc = hidden;
    return [input];
  }
  return hidden.map((address) => ({ ...base, to: [address] }));
}

// The key that makes a retry of this delivery return the first result.
//
// A client's own key is scoped to the envelope, because one message sent in two envelopes is
// two deliveries with the same header. With no header, the Message-ID and the envelope stand in:
// an SMTP client that never saw our 250 sends the same bytes again, and the recipient must not
// get a second copy.
export function deliveryKey(email: Pick<Email, "headers" | "messageId">, envelope: Envelope) {
  const recipients = hash(
    envelope.rcptTo
      .map(({ address }) => address.toLowerCase())
      .sort()
      .join(","),
  ).slice(0, 16);
  const given = idempotencyKey(email);
  if (given !== undefined) return `${given}:${recipients}`.slice(0, 256);
  const messageId = email.messageId?.trim();
  return messageId ? `smtp:${hash(messageId).slice(0, 32)}:${recipients}` : undefined;
}

export function idempotencyKey(email: Pick<Email, "headers">) {
  const find = (key: string) =>
    (email.headers ?? []).find((item) => item.key === key);
  const header =
    find("dispatch-idempotency-key") ?? find("resend-idempotency-key");
  const value = header?.value.trim();
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 256) {
    throw new ApiError(
      "invalid_idempotency_key",
      400,
      "Idempotency key must be 1-256 characters",
    );
  }
  return value;
}

export function recipientReply(count: number): Reply | null {
  if (count < maxRecipients) return null;
  return { code: 452, message: "4.5.3 Too many recipients, 50 at most" };
}

export function smtpReply(error: unknown): Reply {
  if (error instanceof ApiError || isApiError(error)) {
    const { name, statusCode, message } = error as ApiError;
    if (["missing_api_key", "invalid_api_key", "restricted_api_key"].includes(name)) {
      return { code: 535, message: `5.7.8 ${message}` };
    }
    if (name === "rate_limit_exceeded" || statusCode === 429) {
      return { code: 451, message: `4.7.1 ${message}, try again later` };
    }
    if (name === "message_too_large" || statusCode === 413 || /exceed 40 MB/i.test(message)) {
      return { code: 552, message: `5.3.4 ${message}` };
    }
    if (name === "concurrent_idempotent_requests") {
      return { code: 451, message: `4.5.0 ${message}` };
    }
    if (statusCode >= 500) {
      return { code: 451, message: "4.3.0 Temporary server error, try again later" };
    }
    return { code: 550, message: `5.6.0 ${message}` };
  }
  if (isZodError(error)) {
    const issue = error.issues[0];
    const path = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    return { code: 550, message: `5.6.0 ${path}${issue?.message ?? "Invalid message"}` };
  }
  return { code: 451, message: "4.3.0 Temporary server error, try again later" };
}

export function createServer(
  deps: Deps,
  options: { secure?: boolean; key?: Buffer; cert?: Buffer; allowInsecureAuth?: boolean } = {},
) {
  // smtp-server merges these over its self-signed defaults, so an explicit
  // undefined would erase the fallback certificate.
  const tls = options.key && options.cert ? { key: options.key, cert: options.cert } : {};
  return new SMTPServer({
    ...tls,
    secure: options.secure ?? false,
    ...(process.env.SMTP_HOSTNAME ? { name: process.env.SMTP_HOSTNAME } : {}),
    banner: "Dispatch SMTP relay",
    // Each message is held in memory while it is parsed, several copies deep. The cap keeps a
    // burst of large messages from exhausting the process.
    maxClients: Number(process.env.SMTP_MAX_CLIENTS ?? 50),
    authMethods: ["PLAIN", "LOGIN"],
    allowInsecureAuth: options.allowInsecureAuth ?? false,
    size: maxBytes,
    onAuth(auth, _session, callback) {
      authenticate(deps, auth.username, auth.password).then(
        (user) => callback(null, { user }),
        (error) => callback(replyError(error)),
      );
    },
    onRcptTo(_address, session, callback) {
      const reply = recipientReply(session.envelope.rcptTo.length);
      callback(reply ? toError(reply) : null);
    },
    onData(stream, session, callback) {
      const auth = session.user as unknown as Auth;
      read(stream)
        .then((raw) => handleMessage(deps, auth, raw, session.envelope))
        .then(
          (emailId) => callback(null, `Queued as ${emailId}`),
          (error) => callback(replyError(error)),
        );
    },
  });
}

// The same per-tenant bucket the API counts into, so mail sent over SMTP and over HTTP share
// one limit. Over the limit the client gets a 451 and tries again.
export async function rateLimit(
  redis: { multi(): { incr(key: string): unknown; expire(key: string, seconds: number): unknown; exec(): Promise<Array<[Error | null, unknown]> | null> } },
  tenantId: string,
  now = Date.now(),
) {
  const key = rateKey(tenantId, now);
  const pipeline = redis.multi();
  pipeline.incr(key);
  pipeline.expire(key, 2);
  const results = await pipeline.exec();
  const count = Number(results?.[0]?.[1] ?? 0);
  if (count > rateLimitValue()) throw new ApiError("rate_limit_exceeded", 429, "Rate limit exceeded");
}

function read(stream: SMTPServerDataStream) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    stream.on("end", () => {
      if (stream.sizeExceeded || size > maxBytes) reject(tooLarge());
      else resolve(Buffer.concat(chunks));
    });
    stream.on("error", reject);
  });
}

function replyError(error: unknown) {
  return toError(smtpReply(error));
}

function toError(reply: Reply) {
  return Object.assign(new Error(reply.message), { responseCode: reply.code });
}

function tooLarge() {
  return new ApiError("message_too_large", 413, "Message exceeds 40 MB");
}

function tooMany() {
  return new ApiError(
    "validation_error",
    422,
    "An email can have at most 50 recipients",
  );
}

function isApiError(error: unknown) {
  return (
    error instanceof Error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

function isZodError(
  error: unknown,
): error is { issues: Array<{ path?: Array<string | number>; message: string }> } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

function mailboxes(list: Address[] = []): Mailbox[] {
  return list.flatMap((item) => (item.group ? item.group : [item])).filter((item) => item.address);
}

function addresses(list?: Address[]) {
  return mailboxes(list).map((item) => item.address);
}

function format(mailbox: Mailbox) {
  const name = mailbox.name.replace(/["<>]/g, "").trim();
  return name ? `${name} <${mailbox.address}>` : mailbox.address;
}

function customHeaders(email: Email) {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const header of email.headers ?? []) {
    if (skipped.has(header.key) || header.key.startsWith("content-") || reservedHeader(header.key)) continue;
    if (seen.has(header.key)) continue;
    seen.add(header.key);
    headers[header.originalKey] = header.value;
  }
  return headers;
}

// A part with no file name gets one a mail client can open, such as a calendar invite.
const extensions: Record<string, string> = {
  "text/calendar": ".ics",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "application/json": ".json",
};

function toAttachment(attachment: Attachment) {
  const content = Buffer.from(
    typeof attachment.content === "string"
      ? Buffer.from(attachment.content, attachment.encoding === "base64" ? "base64" : "utf8")
      : new Uint8Array(attachment.content),
  ).toString("base64");
  const contentId = attachment.contentId?.replace(/^<|>$/g, "") || undefined;
  const inline = Boolean(contentId) && attachment.disposition !== "attachment";
  return {
    filename: attachment.filename || (inline ? contentId! : `attachment${extensions[attachment.mimeType ?? ""] ?? ""}`),
    content,
    content_type: attachment.mimeType || undefined,
    ...(contentId ? { content_id: contentId } : {}),
    disposition: inline ? ("inline" as const) : ("attachment" as const),
  };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/** The ports in a setting such as "587,2587", or `fallback` when it is unset or empty. */
export function ports(value: string | undefined, fallback: number[]): number[] {
  const listed = (value ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return listed.length ? [...new Set(listed)] : fallback;
}

function main() {
  const production = process.env.NODE_ENV === "production";
  const pepper = requireSecret("API_KEY_PEPPER");
  const certPath = process.env.SMTP_TLS_CERT;
  const keyPath = process.env.SMTP_TLS_KEY;
  const tls =
    certPath && keyPath
      ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
      : undefined;
  if (!tls && production) {
    console.warn(
      "SMTP_TLS_CERT and SMTP_TLS_KEY are not set: STARTTLS uses a self-signed certificate and port 465 is off",
    );
  }

  const db = connect();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true, maxRetriesPerRequest: 1 });
  const deps: Deps = {
    db,
    storage: createStorage(),
    pepper,
    publicUrl: requireUrl("PUBLIC_URL", "http://localhost:3100"),
    limit: (tenantId) => rateLimit(redis, tenantId),
  };
  const allowInsecureAuth = !production;
  const servers: SMTPServer[] = [];

  // Each setting takes one port or several, separated by commas. The defaults are the pairs
  // Resend offers: 587 and 2587 for STARTTLS, 465 and 2465 for TLS. The high ports are for
  // networks that block the low ones.
  for (const port of ports(process.env.SMTP_PORT, [587, 2587])) {
    const starttls = createServer(deps, { ...tls, allowInsecureAuth });
    starttls.on("error", (error) => console.error("smtp", port, error));
    starttls.listen(port, () => console.log(`SMTP relay on ${port} (STARTTLS)`));
    servers.push(starttls);
  }

  if (tls) {
    for (const port of ports(process.env.SMTP_TLS_PORT, [465, 2465])) {
      const implicit = createServer(deps, { ...tls, secure: true });
      implicit.on("error", (error) => console.error("smtp", port, error));
      implicit.listen(port, () => console.log(`SMTP relay on ${port} (TLS)`));
      servers.push(implicit);
    }
  }

  const stop = () => {
    let open = servers.length;
    for (const server of servers) {
      server.close(() => {
        open -= 1;
        if (open === 0) {
          redis.disconnect();
          void db.end().then(() => process.exit(0));
        }
      });
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (isMain()) main();
