export { awsCredentials } from "./aws.js";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { lookup as lookupCallback, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as agentFetch } from "undici";
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
  | "email.received"
  | "email.unsubscribed"
  | "automation.run.started"
  | "automation.run.completed"
  | "automation.run.failed"
  | "contact.created"
  | "contact.updated"
  | "contact.deleted"
  | "contact.topics.updated"
  | "domain.created"
  | "domain.updated"
  | "domain.deleted"
  | "suppression.added"
  | "suppression.removed"
  | "topic.created"
  | "topic.updated"
  | "topic.deleted";

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
  "email.received",
  "email.unsubscribed",
  "automation.run.started",
  "automation.run.completed",
  "automation.run.failed",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "contact.topics.updated",
  "domain.created",
  "domain.updated",
  "domain.deleted",
  "suppression.added",
  "suppression.removed",
  "topic.created",
  "topic.updated",
  "topic.deleted"
];

const attachmentPayloadLimit = 40 * 1024 * 1024;
const htmlRequired = { message: "html or text is required", path: ["html"] };
const subjectRequired = { message: "subject is required without a template", path: ["subject"] };

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).optional(),
  before: z.string().min(1).optional()
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const recipientsSchema = z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]);

const addressPattern = /^\s*(?:"?([^"<>]*?)"?\s*)<([^<>\s]+)>\s*$/;

export function parseAddress(value: string) {
  const match = value.match(addressPattern);
  const email = (match ? match[2] : value).trim();
  const name = match?.[1]?.trim() || null;
  return { email, name };
}

// RFC 2047 caps an encoded word at 75 characters, so a long name is split between characters.
function encodedWords(text: string) {
  const words: string[] = [];
  let word = "";
  for (const char of text) {
    if (Buffer.byteLength(word + char, "utf8") > 45) {
      words.push(word);
      word = "";
    }
    word += char;
  }
  if (word) words.push(word);
  return words.map((part) => `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`).join(" ");
}

// Builds the header form of an address. A display name with a comma or other RFC 5322 special is
// quoted, and a name outside ASCII is encoded, so "Acme, Inc" never reads as two addresses.
export function formatAddress(email: string, name?: string | null) {
  const clean = (name ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!clean) return email;
  if (/[^\x20-\x7e]/.test(clean)) return `${encodedWords(clean)} <${email}>`;
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(clean)) return `${clean} <${email}>`;
  return `"${clean.replace(/(["\\])/g, "\\$1")}" <${email}>`;
}

const address = z
  .string()
  .max(998)
  .refine((value) => !/[\r\n]/.test(value), "must not contain line breaks")
  .refine((value) => z.string().email().safeParse(parseAddress(value).email).success, "must be email@domain or Name <email@domain>");

const addresses = z.union([address, z.array(address).min(1).max(50)]);

const tagText = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const tags = z
  .union([z.record(tagText, tagText), z.array(z.object({ name: tagText, value: tagText })).max(75)])
  .transform((value) => (Array.isArray(value) ? Object.fromEntries(value.map((tag) => [tag.name, tag.value])) : value))
  .refine((value) => Object.keys(value).length <= 75, "An email can have at most 75 tags");

const templateRef = z
  .union([
    z.string().min(1).max(120),
    z.object({ id: z.string().min(1).max(120), variables: z.record(z.string(), z.unknown()).optional() })
  ])
  .transform((value): { id: string; variables?: Record<string, unknown> } => (typeof value === "string" ? { id: value } : value));

const contentTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  ics: "text/calendar"
};

export function contentTypeForFilename(filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return contentTypes[extension] ?? "application/octet-stream";
}

const attachmentSchema = z
  .object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1).max(attachmentPayloadLimit).optional(),
    path: z.string().url().optional(),
    content_type: z.string().min(1).max(120).optional(),
    content_id: z.string().min(1).max(127).optional(),
    disposition: z.enum(["attachment", "inline"]).optional()
  })
  .refine((value) => Boolean(value.content) !== Boolean(value.path), {
    message: "Attachment must have either a `content` or `path`.",
    path: ["content"]
  });

// SES reads X-SES-* headers on a raw message as instructions: which configuration set to use,
// which tags to put on its events. A sender must not be able to set those.
export function reservedHeader(name: string) {
  return /^x-ses-/i.test(name.trim());
}

const customHeaders = z
  .record(z.string(), z.string())
  .refine((headers) => !Object.keys(headers).some(reservedHeader), "headers cannot start with X-SES-")
  .refine((headers) => !Object.entries(headers).some(([name, value]) => /[\r\n]/.test(name) || /[\r\n]/.test(value)), "headers cannot contain line breaks");

// One bucket per tenant per second, summed over every key and route, as Resend does. The API
// and the SMTP relay count into the same bucket.
export function rateKey(tenantId: string, now = Date.now()) {
  return `rate:${tenantId}:${Math.floor(now / 1000)}`;
}

export function rateLimitValue(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.RATE_LIMIT_PER_SECOND ?? 10);
  return Number.isFinite(value) && value > 0 ? value : 10;
}

// A person signed in to the dashboard counts into a bucket of their own, not the tenant's.
// One page loads several lists at once, and an application sending at its limit must not lock
// its own operators out.
export function sessionRateKey(tenantId: string, userId: string, now = Date.now()) {
  return `rate:${tenantId}:user:${userId}:${Math.floor(now / 1000)}`;
}

export function sessionRateLimitValue(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.SESSION_RATE_LIMIT_PER_SECOND ?? 40);
  return Number.isFinite(value) && value > 0 ? value : 40;
}

export const emailBodySchema = z.object({
  subject: z.string().min(1).max(998).optional(),
  html: z.string().max(1_000_000).optional(),
  text: z.string().max(1_000_000).optional()
});

export const baseSendSchema = z
  .object({
    from: address.optional(),
    to: addresses,
    cc: addresses.optional(),
    bcc: addresses.optional(),
    reply_to: addresses.optional(),
    subject: z.string().min(1).max(998).optional(),
    html: z.string().max(1_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    attachments: z.array(attachmentSchema).optional(),
    template: templateRef.optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
    headers: customHeaders.optional(),
    tags: tags.optional(),
    topic_id: z.string().min(1).optional(),
    scheduled_at: z.string().min(1).max(120).optional()
  })
  .strict();

export const sendSchema = baseSendSchema
  .refine((value) => Boolean(value.from || value.template), { message: "from is required without a template", path: ["from"] })
  .refine(hasMessageContent, { message: "html, text, or template is required", path: ["html"] })
  .refine(hasSubjectOrTemplate, subjectRequired)
  .refine((value) => !value.template || (value.html === undefined && value.text === undefined), {
    message: "html and text cannot be used with a template",
    path: ["html"]
  });

export type SendInput = z.input<typeof sendSchema>;
export type ParsedSend = z.infer<typeof sendSchema>;

export const emailUpdateSchema = z
  .object({
    subject: z.string().min(1).max(998).optional(),
    html: z.string().max(1_000_000).nullable().optional(),
    text: z.string().max(1_000_000).nullable().optional(),
    headers: customHeaders.optional(),
    tags: tags.optional(),
    scheduled_at: z.string().min(1).max(120).nullable().optional()
  })
  .strict();

const batchEmailSchema = baseSendSchema
  .omit({ attachments: true })
  .strict()
  .refine(hasMessageContent, htmlRequired)
  .refine(hasSubjectOrTemplate, subjectRequired);

export const batchSchema = z
  .union([z.array(batchEmailSchema).min(1).max(100), z.object({ emails: z.array(batchEmailSchema).min(1).max(100) })])
  .transform((value) => (Array.isArray(value) ? value : value.emails));

// The batch route checks only the shape of the list. Each email is validated on its own when it
// is accepted, so permissive mode can queue the valid ones and report the rest by index.
const batchItem = z.record(z.string(), z.unknown());
export const batchEnvelopeSchema = z
  .union([z.array(batchItem).min(1).max(100), z.object({ emails: z.array(batchItem).min(1).max(100) })])
  .transform((value) => (Array.isArray(value) ? value : value.emails));

export const domainRegions = ["us-west-2", "us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;
const subdomain = z.string().regex(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/i);
const capability = z.enum(["enabled", "disabled"]);

const hostnamePattern = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const settingsSchema = z.object({
  import_trigger_automations: z.boolean().default(false),
  sandbox_domains: z.array(
    z.string().trim().toLowerCase().refine((value) => hostnamePattern.test(value), "Use a hostname"),
  ).max(50).default([]),
}).strict();
export const settingsUpdateSchema = settingsSchema.partial();
export type Settings = z.infer<typeof settingsSchema>;

export const domainSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => hostnamePattern.test(value), "name must be a domain such as mail.example.com"),
  region: z.enum(domainRegions).default("us-east-1"),
  custom_return_path: subdomain.default("send"),
  open_tracking: z.boolean().default(false),
  click_tracking: z.boolean().default(false),
  tracking_subdomain: subdomain.optional(),
  tls: z.enum(["opportunistic", "enforced"]).default("opportunistic"),
  capabilities: z
    .object({
      sending: capability.default("enabled"),
      receiving: capability.default("disabled")
    })
    .default({ sending: "enabled", receiving: "disabled" })
    .refine((value) => value.sending === "enabled" || value.receiving === "enabled", "enable sending or receiving")
});

