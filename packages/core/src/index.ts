export { parseAddress } from "./addresses.js";
export * from "./rules.js";
export * from "./automations.js";
export * from "./broadcasts.js";
export * from "./events.js";
export {
  reservedVariables,
  assertBlocks,
  brandContext,
  blockProblem,
  contactField,
  renderTemplate,
  missingVariables,
  type TemplateVariable
} from "./render.js";
export * from "./crypto.js";
export * from "./network.js";
import { address, addresses, templateRef } from "./addresses.js";
import { emailEvents, type EventType } from "./events.js";
import { segmentRuleSchema } from "./rules.js";
import { reservedVariables } from "./render.js";
import { id } from "./crypto.js";
export { sandboxAddress } from "./sandbox.js";
export * from "./forms.js";
export * from "./integrations.js";
export * from "./goals.js";
export * from "./theme.js";
export * from "./brand.js";
export { ApiError } from "./errors.js";
export { awsCredentials } from "./aws.js";
export { isIsoDate, propertyTypes, propertyValueMatches, type PropertyType } from "./properties.js";
import { propertyTypes, propertyValueMatches } from "./properties.js";
import { z } from "zod";

export type Scope = "full" | "send";
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

const tagText = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const tags = z
  .union([z.record(tagText, tagText), z.array(z.object({ name: tagText, value: tagText })).max(75)])
  .transform((value) => (Array.isArray(value) ? Object.fromEntries(value.map((tag) => [tag.name, tag.value])) : value))
  .refine((value) => Object.keys(value).length <= 75, "An email can have at most 75 tags");

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
// which tags to put on its events. Routing headers must also come from structured fields.
export function reservedHeader(name: string) {
  return /^(?:x-ses-|resent-)|^(?:from|sender|to|cc|bcc|reply-to)$/i.test(name.trim());
}

const customHeaders = z
  .record(z.string().min(1).max(78).regex(/^[!-9;-~]+$/, "header names must contain printable ASCII without spaces or colons"), z.string().refine((value) => Buffer.byteLength(value, "utf8") <= 998, "header values cannot exceed 998 bytes"))
  .refine((headers) => !Object.keys(headers).some(reservedHeader), "headers cannot contain routing headers or start with X-SES-")
  .refine((headers) => Object.keys(headers).length <= 100, "headers cannot contain more than 100 entries")
  .refine((headers) => Object.entries(headers).reduce((total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value) + 4, 0) <= 16_384, "headers cannot exceed 16384 bytes in total")
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
  confirmation_daily_limit: z.number().int().min(0).max(100000).default(500),
  sandbox_domains: z.array(
    z.string().trim().toLowerCase().refine((value) => hostnamePattern.test(value), "Use a hostname"),
  ).max(50).default([]),
}).strict();
export const settingsUpdateSchema = settingsSchema.partial().extend({
  import_trigger_automations: settingsSchema.shape.import_trigger_automations.removeDefault().optional(),
  confirmation_daily_limit: settingsSchema.shape.confirmation_daily_limit.removeDefault().optional(),
  sandbox_domains: settingsSchema.shape.sandbox_domains.removeDefault().optional()
});
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

export const roleUpdateSchema = roleSchema.partial().extend({ permissions: roleSchema.shape.permissions.removeDefault().optional() });

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
    version: z.string().min(1).max(40).optional(),
    send_kind: z.enum(["transactional", "marketing"]).optional()
  })
  .strict();

// A draft may hold a half-typed block: an editor saves as the user types. Blocks are checked
// when a version is published and when a broadcast is sent (assertBlocks).
function templateText(max: number) {
  return z.string().max(max);
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

// `draft: true` renders the latest version, published or not. Without it the published one is used.
export const renderSchema = z.object({
  variables: z.record(z.string(), z.unknown()).default({}),
  draft: z.boolean().optional()
});

const topicSubscriptionValue = z.enum(["opt_in", "opt_out", "subscribed", "unsubscribed"]);

// One mailbox is one contact, whatever case the address arrives in.
export const contactSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  first_name: z.string().max(120).optional(),
  last_name: z.string().max(120).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
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
  properties: z.record(z.string(), z.unknown()).optional(),
  unsubscribed: z.boolean().optional()
});

