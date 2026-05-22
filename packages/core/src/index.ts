import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";

export type Scope = "full" | "send";
export type EmailStatus =
  | "scheduled"
  | "queued"
  | "submitted"
  | "sent"
  | "delivery_delayed"
  | "delivered"
  | "bounced"
  | "complained"
  | "opened"
  | "clicked"
  | "suppressed"
  | "failed"
  | "cancelled";

export type EventType =
  | "email.scheduled"
  | "email.sent"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.bounced"
  | "email.complained"
  | "email.failed"
  | "email.opened"
  | "email.clicked"
  | "email.suppressed"
  | "email.received";

export const emailEvents: EventType[] = [
  "email.scheduled",
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.opened",
  "email.clicked",
  "email.suppressed",
  "email.received"
];

const attachmentPayloadLimit = 40 * 1024 * 1024;
const htmlRequired = { message: "html or text is required", path: ["html"] };
const subjectRequired = { message: "subject is required without a template", path: ["subject"] };

const attachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content: z.string().min(1).max(attachmentPayloadLimit),
  content_type: z.string().min(1).max(120).default("application/octet-stream"),
  content_id: z.string().min(1).max(255).optional(),
  disposition: z.enum(["attachment", "inline"]).default("attachment")
});

export const baseSendSchema = z
  .object({
    from: z.string().email(),
    to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
    cc: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]).optional(),
    bcc: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]).optional(),
    subject: z.string().min(1).max(998).optional(),
    html: z.string().max(1_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    attachments: z.array(attachmentSchema).max(20).optional(),
    template: z.string().min(1).max(120).optional(),
    variables: z.record(z.unknown()).optional(),
    headers: z.record(z.string()).optional(),
    tags: z.record(z.string()).optional(),
    scheduled_at: z.string().datetime().optional()
  })
  .strict();

export const sendSchema = baseSendSchema
  .refine(hasMessageContent, { message: "html, text, or template is required", path: ["html"] })
  .refine(hasSubjectOrTemplate, subjectRequired);

export type SendInput = z.infer<typeof sendSchema>;

export const emailUpdateSchema = z
  .object({
    subject: z.string().min(1).max(998).optional(),
    html: z.string().max(1_000_000).nullable().optional(),
    text: z.string().max(1_000_000).nullable().optional(),
    headers: z.record(z.string()).optional(),
    tags: z.record(z.string()).optional(),
    scheduled_at: z.string().datetime().nullable().optional()
  })
  .strict();

export const batchSchema = z.object({
  emails: z
    .array(
      baseSendSchema
        .omit({ scheduled_at: true })
        .extend({ attachments: z.never().optional() })
        .refine(hasMessageContent, htmlRequired)
        .refine(hasSubjectOrTemplate, subjectRequired)
    )
    .min(1)
    .max(100)
});

export const domainSchema = z.object({
  name: z.string().min(3).max(253),
  region: z.string().min(3).default("us-east-1")
});

export const keySchema = z.object({
  name: z.string().min(1).max(80),
  scope: z.enum(["full", "send"]).default("full")
});

export const userSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120)
});

export const userUpdateSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).max(120).optional(),
  active: z.boolean().optional()
});

export const roleSchema = z.object({
  name: z.string().min(1).max(80),
  permissions: z.array(z.string().min(1).max(120)).default(["full"])
});

export const roleUpdateSchema = roleSchema.partial();

export const membershipSchema = z.object({
  user_id: z.string().min(1),
  role_id: z.string().min(1)
});

export const sessionSchema = z.object({
  email: z.string().email(),
  api_key: z.string().min(1)
});

export const webhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(emailEvents as [EventType, ...EventType[]])).min(1).default(["email.sent", "email.delivered"])
});

const baseTemplateSchema = z
  .object({
    name: z.string().min(1).max(120),
    alias: z.string().min(1).max(120).optional(),
    subject: z.string().min(1).max(998),
    html: z.string().max(1_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    variables: z.array(z.string().min(1).max(80)).default([])
  });

export const templateSchema = baseTemplateSchema.refine(hasHtmlOrText, htmlRequired);

export const templateUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  alias: z.string().min(1).max(120).nullable().optional()
});