export const domainUpdateSchema = z
  .object({
    open_tracking: z.boolean().optional(),
    click_tracking: z.boolean().optional(),
    tracking_subdomain: subdomain.optional(),
    tls: z.enum(["opportunistic", "enforced"]).optional(),
    capabilities: z
      .object({
        sending: capability.optional(),
        receiving: capability.optional()
      })
      .optional()
  })
  .strict();

export const keySchema = z
  .object({
    name: z.string().min(1).max(50),
    scope: z.enum(["full", "send"]).optional(),
    permission: z.enum(["full_access", "sending_access"]).optional(),
    domain_id: z.string().min(1).optional()
  })
  .strict()
  .transform((value) => {
    const permission = value.permission ?? (value.scope === "send" ? "sending_access" : "full_access");
    return {
      name: value.name,
      permission,
      scope: permission === "sending_access" ? ("send" as const) : ("full" as const),
      domain_id: value.domain_id ?? null
    };
  })
  .refine((value) => value.domain_id === null || value.permission === "sending_access", {
    message: "domain_id is only allowed with sending_access",
    path: ["domain_id"]
  });

export const keyUpdateSchema = z
  .object({
    name: z.string().min(1).max(50)
  })
  .strict();

export const passwordSchema = z.string().min(12, "Use at least 12 characters").max(200, "Use at most 200 characters");

export const userSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  password: passwordSchema.optional()
});

export const userUpdateSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  password: passwordSchema.optional()
});

export const passwordChangeSchema = z.object({
  current_password: z.string().min(1).max(200),
  password: passwordSchema
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

// A password signs in anywhere. An API key in its place is the local development shortcut,
// refused unless ALLOW_PASSWORDLESS_SESSIONS is on.
export const sessionSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1).max(200).optional(),
    api_key: z.string().min(1).optional()
  })
  .refine((value) => Boolean(value.password) !== Boolean(value.api_key), {
    message: "Send a password",
    path: ["password"]
  });

const webhookEventName = z.enum(emailEvents as [EventType, ...EventType[]]);

function webhookFields(input: {
  url?: string;
  endpoint?: string;
  events?: Array<EventType | "all">;
  enabled?: boolean;
  status?: "enabled" | "disabled";
}) {
  const events = input.events?.includes("all")
    ? [...emailEvents]
    : input.events?.filter((event): event is EventType => event !== "all");
  const enabled = input.status !== undefined ? input.status === "enabled" : input.enabled;
  return {
    endpoint: input.endpoint ?? input.url,
    events,
    enabled
  };
}

export const webhookSchema = z
  .object({
    url: z.string().url().optional(),
    endpoint: z.string().url().optional(),
    events: z.array(z.union([webhookEventName, z.literal("all")])).min(1).default(["email.sent", "email.delivered"]),
    enabled: z.boolean().optional(),
    status: z.enum(["enabled", "disabled"]).optional()
  })
  .transform(webhookFields)
  .refine((input) => Boolean(input.endpoint), { message: "endpoint is required", path: ["endpoint"] });

export const webhookUpdateSchema = z
  .object({
    url: z.string().url().optional(),
    endpoint: z.string().url().optional(),
    events: z.array(z.union([webhookEventName, z.literal("all")])).min(1).optional(),
    enabled: z.boolean().optional(),
    status: z.enum(["enabled", "disabled"]).optional()
  })
  .transform(webhookFields);

export const reservedVariables = [
  "FIRST_NAME", "LAST_NAME", "EMAIL", "UNSUBSCRIBE_URL",
  "RESEND_UNSUBSCRIBE_URL", "DISPATCH_UNSUBSCRIBE_URL", "contact", "this",
  "PRODUCT_NAME", "PRODUCT_URL", "LOGO_URL", "BRAND_COLOR", "BRAND_TEXT_COLOR",
  "SUPPORT_EMAIL", "SUPPORT_URL", "PRIVACY_URL", "COMPANY_NAME", "COMPANY_ADDRESS", "CURRENT_YEAR"
];
// Names on Object.prototype would read as built-ins if a lookup ever skipped the own-property check.
const unsafeVariables = ["constructor", "prototype", "__proto__", "toString", "valueOf", "hasOwnProperty"];
const variableKey = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,50}$/)
  .refine((key) => !reservedVariables.includes(key) && !unsafeVariables.includes(key), "variable name is reserved");
const templateVariable = z.union([
  variableKey.transform((key) => ({ key, type: "string" as const, fallback_value: null })),
  z.object({
    key: variableKey,
    type: z.enum(["string", "number", "list"]).default("string"),
    fallback_value: z.union([z.string().max(2000), z.number()]).nullable().default(null)
  })
]);
const replyTo = z.union([address, z.array(address).min(1).max(50)]).transform((value) => (Array.isArray(value) ? value : [value]));

const templateSourceSchema = z
  .object({
    kind: z.string().min(1).max(40),
    path: z.string().min(1).max(300).optional(),
    slug: z.string().min(1).max(120).optional(),
    version: z.string().min(1).max(40).optional()
  })
  .strict();

// A draft may hold a half-typed block: an editor saves as the user types. Blocks are checked
// when a version is published and when a broadcast is sent (assertBlocks).
function templateText(max: number) {
  return z.string().max(max);
}

// Throws 422 when the subject, HTML, or text has an unclosed or crossed block.
export function assertBlocks(fields: { subject?: string | null; html?: string | null; text?: string | null }) {
  for (const name of ["subject", "html", "text"] as const) {
    const problem = fields[name] ? blockProblem(fields[name]!) : null;
    if (problem) throw new ApiError("validation_error", 422, `${name}: ${problem}`);
  }
}

const baseTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  alias: z.string().min(1).max(120).optional(),
  from: address.optional(),
  reply_to: replyTo.optional(),
  subject: templateText(998).pipe(z.string().min(1)).optional(),
  html: templateText(1_000_000).optional(),
  text: templateText(1_000_000).optional(),
  variables: z.array(templateVariable).max(50).default([]),
  source: templateSourceSchema.optional(),
  track: z.boolean().optional(),
  publish: z.boolean().optional()
});

export const templateSchema = baseTemplateSchema;
export type TemplateInput = z.input<typeof templateSchema>;

// null clears from, reply_to, or subject. An omitted field keeps its value.
export const templateUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  alias: z.string().min(1).max(120).nullable().optional(),
  from: address.nullable().optional(),
  reply_to: replyTo.nullable().optional(),
  subject: templateText(998).pipe(z.string().min(1)).nullable().optional(),
  html: templateText(1_000_000).nullable().optional(),
  text: templateText(1_000_000).nullable().optional(),
  variables: z.array(templateVariable).max(50).optional(),
  source: templateSourceSchema.optional(),
  track: z.boolean().optional(),
  publish: z.boolean().optional()
}).strict();
export type TemplateUpdateInput = z.input<typeof templateUpdateSchema>;

export const templateVersionSchema = baseTemplateSchema.omit({ name: true, alias: true, publish: true });

const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"), "must be an https url");

export const brandSchema = z.object({
  product_name: z.string().min(1).max(120).optional(),
  product_url: httpsUrl.optional(),
  logo_url: httpsUrl.nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  support_email: z.string().email().optional(),
  support_url: httpsUrl.nullable().optional(),
  company_name: z.string().min(1).max(200).optional(),
  company_address: z.string().max(500).optional(),
  // Linked from the footer of every library email. Billing emails are expected to carry one.
  privacy_url: httpsUrl.nullable().optional(),
  // The heading and the line under it on the public unsubscribe page. Null goes back to the default.
  unsubscribe_title: z.string().min(1).max(120).nullable().optional(),
  unsubscribe_description: z.string().min(1).max(500).nullable().optional()
}).strict();