export const contactTopicsSchema = z.object({
  topics: z.array(z.object({
    id: z.string().min(1),
    subscription: topicSubscriptionValue
  })).min(1)
});

const propertyFields = z.object({
  key: z.string().regex(/^[A-Za-z0-9_]{1,50}$/, "key must be letters, digits, or underscores, 50 characters at most"),
  type: z.enum(propertyTypes).default("string"),
  fallback_value: z.union([z.string().max(500), z.number().finite(), z.boolean()]).nullable().optional()
});
export const propertySchema = propertyFields.refine((value) => propertyValueMatches(value.type, value.fallback_value), {
  message: "fallback_value must match the property's type", path: ["fallback_value"]
});
export type PropertyInput = z.input<typeof propertySchema>;

export const propertyUpdateSchema = propertyFields.pick({ fallback_value: true });

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
  description: z.string().max(500).optional(),
  rule: z.lazy(() => segmentRuleSchema).nullable().optional()
}).strict();
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
  type: z.enum(propertyTypes).optional()
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
  trigger_automations: z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean().optional()),
  column_map: z.preprocess(jsonField, importColumnMapSchema.default({})),
  on_conflict: z.enum(["upsert", "skip"]).default("upsert"),
  segments: z.preprocess(jsonField, z.array(importRef).max(100).default([])),
  topics: z.preprocess(jsonField, z.array(z.object({
    id: z.string().min(1),
    subscription: topicSubscriptionValue.default("opt_in")
  })).max(100).default([]))
});
export type ContactImportInput = z.input<typeof contactImportSchema>;

export const importStatuses = ["queued", "in_progress", "completed", "failed", "cancelled"] as const;

export const automationEnrollSchema = z.union([
  z.object({ segment_id: z.string().min(1) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

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
    variables: z.record(z.string(), z.unknown()).default({}),
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
    variables: z.record(z.string(), z.unknown()).optional()
  })
  .strict()
  .transform(segmentAlias);
export type BroadcastUpdateInput = z.input<typeof broadcastUpdateSchema>;

export const broadcastSendSchema = z.object({ scheduled_at: z.string().min(1).max(120).optional() }).strict();

export const broadcastRecipientTypes = ["sent", "delivered", "opened", "clicked", "bounced", "complained", "unsubscribed", "suppressed"] as const;

export const broadcastRecipientsSchema = z.object({
  type: z.enum(broadcastRecipientTypes, { error: `type must be one of ${broadcastRecipientTypes.join(", ")}` }),
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
  data: z.record(z.string(), z.unknown()).default({})
});
export type CustomEventInput = z.input<typeof customEventSchema>;

export const customEventUpdateSchema = customEventSchema.partial().extend({ data: customEventSchema.shape.data.removeDefault().optional() });

export { templateKind, type SendKind } from "./email-kind.js";

export { splitSchema, splitWinnerSchema, type SplitConfig, type SplitVariant, type SplitMetricsInput, type SplitMetric, type SplitReport } from "./splits.js";

export const inboundSchema = z
  .object({
    from: z.string().email(),
    to: recipientsSchema,
    cc: recipientsSchema.optional(),
    bcc: recipientsSchema.optional(),
    subject: z.string().min(1).max(998),
    html: z.string().max(1_000_000).optional(),
    text: z.string().max(1_000_000).optional(),
    headers: z.record(z.string(), z.string()).default({}),
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

export function list<T>(data: T[], has_more = false) {
  return { object: "list" as const, has_more, data };
}

export function toArray(value?: string | string[]) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
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
  if (env.NODE_ENV !== "production") return value || fallback;
  if (!value) throw new Error(`${name} must be set in production`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL in production`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error(`${name} must be an HTTPS URL with a hostname and no credentials in production`);
  }
  return value;
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