export const templateVersionSchema = baseTemplateSchema.omit({ name: true, alias: true }).refine(hasHtmlOrText, htmlRequired);

export const renderSchema = z.object({
  variables: z.record(z.unknown()).default({})
});

export const contactSchema = z.object({
  email: z.string().email(),
  first_name: z.string().max(120).optional(),
  last_name: z.string().max(120).optional(),
  properties: z.record(z.unknown()).default({}),
  unsubscribed: z.boolean().default(false)
});

export const contactUpdateSchema = contactSchema.partial().omit({ email: true });

export const suppressionSchema = z.object({
  email: z.string().email(),
  reason: z.string().min(1).max(120).default("manual")
});

export const topicSchema = z.object({
  name: z.string().min(1).max(120),
  key: z.string().min(1).max(120).optional(),
  default_status: z.enum(["subscribed", "unsubscribed"]).default("subscribed")
});

export const topicUpdateSchema = topicSchema.partial();

export const subscriptionSchema = z.object({
  email: z.string().email(),
  status: z.enum(["subscribed", "unsubscribed"]).default("subscribed")
});

export const segmentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional()
});

export const segmentUpdateSchema = segmentSchema.partial();

export const segmentContactSchema = z.object({
  email: z.string().email()
});

const baseBroadcastSchema = z
  .object({
    name: z.string().min(1).max(120),
    from: z.string().email(),
    subject: z.string().min(1).max(998).optional(),
    html: z.string().max(1_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    template: z.string().min(1).max(120).optional(),
    variables: z.record(z.unknown()).default({}),
    topic_id: z.string().min(1).optional(),
    segment_id: z.string().min(1).optional()
  })
  .strict();

export const broadcastSchema = baseBroadcastSchema
  .refine(hasMessageContent, { message: "html, text, or template is required", path: ["html"] })
  .refine(hasSubjectOrTemplate, subjectRequired);

export const broadcastUpdateSchema = baseBroadcastSchema.partial();

export const customEventSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  data: z.record(z.unknown()).default({})
});

export const customEventUpdateSchema = customEventSchema.partial();

const automationStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send_email"),
    from: z.string().email(),
    to: z.string().email().optional(),
    template: z.string().min(1).max(120),
    variables: z.record(z.unknown()).default({})
  }),
  z.object({
    type: z.literal("update_contact"),
    email: z.string().email().optional(),
    properties: z.record(z.unknown()).default({}),
    unsubscribed: z.boolean().optional()
  }),
  z.object({
    type: z.literal("add_to_segment"),
    segment_id: z.string().min(1),
    email: z.string().email().optional()
  }),
  z.object({
    type: z.literal("delay"),
    seconds: z.number().int().min(1).max(86_400)
  }),
  z.object({
    type: z.literal("wait"),
    event: z.string().min(1).max(120),
    timeout_seconds: z.number().int().min(1).max(86_400).optional()
  })
]);

export const automationSchema = z.object({
  name: z.string().min(1).max(120),
  trigger: z.string().min(1).max(120),
  steps: z.array(automationStepSchema).min(1).max(20)
});

export const automationUpdateSchema = automationSchema.partial().extend({
  enabled: z.boolean().optional()
});

export const inboundSchema = z
  .object({
    from: z.string().email(),
    to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
    cc: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]).optional(),
    bcc: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]).optional(),
    subject: z.string().min(1).max(998),
    html: z.string().max(1_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    headers: z.record(z.string()).default({}),
    attachments: z.array(attachmentSchema.omit({ content_id: true, disposition: true })).max(20).default([])
  })
  .refine(hasHtmlOrText, htmlRequired);

export type InboundInput = z.infer<typeof inboundSchema>;

function hasHtmlOrText(value: { html?: unknown; text?: unknown }) {
  return Boolean(value.html || value.text);
}

function hasMessageContent(value: { template?: unknown; subject?: unknown; html?: unknown; text?: unknown }) {
  return Boolean(value.template || (value.subject && hasHtmlOrText(value)));
}

function hasSubjectOrTemplate(value: { template?: unknown; subject?: unknown }) {
  return Boolean(value.template || value.subject);
}

export class ApiError extends Error {
  statusCode: number;
  name: string;