export type BrandInput = z.infer<typeof brandSchema>;

export type BrandRecord = {
  product_name?: string;
  product_url?: string;
  logo_url?: string | null;
  color?: string;
  support_email?: string;
  support_url?: string | null;
  company_name?: string;
  company_address?: string;
  privacy_url?: string | null;
  unsubscribe_title?: string | null;
  unsubscribe_description?: string | null;
};

function channel(hex: string) {
  const value = Number.parseInt(hex, 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string) {
  const hex = color.replace("#", "");
  return 0.2126 * channel(hex.slice(0, 2)) + 0.7152 * channel(hex.slice(2, 4)) + 0.0722 * channel(hex.slice(4, 6));
}

function contrast(left: string, right: string) {
  const lighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

// Black or white, whichever reads better. One of the two always reaches 4.5:1 on any color.
export function brandTextColor(color: string) {
  return contrast(color, "#ffffff") >= contrast(color, "#000000") ? "#ffffff" : "#000000";
}

export function brandContext(
  brand: BrandRecord,
  fallback: { tenantName: string; domain?: string | null; from?: string | null; year?: number }
) {
  const color = brand.color || "#18181b";
  const productName = brand.product_name || fallback.tenantName;
  return {
    PRODUCT_NAME: productName,
    PRODUCT_URL: brand.product_url || (fallback.domain ? `https://${fallback.domain}` : ""),
    LOGO_URL: brand.logo_url || "",
    BRAND_COLOR: color,
    BRAND_TEXT_COLOR: brandTextColor(color),
    SUPPORT_EMAIL: brand.support_email || fallback.from || "",
    SUPPORT_URL: brand.support_url || "",
    PRIVACY_URL: brand.privacy_url || "",
    COMPANY_NAME: brand.company_name || productName,
    COMPANY_ADDRESS: brand.company_address || "",
    CURRENT_YEAR: String(fallback.year ?? new Date().getFullYear())
  };
}

// `draft: true` renders the latest version, published or not. Without it the published one is used.
export const renderSchema = z.object({
  variables: z.record(z.unknown()).default({}),
  draft: z.boolean().optional()
});

const topicSubscriptionValue = z.enum(["opt_in", "opt_out", "subscribed", "unsubscribed"]);

// One mailbox is one contact, whatever case the address arrives in.
export const contactSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  first_name: z.string().max(120).optional(),
  last_name: z.string().max(120).optional(),
  properties: z.record(z.unknown()).optional(),
  unsubscribed: z.boolean().optional(),
  segments: z.array(z.object({ id: z.string().min(1) })).optional(),
  topics: z.array(z.object({
    id: z.string().min(1),
    subscription: topicSubscriptionValue.default("opt_in")
  })).optional()
});
export type ContactInput = z.input<typeof contactSchema>;

export const contactUpdateSchema = z.object({
  first_name: z.string().max(120).nullable().optional(),
  last_name: z.string().max(120).nullable().optional(),
  properties: z.record(z.unknown()).optional(),
  unsubscribed: z.boolean().optional()
});

export const contactTopicsSchema = z.object({
  topics: z.array(z.object({
    id: z.string().min(1),
    subscription: topicSubscriptionValue
  })).min(1)
});

export const propertySchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_]{1,50}$/, "key must be letters, digits, or underscores, 50 characters at most"),
  type: z.enum(["string", "number"]).default("string"),
  fallback_value: z.union([z.string().max(500), z.number()]).nullable().optional()
});
export type PropertyInput = z.input<typeof propertySchema>;

export const propertyUpdateSchema = propertySchema.pick({ fallback_value: true });

export const suppressionSchema = z.object({
  email: z.string().email(),
  reason: z.string().min(1).max(120).default("manual")
});
export type SuppressionInput = z.input<typeof suppressionSchema>;

export const suppressionBatchAddSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(100)
});

export const suppressionBatchRemoveSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(100).optional(),
  ids: z.array(z.string().min(1)).min(1).max(100).optional()
}).refine((value) => Number(Boolean(value.emails)) + Number(Boolean(value.ids)) === 1, {
  message: "Provide emails or ids"
});

export const topicSchema = z.object({
  name: z.string().min(1).max(50),
  key: z.string().min(1).max(120).optional(),
  description: z.string().max(200).optional(),
  visibility: z.enum(["public", "private"]).default("private"),
  default_subscription: z.enum(["opt_in", "opt_out"]).optional(),
  default_status: z.enum(["subscribed", "unsubscribed"]).optional()
}).superRefine((value, ctx) => {
  if (!value.default_subscription || !value.default_status) return;
  const stored = value.default_subscription === "opt_out" ? "unsubscribed" : "subscribed";
  if (stored !== value.default_status) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "default_subscription and default_status disagree",
      path: ["default_subscription"]
    });
  }
});
export type TopicInput = z.input<typeof topicSchema>;

export const topicUpdateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  key: z.string().min(1).max(120).optional(),
  description: z.string().max(200).nullable().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  default_subscription: z.string().optional(),
  default_status: z.string().optional()
}).strict().superRefine((value, ctx) => {
  if (value.default_subscription !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "default_subscription cannot change after creation",
      path: ["default_subscription"]
    });
  }
  if (value.default_status !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "default_status cannot change after creation",
      path: ["default_status"]
    });
  }
});

export const subscriptionSchema = z.object({
  email: z.string().email(),
  status: topicSubscriptionValue.default("subscribed")
});

export const segmentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional()
});
export type SegmentInput = z.input<typeof segmentSchema>;

export const segmentUpdateSchema = segmentSchema.partial();

export const segmentContactSchema = z.object({
  email: z.string().email()
});

function jsonField(value: unknown) {
  if (typeof value !== "string") return value;
  if (value.trim() === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const importColumn = z.object({
  column: z.string().min(1).max(200),
  type: z.enum(["string", "number", "boolean"]).optional()
});

// A field left out is found by its usual header name. A field set to null is not imported, even
// when the file has a column of that name.
export const importColumnMapSchema = z.object({
  email: importColumn.optional(),
  first_name: importColumn.nullable().optional(),
  last_name: importColumn.nullable().optional(),
  unsubscribed: importColumn.nullable().optional(),
  properties: z.record(z.string().regex(/^[A-Za-z0-9_]{1,50}$/, "property keys must be letters, digits, or underscores"), importColumn).optional()
}).strict();
export type ImportColumnMap = z.infer<typeof importColumnMapSchema>;

const importRef = z.union([z.string().min(1), z.object({ id: z.string().min(1) })]).transform((value) => (typeof value === "string" ? { id: value } : value));

export const contactImportSchema = z.object({
  column_map: z.preprocess(jsonField, importColumnMapSchema.default({})),
  on_conflict: z.enum(["upsert", "skip"]).default("upsert"),
  segments: z.preprocess(jsonField, z.array(importRef).max(100).default([])),
  topics: z.preprocess(jsonField, z.array(z.object({
    id: z.string().min(1),
    subscription: topicSubscriptionValue.default("opt_in")
  })).max(100).default([]))
});
export type ContactImportInput = z.input<typeof contactImportSchema>;

export const importStatuses = ["queued", "in_progress", "completed", "failed"] as const;

export const linkCheckSchema = z.object({
  urls: z.array(z.string().min(1).max(2048)).min(1).max(50)
});

const broadcastFields = {
  name: z.string().min(1).max(120).optional(),
  segment_id: z.string().min(1).optional(),
  audience_id: z.string().min(1).optional(),
  subject: z.string().min(1).max(998).optional(),
  preview_text: z.string().max(500).nullable().optional(),
  html: z.string().max(1_000_000).nullable().optional(),
  text: z.string().max(1_000_000).nullable().optional(),
  template: z.string().min(1).max(120).optional(),
  topic_id: z.string().min(1).nullable().optional()
};

function segmentAlias<T extends { segment_id?: string; audience_id?: string }>({ audience_id, ...value }: T) {
  return { ...value, segment_id: value.segment_id ?? audience_id };
}

export const broadcastSchema = z
  .object({
    ...broadcastFields,
    from: address,
    reply_to: replyTo.optional(),
    variables: z.record(z.unknown()).default({}),
    send: z.boolean().optional(),
    scheduled_at: z.string().min(1).max(120).optional()
  })
  .strict()
  .refine((value) => Boolean(value.segment_id || value.audience_id), { message: "segment_id is required", path: ["segment_id"] })
  .refine(hasSubjectOrTemplate, subjectRequired)
  .refine((value) => !value.scheduled_at || value.send === true, { message: "scheduled_at requires send: true", path: ["scheduled_at"] })
  .transform((value) => ({ ...segmentAlias(value), segment_id: (value.segment_id ?? value.audience_id)! }));
export type BroadcastInput = z.input<typeof broadcastSchema>;

export const broadcastUpdateSchema = z
  .object({
    ...broadcastFields,
    from: address.optional(),
    reply_to: replyTo.nullable().optional(),
    variables: z.record(z.unknown()).optional()
  })
  .strict()
  .transform(segmentAlias);
export type BroadcastUpdateInput = z.input<typeof broadcastUpdateSchema>;

export const broadcastSendSchema = z.object({ scheduled_at: z.string().min(1).max(120).optional() }).strict();

export const broadcastRecipientTypes = ["sent", "delivered", "opened", "clicked", "bounced", "complained", "unsubscribed", "suppressed"] as const;

export const broadcastRecipientsSchema = z.object({
  type: z.enum(broadcastRecipientTypes, { errorMap: () => ({ message: `type must be one of ${broadcastRecipientTypes.join(", ")}` }) }),
  email: z.string().min(1).max(320).optional(),
  bounce_type: z.string().min(1).max(40).optional()
});

export const unsubscribeSchema = z.union([
  z.object({
    topics: z.array(z.object({ id: z.string().min(1), subscription: topicSubscriptionValue })).min(1)
  }).strict(),
  z.object({ unsubscribe_all: z.literal(true) }).strict()
]);
export type UnsubscribeInput = z.input<typeof unsubscribeSchema>;

export const customEventSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  data: z.record(z.unknown()).default({})
});
export type CustomEventInput = z.input<typeof customEventSchema>;

export const customEventUpdateSchema = customEventSchema.partial();

export const operators = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "starts_with", "ends_with", "exists", "is_empty"] as const;
export type Operator = (typeof operators)[number];

export type Rule =
  | { type: "rule"; field: string; operator: Operator; value?: unknown }
  | { type: "and" | "or"; rules: Rule[] };

const nestedRule: z.ZodType<Rule> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("rule"), field: z.string().min(1).max(200), operator: z.enum(operators), value: z.unknown().optional() }),
    z.object({ type: z.enum(["and", "or"]), rules: z.array(nestedRule).min(1).max(50) })
  ])
);

export const maxRuleDepth = 10;

// Measured without recursion, so a rule nested thousands deep is refused before zod walks it.
function ruleDepth(value: unknown) {
  let deepest = 0;
  const pending: Array<[unknown, number]> = [[value, 1]];
  while (pending.length > 0) {
    const [node, depth] = pending.pop()!;
    deepest = Math.max(deepest, depth);
    if (deepest > maxRuleDepth) break;
    const rules = (node as { rules?: unknown } | null)?.rules;
    if (Array.isArray(rules)) for (const child of rules) pending.push([child, depth + 1]);
  }
  return deepest;
}

export const ruleSchema: z.ZodType<Rule, z.ZodTypeDef, unknown> = z
  .custom<unknown>((value) => ruleDepth(value) <= maxRuleDepth, `Rules can nest at most ${maxRuleDepth} levels`)
  .pipe(nestedRule);

// Two numbers, or two dates, to compare. Anything else (null, an empty string, a list, a number
// against a date) has no order, and the rule is false.
function comparable(actual: unknown, expected: unknown): [number, number] | null {
  const number = (value: unknown) =>
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const left = number(actual);
  const right = number(expected);
  if (left !== null && right !== null) return [left, right];
  const date = (value: unknown) => (typeof value === "string" && left === null && right === null && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null);
  const earlier = date(actual);
  const later = date(expected);
  return earlier !== null && later !== null ? [earlier, later] : null;
}

// Reads a dotted path such as "event.plan" or "contact.first_name" from the run context.
export function evaluate(rule: Rule, context: Record<string, unknown>): boolean {
  if (rule.type !== "rule") {
    return rule.type === "and" ? rule.rules.every((child) => evaluate(child, context)) : rule.rules.some((child) => evaluate(child, context));
  }
  const actual = rule.field
    .split(".")
    .reduce<unknown>((value, part) => (value !== null && typeof value === "object" && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined), context);
  const expected = rule.value;
  const order = comparable(actual, expected);
  switch (rule.operator) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt": return order !== null && order[0] > order[1];
    case "gte": return order !== null && order[0] >= order[1];
    case "lt": return order !== null && order[0] < order[1];
    case "lte": return order !== null && order[0] <= order[1];
    case "contains": return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected));
    case "starts_with": return String(actual ?? "").startsWith(String(expected));
    case "ends_with": return String(actual ?? "").endsWith(String(expected));
    case "exists": return actual !== undefined && actual !== null;
    case "is_empty": return actual === undefined || actual === null || actual === "" || (Array.isArray(actual) && actual.length === 0);
  }
}

export const maxDelaySeconds = 30 * 86_400;

function checkDuration(value: string, ctx: z.RefinementCtx, path: string) {
  let seconds: number;
  try {
    seconds = durationSeconds(value);
  } catch {
    ctx.addIssue({ code: "custom", message: `Invalid duration: ${value}`, path: [path] });
    return;
  }
  if (seconds < 1 || seconds > maxDelaySeconds) ctx.addIssue({ code: "custom", message: `${path} must be between 1 second and 30 days`, path: [path] });
}

const eventName = z.string().min(1).max(120);
const stepEmail = z.string().email().optional();

export const stepConfigs = {
  trigger: z.object({ event_name: eventName }),
  // `from` may be left out when the template stores a sender. `topic_id` marks the email as
  // subscription mail: without it the step sends to everyone, like a receipt or a password reset.
  send_email: z
    .object({
      from: address.optional(),
      to: stepEmail,
      topic_id: z.string().min(1).optional(),
      subject: z.string().min(1).max(998).optional(),
      reply_to: addresses.optional(),
      template: templateRef,
      variables: z.record(z.unknown()).optional()
    })
    .transform(({ template, variables, ...rest }) => ({ ...rest, template: { id: template.id, variables: { ...variables, ...template.variables } } })),
  delay: z
    .object({ duration: z.string().min(1).max(60).optional(), seconds: z.number().int().optional() })
    .transform((value, ctx) => {
      const duration = value.duration ?? (value.seconds === undefined ? undefined : `${value.seconds} seconds`);
      if (!duration) {
        ctx.addIssue({ code: "custom", message: "duration is required", path: ["duration"] });
        return z.NEVER;
      }
      checkDuration(duration, ctx, "duration");
      return { duration };
    }),
  wait_for_event: z
    .object({
      event_name: eventName.optional(),
      event: eventName.optional(),
      timeout: z.string().min(1).max(60).optional(),
      timeout_seconds: z.number().int().optional(),
      filter_rule: ruleSchema.optional()
    })
    .transform((value, ctx) => {
      const name = value.event_name ?? value.event;
      if (!name) {
        ctx.addIssue({ code: "custom", message: "event_name is required", path: ["event_name"] });
        return z.NEVER;
      }
      const timeout = value.timeout ?? (value.timeout_seconds === undefined ? undefined : `${value.timeout_seconds} seconds`);
      if (timeout) checkDuration(timeout, ctx, "timeout");
      return { event_name: name, ...(timeout ? { timeout } : {}), ...(value.filter_rule ? { filter_rule: value.filter_rule } : {}) };
    }),
  condition: ruleSchema,
  add_to_segment: z.object({ segment_id: z.string().min(1), email: stepEmail }),
  contact_update: z.object({
    first_name: z.string().max(200).optional(),
    last_name: z.string().max(200).optional(),
    unsubscribed: z.boolean().optional(),
    properties: z.record(z.unknown()).optional(),
    email: stepEmail
  }),
  contact_delete: z.object({ email: stepEmail })
};
export type StepConfig<T extends StepType> = z.infer<(typeof stepConfigs)[T]>;

export const stepTypes = ["trigger", "send_email", "delay", "wait_for_event", "condition", "add_to_segment", "contact_update", "contact_delete"] as const;
export type StepType = (typeof stepTypes)[number];