  constructor(name: string, statusCode: number, message: string) {
    super(message);
    this.name = name;
    this.statusCode = statusCode;
  }
}

export function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function requestId() {
  return id("req");
}

export function list<T>(data: T[], has_more = false) {
  return { object: "list", has_more, data };
}

export function toArray(value?: string | string[]) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableHash(value: unknown) {
  return hash(JSON.stringify(sortJson(value)));
}

export function makeKey() {
  const secret = `sk_${randomBytes(24).toString("base64url")}`;
  const prefix = secret.slice(0, 12);
  return { secret, prefix };
}

export function keyHash(secret: string, pepper: string) {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

export function sign(payload: string, secret: string, idValue = id("evt"), timestamp = Math.floor(Date.now() / 1000)) {
  const content = `${idValue}.${timestamp}.${payload}`;
  const signature = createHmac("sha256", secret).update(content).digest("base64url");
  return { id: idValue, timestamp, signature };
}

export function verify(payload: string, secret: string, idValue: string, timestamp: string, signature: string) {
  const expected = sign(payload, secret, idValue, Number(timestamp)).signature;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function renderTemplate(
  fields: { subject: string; html?: string | null; text?: string | null; variables?: string[] | null },
  variables: Record<string, unknown>
) {
  const required = new Set([...(fields.variables ?? []), ...templateKeys(fields.subject), ...templateKeys(fields.html), ...templateKeys(fields.text)]);
  const missing = [...required].filter((key) => variables[key] === undefined || variables[key] === null);
  if (missing.length > 0) throw new ApiError("missing_variable", 400, `Missing template variable: ${missing[0]}`);

  return {
    subject: renderString(fields.subject, variables),
    html: fields.html ? renderString(fields.html, variables) : undefined,
    text: fields.text ? renderString(fields.text, variables) : undefined
  };
}

export function prepareTracking(html: string, publicUrl: string) {
  const tokens: Array<{ token: string; kind: "open" | "click"; url?: string }> = [];
  let nextHtml = html.replace(/href=(["'])(https?:\/\/[^"']+)\1/g, (_match, quote: string, url: string) => {
    const token = id("track");
    tokens.push({ token, kind: "click", url });
    return `href=${quote}${publicUrl}/click/${token}${quote}`;
  });

  const openToken = id("track");
  tokens.push({ token: openToken, kind: "open" });
  const pixel = `<img src="${publicUrl}/open/${openToken}.gif" width="1" height="1" alt="" style="display:none" />`;
  nextHtml = /<\/body>/i.test(nextHtml) ? nextHtml.replace(/<\/body>/i, `${pixel}</body>`) : `${nextHtml}${pixel}`;
  return { html: nextHtml, tokens };
}

export async function normalizeWebhookUrl(value: string, options: { requireHttps?: boolean; allowPrivate?: boolean } = {}) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid webhook URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Webhook URL must be http or https");
  if (options.requireHttps && url.protocol !== "https:") throw new Error("Webhook URL must use https in production");
  if (!options.allowPrivate) await assertPublicWebhookTarget(url.hostname);
  url.hash = "";
  return url.toString();
}

export async function assertPublicWebhookTarget(host: string) {
  if (blockedWebhookHost(host)) throw new Error("Webhook URL host is not allowed");
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(value)) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(value, { all: true, verbatim: true });
  } catch {
    throw new Error("Webhook URL host could not be resolved");
  }
  if (addresses.some((address) => blockedWebhookHost(address.address))) throw new Error("Webhook URL host is not allowed");
}

export function blockedWebhookHost(host: string) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (value.startsWith("::ffff:")) return blockedWebhookHost(value.slice(7));
  if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return true;
  if (value === "localhost" || value.endsWith(".localhost") || value === "::1") return true;
  if (value === "0.0.0.0" || value.startsWith("127.") || value.startsWith("10.") || value.startsWith("192.168.")) return true;
  if (value.startsWith("169.254.")) return true;
  const parts = value.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
  }
  const match = value.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function templateKeys(value?: string | null) {
  if (!value) return [];
  return [...value.matchAll(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g)].map((match) => match[1]);
}

function renderString(value: string, variables: Record<string, unknown>) {
  return value.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, key: string) => String(variables[key]));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  return value;
}