export const stepSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/, "key must be 1 to 60 letters, digits, underscores, or dashes"),
  type: z.enum(stepTypes),
  config: z.record(z.unknown()).default({})
});
export type Step = z.infer<typeof stepSchema>;
export type AutomationStep = Step;

export const connectionTypes = ["default", "condition_met", "condition_not_met", "timeout", "event_received"] as const;

export const connectionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(connectionTypes).default("default")
});
export type Connection = z.infer<typeof connectionSchema>;

const legacyTypes: Record<string, StepType> = { update_contact: "contact_update", wait: "wait_for_event" };

function prefixIssues(error: z.ZodError, prefix: Array<string | number>) {
  return error.issues.map((issue) => ({ ...issue, path: [...prefix, ...issue.path] }));
}

// Accepts the old linear form { trigger, steps: [{ type, ...fields }] } and the graph form
// { steps: [{ key, type, config }], connections }, and returns the graph form with parsed configs.
export function normalizeAutomation(input: { trigger?: string | null; steps: Array<Record<string, unknown>>; connections?: unknown[] | null }) {
  const keyed = input.steps.length > 0 && input.steps.every((step) => "key" in step);
  const raw = keyed
    ? input.steps
    : [
        { key: "trigger", type: "trigger", config: { event_name: input.trigger ?? undefined } },
        ...input.steps.map(({ type, ...config }, index) => ({ key: `step_${index + 1}`, type: legacyTypes[String(type)] ?? type, config }))
      ];
  const shaped = z.array(stepSchema).safeParse(raw);
  if (!shaped.success) throw new z.ZodError(prefixIssues(shaped.error, ["steps"]));

  const issues: z.ZodIssue[] = [];
  const steps: Step[] = shaped.data.map((step, index) => {
    const config = stepConfigs[step.type].safeParse(step.config);
    if (config.success) return { ...step, config: config.data as Record<string, unknown> };
    issues.push(...prefixIssues(config.error, ["steps", index, "config"]));
    return step;
  });
  if (issues.length) throw new z.ZodError(issues);

  if (!keyed) {
    const connections: Connection[] = steps.slice(1).map((step, index) => ({ from: steps[index]!.key, to: step.key, type: "default" }));
    return { steps, connections };
  }
  const connections = z.array(connectionSchema).safeParse(input.connections ?? []);
  if (!connections.success) throw new z.ZodError(prefixIssues(connections.error, ["connections"]));
  return { steps, connections: connections.data };
}

export function automationIssues(steps: Step[], connections: Connection[]) {
  const issues: string[] = [];
  if (steps.filter((step) => step.type === "trigger").length !== 1) issues.push("An automation needs exactly one trigger step");
  const byKey = new Map<string, Step>();
  for (const step of steps) {
    if (byKey.has(step.key)) issues.push(`Step key ${step.key} is used more than once`);
    byKey.set(step.key, step);
  }

  const edges = new Map<string, string[]>();
  const branches = new Map<string, number>();
  for (const connection of connections) {
    const from = byKey.get(connection.from);
    if (!from) issues.push(`Connection starts at unknown step ${connection.from}`);
    if (!byKey.has(connection.to)) issues.push(`Connection ends at unknown step ${connection.to}`);
    if (!from || !byKey.has(connection.to)) continue;
    if ((connection.type === "condition_met" || connection.type === "condition_not_met") && from.type !== "condition") {
      issues.push(`A ${connection.type} connection must start at a condition step, not ${from.key}`);
    }
    if ((connection.type === "timeout" || connection.type === "event_received") && from.type !== "wait_for_event") {
      issues.push(`A ${connection.type} connection must start at a wait_for_event step, not ${from.key}`);
    }
    // A run follows one edge of each type out of a step. A second one would never be taken.
    const branch = `${connection.from}:${connection.type}`;
    branches.set(branch, (branches.get(branch) ?? 0) + 1);
    if (branches.get(branch) === 2) {
      issues.push(
        connection.type === "default"
          ? `Step ${connection.from} has more than one outgoing connection`
          : `${from.type === "condition" ? "Condition" : "Step"} ${connection.from} has more than one ${connection.type} connection`,
      );
    }
    edges.set(connection.from, [...(edges.get(connection.from) ?? []), connection.to]);
  }

  const state = new Map<string, "open" | "closed">();
  const visit = (key: string): boolean => {
    if (state.get(key) === "open") return true;
    if (state.get(key) === "closed") return false;
    state.set(key, "open");
    const cyclic = (edges.get(key) ?? []).some(visit);
    state.set(key, "closed");
    return cyclic;
  };
  if ([...byKey.keys()].some(visit)) issues.push("Connections form a cycle");
  return issues;
}

const graphFields = {
  trigger: eventName.optional(),
  steps: z.array(z.record(z.unknown())).min(1).max(100),
  connections: z.array(z.unknown()).max(200).optional()
};

function toGraph(input: { trigger?: string; steps: Array<Record<string, unknown>>; connections?: unknown[] }, ctx: z.RefinementCtx) {
  try {
    const graph = normalizeAutomation(input);
    for (const message of automationIssues(graph.steps, graph.connections)) ctx.addIssue({ code: "custom", message, path: ["connections"] });
    const trigger = graph.steps.find((step) => step.type === "trigger")?.config.event_name as string;
    return { ...graph, trigger };
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    for (const issue of error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    return z.NEVER;
  }
}

export const automationGraphSchema = z.object(graphFields).transform(toGraph);

const automationStatus = z.enum(["enabled", "disabled"]);

export const automationSchema = z
  .object({ name: z.string().min(1).max(120), status: automationStatus.optional(), enabled: z.boolean().optional(), ...graphFields })
  .transform(({ name, status, enabled, ...graph }, ctx) => ({
    name,
    enabled: status ? status === "enabled" : (enabled ?? false),
    ...toGraph(graph, ctx)
  }));
export type AutomationInput = z.input<typeof automationSchema>;

export const automationUpdateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    status: automationStatus.optional(),
    enabled: z.boolean().optional(),
    trigger: graphFields.trigger,
    steps: graphFields.steps.optional(),
    connections: graphFields.connections
  })
  .transform(({ status, enabled, ...rest }) => ({ ...rest, enabled: status ? status === "enabled" : enabled }));
export type AutomationUpdateInput = z.input<typeof automationUpdateSchema>;

export const eventFieldTypes = ["string", "number", "boolean", "date"] as const;

const definedEventName = eventName.refine(
  (name) => !/^(resend|dispatch):/i.test(name),
  "Event names cannot start with resend: or dispatch:"
);

export const eventSchema = z.object({
  name: definedEventName,
  schema: z.record(z.string().min(1).max(100), z.enum(eventFieldTypes)).default({})
});
export type EventInput = z.input<typeof eventSchema>;

export const eventUpdateSchema = eventSchema.pick({ schema: true }).required();

export const eventSendSchema = z
  .object({
    event: eventName,
    contact_id: z.string().min(1).optional(),
    email: z.string().email().transform((value) => value.toLowerCase()).optional(),
    payload: z.record(z.unknown()).default({})
  })
  .refine((value) => !(value.contact_id && value.email), { message: "Use contact_id or email, not both", path: ["contact_id"] });
export type EventSendInput = z.input<typeof eventSendSchema>;

// Returns one message per payload field whose type does not match the event definition.
export function payloadIssues(schema: Record<string, string>, payload: Record<string, unknown>) {
  const issues: string[] = [];
  for (const [field, type] of Object.entries(schema)) {
    const value = Object.hasOwn(payload, field) ? payload[field] : undefined;
    if (value === undefined || value === null) continue;
    const valid =
      type === "date"
        ? (typeof value === "string" || typeof value === "number") && !Number.isNaN(new Date(value).getTime())
        : typeof value === type && !(type === "number" && !Number.isFinite(value));
    if (!valid) issues.push(`payload.${field} must be a ${type}`);
  }
  return issues;
}

export const inboundSchema = z
  .object({
    from: z.string().email(),
    to: recipientsSchema,
    cc: recipientsSchema.optional(),
    bcc: recipientsSchema.optional(),
    subject: z.string().min(1).max(998),
    html: z.string().max(1_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    headers: z.record(z.string()).default({}),
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1).max(255),
          content: z.string().min(1).max(attachmentPayloadLimit),
          content_type: z.string().min(1).max(120).default("application/octet-stream")
        })
      )
      .max(20)
      .default([])
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
  return { object: "list" as const, has_more, data };
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

// Passwords are hashed with scrypt and a random salt per password. The stored string carries
// its own parameters, "scrypt$N$r$p$salt$hash", so the cost can be raised later and older
// hashes still check. 2^14, 8, 5 is one of OWASP's minimum scrypt settings: 16 MiB per check.
const passwordCost = { N: 16_384, r: 8, p: 5 };

// What a stored hash may ask for. Anything else is refused before it costs memory, and a key or
// salt that decodes short could otherwise make an empty compare that passes.
function usableCost(cost: { N: number; r: number; p: number }) {
  const { N, r, p } = cost;
  return Number.isInteger(N) && N >= 2 && N <= 2 ** 20 && (N & (N - 1)) === 0 && Number.isInteger(r) && r >= 1 && r <= 32 && Number.isInteger(p) && p >= 1 && p <= 16 && 128 * N * r <= 2 ** 28;
}

function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }, length: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, length, { ...cost, maxmem: 256 * cost.N * cost.r }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string) {
  const { N, r, p } = passwordCost;
  const salt = randomBytes(16);
  const key = await derive(password, salt, passwordCost, 64);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

// False for a wrong password, and for a stored value that is missing or not a hash this code
// wrote. A missing hash still costs one derivation, so an unknown email takes as long to refuse
// as a wrong password.
export async function checkPassword(password: string, stored: string | null | undefined) {
  const parts = (stored ?? "").split("$");
  const [scheme, N, r, p, salt, key] = parts;
  const cost = { N: Number(N), r: Number(r), p: Number(p) };
  const saltBytes = Buffer.from(salt ?? "", "base64url");
  const keyBytes = Buffer.from(key ?? "", "base64url");
  const valid = parts.length === 6 && scheme === "scrypt" && usableCost(cost) && saltBytes.length >= 16 && keyBytes.length === 64;
  const expected = valid ? keyBytes : Buffer.alloc(64);
  const given = await derive(password, valid ? saltBytes : randomBytes(16), valid ? cost : passwordCost, 64);
  return valid && timingSafeEqual(given, expected);
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

export function makeWebhookSecret() {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

export function signWebhook(payload: string, secrets: string[], msgId: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signatures = secrets.map((secret) => {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    return `v1,${createHmac("sha256", key).update(`${msgId}.${timestamp}.${payload}`).digest("base64")}`;
  });
  return { id: msgId, timestamp, signature: signatures.join(" ") };
}

export function verifyWebhook(
  payload: string,
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  toleranceSecs = 300
) {
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(headers.timestamp));
  if (!Number.isFinite(age) || age > toleranceSecs) return false;
  const expected = Buffer.from(signWebhook(payload, [secret], headers.id, Number(headers.timestamp)).signature.slice(3), "base64");
  return headers.signature.split(" ").some((entry) => {
    const given = Buffer.from(entry.replace(/^v1,/, ""), "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export const webhookSchedule = [0, 5, 300, 1_800, 7_200, 18_000, 36_000, 36_000];

// An empty or malformed WEBHOOK_MAX_ATTEMPTS falls back to the full schedule. Read as a number it
// would be 0 or NaN, and no failed delivery would ever be retried.
function webhookMaxAttempts() {
  const value = Number(process.env.WEBHOOK_MAX_ATTEMPTS);
  return process.env.WEBHOOK_MAX_ATTEMPTS && Number.isInteger(value) && value > 0 ? value : webhookSchedule.length;
}

export function webhookDelay(attempt: number, maxAttempts = webhookMaxAttempts()) {
  if (attempt >= maxAttempts) return null;
  return webhookSchedule[attempt] ?? null;
}

export function endpointDisabled(failingSince: string | null, now = Date.now()) {
  if (!failingSince) return false;
  return now - Date.parse(failingSince) >= 5 * 24 * 60 * 60 * 1000;
}

export function webhookDeliveryStatus(attempt: { state: string; attempt: number }) {
  if (attempt.state === "sent") return "success";
  if (attempt.state === "queued" && attempt.attempt <= 1) return "pending";
  if (attempt.state === "queued" || attempt.state === "running") return "attempting";
  if (attempt.state === "failed") return "failed";
  return "pending";
}

export function webhookEventData(input: {
  email_id: string | null;
  email_created_at?: string | null;
  from_email?: string | null;
  from_name?: string | null;
  to?: string[] | null;
  subject?: string | null;
  message_id?: string | null;
  tags?: Record<string, string> | null;
  broadcast_id?: string | null;
  template_id?: string | null;
  data: Record<string, unknown>;
}) {
  if (!input.email_id) return input.data;
  // SES calls a soft bounce Transient, and that is what is stored and counted. Resend's webhook
  // calls it Temporary, so the payload says Temporary and code written for Resend keeps working.
  const bounce = input.data.bounce as { type?: unknown } | undefined;
  const data = bounce && bounce.type === "Transient" ? { ...input.data, bounce: { ...bounce, type: "Temporary" } } : input.data;
  return {
    email_id: input.email_id,
    created_at: input.email_created_at,
    from: input.from_name ? `${input.from_name} <${input.from_email}>` : input.from_email,
    to: input.to ?? [],
    subject: input.subject,
    message_id: input.message_id,
    tags: input.tags ?? {},
    broadcast_id: input.broadcast_id ?? undefined,
    template_id: input.template_id ?? undefined,
    ...data
  };
}

// APP_SECRET does two jobs: it signs tokens and it protects stored webhook secrets. The two
// must not share a key. Tokens are signed with the secret itself. Stored secrets are encrypted
// with a key derived from it for that one purpose, so neither key says anything about the other.
// Values written before this used a plain hash of the secret. They carry the v1 prefix and are
// still read, so nothing stored has to be rewritten.
const legacyPrefix = "enc:v1:";
const secretPrefix = "enc:v2:";

function encryptionKey(secret: string, prefix: string) {
  if (prefix === legacyPrefix) return createHash("sha256").update(secret).digest();
  return Buffer.from(hkdfSync("sha256", secret, "dispatch", "webhook-secret-encryption", 32));
}

// True for a value encrypt() wrote, in either format. A legacy plaintext secret is false.
export function encrypted(value: string) {
  return value.startsWith(secretPrefix) || value.startsWith(legacyPrefix);
}

export function encrypt(plaintext: string, secret: string) {
  const key = encryptionKey(secret, secretPrefix);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${secretPrefix}${iv.toString("base64url")}.${tag.toString("base64url")}.${body.toString("base64url")}`;
}

export function decrypt(value: string, secret: string) {
  const prefix = [secretPrefix, legacyPrefix].find((item) => value.startsWith(item));
  if (!prefix) return value;
  const [iv, tag, body] = value.slice(prefix.length).split(".");
  if (!iv || !tag || !body) throw new Error("Webhook secret could not be decrypted");
  const key = encryptionKey(secret, prefix);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export type TemplateVariable = {
  key: string;
  type?: "string" | "number" | "list";
  fallback_value?: string | number | null;
};

type NormalizedVariable = { key: string; type: "string" | "number" | "list"; fallback_value: string | number | null };

function placeholderPattern() {
  return /\{\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|([^}]*))?\}\}\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

// Own properties only. `in` and plain indexing walk the prototype chain, so a placeholder named
// `constructor` would otherwise print a function.
function own(value: unknown, key: string) {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function variableAt(key: string, variables: Record<string, unknown>, context: Record<string, unknown>) {
  if (Object.hasOwn(variables, key)) return variables[key];
  return key.split(".").reduce<unknown>((value, part) => own(value, part), context);
}

function normalizeVariables(value: unknown): NormalizedVariable[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [{ key: item, type: "string" as const, fallback_value: null }];
    if (!item || typeof item !== "object" || typeof (item as { key?: unknown }).key !== "string") return [];
    const variable = item as TemplateVariable;
    const type = variable.type === "number" || variable.type === "list" ? variable.type : "string";
    return [{
      key: variable.key,
      type,
      fallback_value: variable.fallback_value ?? null
    }];
  });
}

type BlockKind = "if" | "unless" | "each";
type BlockNode = string | { kind: BlockKind; key: string; children: BlockNode[] };

function blockToken() {
  return /\{\{\{(?:#(each|if|unless)\s+([A-Za-z0-9_.]+)|\/(each|if|unless))\s*\}\}\}/g;
}

// Blocks nest, so opening and closing tags are matched with a stack. A regex that pairs each
// opening tag with the first closing tag of its kind closes an outer block at an inner tag.
function parseBlocks(source: string): BlockNode[] {
  const root: BlockNode[] = [];
  const stack: Array<{ kind: BlockKind; key: string; children: BlockNode[] }> = [];
  const push = (node: BlockNode) => (stack.length > 0 ? stack[stack.length - 1].children : root).push(node);
  let last = 0;
  for (const match of source.matchAll(blockToken())) {
    const index = match.index ?? 0;
    if (index > last) push(source.slice(last, index));
    last = index + match[0].length;
    if (match[1]) {
      stack.push({ kind: match[1] as BlockKind, key: match[2], children: [] });
      continue;
    }
    const open = stack.pop();
    if (!open) throw new ApiError("validation_error", 422, `Template has {{{/${match[3]}}}} with no opening block`);
    if (open.kind !== match[3]) {
      throw new ApiError("validation_error", 422, `Template block {{{#${open.kind} ${open.key}}}} is closed by {{{/${match[3]}}}}`);
    }
    push(open);
  }
  const open = stack.pop();
  if (open) throw new ApiError("validation_error", 422, `Template block {{{#${open.kind} ${open.key}}}} is never closed`);
  if (last < source.length) push(source.slice(last));
  return root;
}

// The reason a template's blocks do not balance, or null when they do.
export function blockProblem(source: string) {
  try {
    parseBlocks(source);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Template blocks are not balanced";
  }
}

function present(value: unknown) {
  return !(value === undefined || value === null || value === "" || value === false || (Array.isArray(value) && value.length === 0));
}

function listItem(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string" || typeof item === "number");
}

function renderBlocks(
  nodes: BlockNode[],
  scope: Record<string, unknown>,
  peek: (key: string, scope: Record<string, unknown>) => unknown,
  fill: (text: string, scope: Record<string, unknown>) => string
) {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      out += fill(node, scope);
      continue;
    }
    const value = peek(node.key, scope);
    // `unless` is the other half of `if`: it lets a template fall back to another variable.
    if (node.kind === "if" || node.kind === "unless") {
      if (present(value) === (node.kind === "if")) out += renderBlocks(node.children, scope, peek, fill);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value.slice(0, 200)) {
      const fields = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      out += renderBlocks(node.children, { ...scope, ...fields }, peek, fill);
    }
  }
  return out;
}

// A field of the contact a broadcast goes to. A broadcast prints a blank for one the contact
// lacks, so a contact with no first name still gets the email. Other sends fail on it.
export function contactField(key: string) {
  return key.startsWith("contact.") || key === "FIRST_NAME" || key === "LAST_NAME";
}

// `blank` names the keys that print as an empty string when nothing fills them, instead of failing.
export function renderTemplate(
  fields: {
    subject?: string | null;
    html?: string | null;
    text?: string | null;
    variables?: unknown;
  },
  variables: Record<string, unknown>,
  context: Record<string, unknown> = {},
  options: { blank?: (key: string) => boolean } = {}
) {
  const declared = new Map(normalizeVariables(fields.variables).map((item) => [item.key, item]));
  const missing = new Set<string>();

  for (const item of declared.values()) {
    const value = own(variables, item.key);
    if (value === undefined || value === null) continue;
    if (item.type === "list") {
      if (!Array.isArray(value) || value.some((entry) => !listItem(entry))) {
        throw new ApiError("validation_error", 422, `Template variable ${item.key} must be a list`);
      }
    } else if (typeof value !== item.type) {
      throw new ApiError("validation_error", 422, `Template variable ${item.key} must be a ${item.type}`);
    }
  }

  // A field of the current list item wins, even when it is an empty string: the item said so.
  const resolve = (key: string, inline: string | undefined, scope: Record<string, unknown>) => {
    const field = own(scope, key);
    if (field !== undefined && field !== null) return String(field);
    const value = variableAt(key, variables, context);
    if (value !== undefined && value !== null && value !== "") return String(value);
    if (inline !== undefined) return inline;
    const fallback = declared.get(key)?.fallback_value;
    if (fallback !== undefined && fallback !== null) return String(fallback);
    if (options.blank?.(key)) return "";
    missing.add(key);
    return "";
  };

  const peek = (key: string, scope: Record<string, unknown>) => {
    const field = own(scope, key);
    if (field !== undefined && field !== null) return field;
    const value = variableAt(key, variables, context);
    if (value !== undefined && value !== null && value !== "") return value;
    const fallback = declared.get(key)?.fallback_value;
    if (fallback !== undefined && fallback !== null) return fallback;
    return undefined;
  };

  const fill = (source: string | null | undefined, escape: boolean) => {
    if (!source) return undefined;
    const substitute = (text: string, scope: Record<string, unknown>) =>
      text.replace(placeholderPattern(), (_match, triple: string | undefined, inline: string | undefined, double: string | undefined) => {
        const value = resolve((triple ?? double)!, inline, scope);
        return escape ? escapeHtml(value) : value;
      });
    return renderBlocks(parseBlocks(source), {}, peek, substitute);
  };

  const rendered = { subject: fill(fields.subject, false), html: fill(fields.html, true), text: fill(fields.text, false) };
  // The error names the first one. The full list rides along for callers that sort them.
  if (missing.size > 0) {
    throw Object.assign(new ApiError("validation_error", 422, `Missing template variable: ${[...missing][0]}`), { missing: [...missing] });
  }
  return rendered;
}

// Every variable a failed render found no value for, or an empty list for any other error.
export function missingVariables(error: unknown): string[] {
  const listed = (error as { missing?: unknown } | null)?.missing;
  return Array.isArray(listed) ? listed.filter((item): item is string => typeof item === "string") : [];
}

const hrefEntities: Record<string, string> = { amp: "&", "#38": "&", "#x26": "&", quot: '"', "#34": '"', "#x22": '"', "#39": "'", "#x27": "'", apos: "'" };

// An href holds HTML-escaped text. The redirect needs the URL itself, so `&amp;` goes back to `&`.
function decodeHref(value: string) {
  return value.replace(/&(amp|quot|apos|#38|#x26|#34|#x22|#39|#x27);/gi, (match, name: string) => hrefEntities[name.toLowerCase()] ?? match);
}

export function prepareTracking(html: string, options: string | { baseUrl: string; opens?: boolean; clicks?: boolean }) {
  const settings = typeof options === "string" ? { baseUrl: options, opens: true, clicks: true } : { opens: false, clicks: false, ...options };
  const tokens: Array<{ token: string; kind: "open" | "click"; url?: string }> = [];
  let nextHtml = html;
  if (settings.clicks) {
    nextHtml = nextHtml.replace(/href=(["'])(https?:\/\/[^"']+)\1/g, (match, quote: string, url: string) => {
      if (url.includes("/unsubscribe")) return match;
      const token = id("track");
      tokens.push({ token, kind: "click", url: decodeHref(url) });
      return `href=${quote}${settings.baseUrl}/click/${token}${quote}`;
    });
  }
  if (settings.opens) {
    const token = id("track");
    tokens.push({ token, kind: "open" });
    const pixel = `<img src="${settings.baseUrl}/open/${token}.gif" width="1" height="1" alt="" style="display:none" />`;
    nextHtml = /<\/body>/i.test(nextHtml) ? nextHtml.replace(/<\/body>/i, `${pixel}</body>`) : `${nextHtml}${pixel}`;
  }
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

type LookupDone = (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

// The lookup a connection uses when it is made through publicFetch(). Checking a host and then
// connecting leaves a moment in which its DNS can be pointed at a private address. Here the
// address that is checked is the address that is dialed, on every connection and every redirect.
export function publicLookup(hostname: string, options: { all?: boolean; family?: number } | undefined, done: LookupDone) {
  lookupCallback(hostname, { family: options?.family ?? 0, all: true, verbatim: true }, (error, addresses) => {
    if (error) return done(error);
    const found = addresses as LookupAddress[];
    if (found.length === 0 || found.some((entry) => blockedWebhookHost(entry.address))) {
      return done(Object.assign(new Error(`${hostname} resolves to an address that is not allowed`), { code: "EHOSTBLOCKED" }));
    }
    if (options?.all) done(null, found);
    else done(null, found[0]!.address, found[0]!.family);
  });
}

let publicAgent: Agent | undefined;

// fetch() for a URL someone else chose: a webhook endpoint, a remote attachment, a link to
// check. A host given as an IP address is never looked up, so callers still run
// assertPublicWebhookTarget() first.
export function publicFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  publicAgent ??= new Agent({ connect: { lookup: publicLookup as never } });
  return agentFetch(input, { ...(init as object), dispatcher: publicAgent }) as unknown as Promise<Response>;
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function ipv6Groups(value: string): number[] | null {
  let text = value;
  const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const bytes = dotted.slice(2).map(Number);
    if (bytes.some((byte) => byte > 255)) return null;
    text = `${dotted[1]}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...Array<string>(fill).fill("0"), ...right].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

// An IPv6 address can carry an IPv4 address: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d),
// NAT64 (64:ff9b::/96), and 6to4 (2002::/16). Each must be judged by the IPv4 address inside it.
function embeddedIpv4(groups: number[]) {
  const dotted = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  const zero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (zero(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) return dotted(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return dotted(groups[6], groups[7]);
  if (groups[0] === 0x2002) return dotted(groups[1], groups[2]);
  return null;
}

export function blockedWebhookHost(host: string) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "").replace(/\.$/, "");
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  const kind = isIP(value);
  if (kind === 4) return blockedAddresses.check(value, "ipv4");
  if (kind === 6) {
    const groups = ipv6Groups(value);
    if (!groups) return true;
    const inner = embeddedIpv4(groups);
    return inner ? blockedAddresses.check(inner, "ipv4") : blockedAddresses.check(value, "ipv6");
  }
  return false;
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

export function statusFor(type: EventType): EmailStatus {
  switch (type) {
    case "email.sent": return "sent";
    case "email.delivered": return "delivered";
    case "email.delivery_delayed": return "delivery_delayed";
    case "email.bounced": return "bounced";
    case "email.complained": return "complained";
    case "email.failed": return "failed";
    case "email.opened": return "opened";
    case "email.clicked": return "clicked";
    case "email.suppressed": return "suppressed";
    default: return "queued";
  }
}

export function webhookUrl(url: string): string {
  return url.replace(/#.*$/, "");
}

export function backoffSecs(attempt: number, maxSecs = 300): number {
  return Math.min(maxSecs, 2 ** attempt);
}

export type ProviderEmail = {
  id: string;
  tenant_id: string;
  from: string;
  recipients: Array<{ email: string; kind: "to" | "cc" | "bcc" }>;
  reply_to: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  headers: Record<string, string>;
  attachments: Array<{
    filename: string;
    content_type: string;
    content_id?: string | null;
    disposition: "attachment" | "inline";
    bytes: Buffer;
  }>;
  region: string;
  tls: "opportunistic" | "enforced";
};

export type ProviderEvent = {
  type: EventType;
  provider_event_id: string;
  delay_ms: number;
  recipients?: string[];
  data: Record<string, unknown>;
};

export type ProviderQuota = {
  max_24_hour: number;
  max_per_second: number;
  sent_24_hour: number;
  sandbox: boolean;
};

export type ProviderResult = {
  provider_message_id: string;
  message_id?: string;
  events: ProviderEvent[];
};

export interface Provider {
  name: string;
  send(email: ProviderEmail): Promise<ProviderResult>;
  quota(region: string): Promise<ProviderQuota>;
}

export class ProviderError extends Error {
  retryable: boolean;
  reason: string;
  rejected: boolean;

  constructor(reason: string, retryable: boolean, rejected = false) {
    super(reason);
    this.name = "ProviderError";
    this.reason = reason;
    this.retryable = retryable;
    this.rejected = rejected;
  }
}

const permanentSesErrors = new Set(["MessageRejected", "MailFromDomainNotVerifiedException", "AccountSuspendedException"]);

export function classifySesError(error: { name?: string; message?: string; $metadata?: { httpStatusCode?: number } }) {
  const name = error.name ?? "";
  if (permanentSesErrors.has(name)) return new ProviderError(name, false, true);
  const status = error.$metadata?.httpStatusCode ?? 0;
  const retryable = name === "TooManyRequestsException" || status >= 500 || status === 0;
  return new ProviderError(error.message || name || "SES request failed", retryable, name === "TooManyRequestsException" || (status >= 400 && status < 500));
}

const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 };

export function durationSeconds(value: string) {
  const match = value.trim().toLowerCase().match(/^(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)$/);
  if (!match?.[1] || !match[2]) throw new ApiError("validation_error", 422, `Invalid duration: ${value}`);
  return Number(match[1]) * unitSeconds[match[2][0]];
}

export const shareSchema = z.object({
  expires_in: z.string().optional(),
}).strict();

const devSecrets = {
  APP_SECRET: "dev-secret-change-before-deploy",
  API_KEY_PEPPER: "dev-pepper-change-before-deploy"
} as const;

// Outside production an unset secret falls back to a fixed dev value so a fresh checkout runs.
// In production the process must refuse to start on a missing, dev, or short secret, because
// these values sign file and share tokens, encrypt webhook secrets, and hash API keys.
export function requireSecret(name: keyof typeof devSecrets, env: Record<string, string | undefined> = process.env) {
  const value = env[name];
  if (env.NODE_ENV !== "production") return value || devSecrets[name];
  if (!value || value === devSecrets[name] || value.length < 16) {
    throw new Error(`${name} must be set to a private value of at least 16 characters in production`);
  }
  return value;
}

// Links in emails are built from these. Left at the local default in production, every
// unsubscribe link and tracked link in every email would point at localhost.
// The fake provider records a delivery and sends nothing. In production that is refused in
// every process that could send, unless ALLOW_FAKE_PROVIDER says it is meant.
export function assertRealProvider(env: Record<string, string | undefined> = process.env) {
  if (env.NODE_ENV !== "production") return;
  if ((env.SES_PROVIDER || "fake") === "fake" && env.ALLOW_FAKE_PROVIDER !== "true") {
    throw new Error("SES_PROVIDER is not set to ses. The fake provider sends nothing, so production refuses it. Set SES_PROVIDER=ses, or ALLOW_FAKE_PROVIDER=true if this is meant.");
  }
}

export const devApiKey = "sk_local_dispatch_dev_key_change_before_deploy";

// The key the seed gives the first tenant. Outside production it defaults to the public
// development key. In production that key would hand the install to anyone who has read this
// repository, so a private key of 32 or more characters must be set.
export function seedKey(env: Record<string, string | undefined> = process.env) {
  const value = env.DISPATCH_API_KEY;
  if (env.NODE_ENV !== "production") return value || devApiKey;
  if (!value || value === devApiKey || value.length < 32) {
    throw new Error("Set DISPATCH_API_KEY to a private value of 32 or more characters before seeding in production. It becomes the first full-access key.");
  }
  return value;
}

export const devPassword = "dispatch-local-password";

// The password the seed gives operator@example.test. Outside production it defaults to the
// public development password. In production that password would let anyone who has read this
// repository sign in, so a private one must be set.
export function seedPassword(env: Record<string, string | undefined> = process.env) {
  const value = env.DISPATCH_PASSWORD;
  if (env.NODE_ENV !== "production" && !value) return devPassword;
  if (!value || (env.NODE_ENV === "production" && value === devPassword) || !passwordSchema.safeParse(value).success) {
    throw new Error("Set DISPATCH_PASSWORD to a private password of 12 to 200 characters. Production needs one before seeding. It becomes the password for operator@example.test.");
  }
  return value;
}

export function requireUrl(name: "PUBLIC_URL" | "APP_URL", fallback: string, env: Record<string, string | undefined> = process.env) {
  const value = env[name];
  if (value) return value;
  if (env.NODE_ENV === "production") throw new Error(`${name} must be set in production`);
  return fallback;
}

export function seal(payload: Record<string, unknown>, secret: string) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function unseal<T extends { exp?: number }>(token: string, secret: string): T | null {
  const [body, signature] = token.split(".");
  if (!body || !signature || token.split(".").length !== 2) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function formatWebhookPayload(event: {
  id: string;
  request_id: string | null;
  type: EventType;
  email_id: string | null;
  data: Record<string, unknown>;
  created_at?: string;
}) {
  return {
    id: event.id,
    request_id: event.request_id,
    type: event.type,
    email_id: event.email_id,
    data: event.data,
    created_at: event.created_at ?? new Date().toISOString()
  };
}

