import { convert } from "html-to-text";
import type { Queryable } from "./index.js";
import { findBy, publishedTemplate } from "./index.js";
import { ApiError, brandContext, id, parseAddress, prepareTracking, renderTemplate, reservedVariables, toArray, type BrandRecord } from "@dispatchmail/core";
import { appendEvent, fanoutEvent } from "./events.js";
import { replaceUnsubscribe } from "./unsubscribe.js";

export type IngestEmailRecipient = {
  email: string;
  kind: "to" | "cc" | "bcc";
  status?: string;
};

export type IngestEmailInput = {
  tenantId: string;
  requestId: string;
  from: string;
  fromName?: string | null;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string[];
  recipients?: IngestEmailRecipient[];
  subject?: string;
  html?: string | null;
  text?: string | null;
  template?: string;
  variables?: Record<string, unknown>;
  context?: Record<string, unknown>;
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  topicId?: string | null;
  broadcastId?: string | null;
  contactId?: string | null;
  automationId?: string | null;
  automationStep?: string | null;
  scheduledAt?: Date | null;
  idempotencyKey?: string | null;
  apiKeyId?: string | null;
  publicUrl?: string;
  emailId?: string;
  // Set for a domain-restricted API key. The sender, after the template supplies it, must be on this domain.
  restrictDomain?: string | null;
};

export type IngestEmailResult = {
  id: string;
  request_id: string;
  from: string;
  to: string[];
  subject: string;
  status: string;
  scheduled_at: string | null;
  created_at: string;
};

export type TrackingResult = {
  html?: string | null;
  tokens: Array<{ token: string; kind: "open" | "click"; url?: string }>;
};

export async function emailDetail(db: Queryable, tenantId: string, emailId: string) {
  const email = await findBy<Record<string, unknown>>(db, "emails", tenantId, emailId, {
    deletedCol: null,
    errorMessage: "Email not found",
  });
  const recipients = await db.query<{ id: string; email: string; kind: "to" | "cc" | "bcc"; status: string }>(
    "select id, email, kind, status, created_at from email_recipients where tenant_id = $1 and email_id = $2 order by created_at, id",
    [tenantId, emailId],
  );
  return { ...email, recipients: recipients.rows };
}

export async function ingestEmail(
  client: Queryable,
  input: IngestEmailInput,
): Promise<{ email: IngestEmailResult; tracking: TrackingResult }> {
  let fromAddress = input.from;
  let fromName = input.fromName ?? null;
  let replyTo = input.replyTo;
  let subject = input.subject;
  let html = input.html;
  let text = input.text;
  let templateId: string | null = null;
  let templateVersionId: string | null = null;
  let templateTrack: boolean | null = null;
  const brand = await loadBrand(client, input.tenantId);

  if (input.template) {
    const template = await publishedTemplate(client, input.tenantId, input.template);
    if (!fromAddress && template.from_address) {
      // The template stores the header form, "Name <email>". The domain check needs the bare address.
      const stored = parseAddress(template.from_address);
      fromAddress = stored.email;
      fromName = stored.name;
    }
    if (!replyTo?.length && template.reply_to?.length) replyTo = template.reply_to;
    const variables = input.context ? Object.fromEntries(Object.entries(input.variables ?? {}).filter(([key]) => !reservedVariables.includes(key))) : input.variables ?? {};
    let rendered: ReturnType<typeof renderTemplate>;
    try {
      rendered = renderTemplate(template, variables, { ...brandContext(brand.brand, {
        tenantName: brand.name,
        domain: brand.domain,
        from: fromAddress,
      }), ...input.context });
    } catch (error) {
      const missing = (error as { missing?: string[] })?.missing;
      if (!input.topicId && error instanceof ApiError && missing?.some((key) => /^(?:DISPATCH_|RESEND_)?UNSUBSCRIBE_URL$/.test(key))) {
        throw new ApiError("validation_error", 422, "This template prints an unsubscribe link, so it needs topic_id. Send it as marketing, or remove the link.");
      }
      throw error;
    }
    subject = subject ?? rendered.subject;
    html = html ?? rendered.html;
    text = text ?? rendered.text;
    templateId = template.template_id;
    templateVersionId = template.id;
    templateTrack = template.track !== false;
  }

  if (input.topicId && !input.template && input.context) {
    html = replaceUnsubscribe(html, input.context);
    text = replaceUnsubscribe(text, input.context);
  }

  if (!fromAddress) {
    throw new ApiError("validation_error", 422, "from is required: the template has no from address");
  }
  const domainName = fromAddress.split("@")[1]?.toLowerCase();
  if (input.restrictDomain && domainName !== input.restrictDomain.toLowerCase()) {
    throw new ApiError("validation_error", 403, "API key is restricted to another domain");
  }
  const verified = await client.query<TrackingDomain & { id: string; sending: string | null }>(
    `select id, name, open_tracking, click_tracking, tracking_subdomain, records, sending
     from domains where tenant_id = $1 and lower(name) = $2 and status = 'verified' and deleted_at is null`,
    [input.tenantId, domainName],
  );
  const domain = verified.rows[0];
  if (!domain) {
    throw new ApiError("validation_error", 403, "Sender domain is not verified");
  }
  if (domain.sending === "disabled") {
    throw new ApiError("validation_error", 403, "Sending is disabled for this domain");
  }

  if (text === undefined && html) text = textFromHtml(html);

  if (!subject || (!html && !text)) {
    throw new ApiError("validation_error", 400, "subject and content are required");
  }

  const recipients: IngestEmailRecipient[] = input.recipients ?? [
    ...toArray(input.to).map((email) => ({ email, kind: "to" as const })),
    ...toArray(input.cc).map((email) => ({ email, kind: "cc" as const })),
    ...toArray(input.bcc).map((email) => ({ email, kind: "bcc" as const })),
  ];
  if (recipients.length > 50) {
    throw new ApiError("validation_error", 422, "An email can have at most 50 recipients");
  }

  // Addresses are matched without regard to case: Bob@example.com is the mailbox that bounced as bob@example.com.
  const lowered = recipients.map((recipient) => recipient.email.toLowerCase());
  const suppressed = await client.query<{ email: string }>(
    "select email from suppressions where tenant_id = $1 and lower(email) = any($2) and removed_at is null",
    [input.tenantId, lowered],
  );
  const suppressedEmails = new Set(suppressed.rows.map((row) => row.email.toLowerCase()));

  const optedOut = new Set<string>();
  if (input.topicId) {
    const topic = await client.query(
      "select id from topics where tenant_id = $1 and id = $2 and deleted_at is null",
      [input.tenantId, input.topicId],
    );
    if (!topic.rows[0]) throw new ApiError("validation_error", 422, "Topic not found");
    const opted = await client.query<{ email: string }>(
      `select c.email
       from contacts c
       join topics t on t.id = $3 and t.tenant_id = c.tenant_id and t.deleted_at is null
       left join topic_subscriptions s on s.topic_id = t.id and s.contact_id = c.id
       where c.tenant_id = $1 and lower(c.email) = any($2) and c.deleted_at is null
         and (c.unsubscribed_at is not null or s.status <> 'subscribed' or (s.id is null and t.default_status = 'unsubscribed'))`,
      [input.tenantId, lowered, input.topicId],
    );
    for (const row of opted.rows) optedOut.add(row.email.toLowerCase());
  }

  const prepared = recipients.map((recipient) => {
    const email = recipient.email.toLowerCase();
    const status = suppressedEmails.has(email) ? "suppressed" : optedOut.has(email) ? "failed" : "queued";
    return { ...recipient, status };
  });
  const sendable = prepared.filter((recipient) => recipient.status === "queued");

  const emailId = input.emailId ?? id("email");
  const originalHtml = html;
  const tracking = trackHtml(domain, originalHtml, input.publicUrl, templateTrack !== false);
  const trackedHtml = tracking.tokens.length > 0 ? tracking.html : null;

  const scheduledAt = input.scheduledAt ?? null;
  const isScheduled = sendable.length > 0 && scheduledAt !== null && scheduledAt.getTime() > Date.now();
  const initialStatus =
    sendable.length === 0
      ? prepared.every((recipient) => recipient.status === "suppressed")
        ? "suppressed"
        : "failed"
      : isScheduled
        ? "scheduled"
        : "queued";

  const email = await client.query<IngestEmailResult>(
    `insert into emails (
      id, tenant_id, request_id, idempotency_key, from_email, from_name, reply_to, subject, html, html_tracked, text,
      template_id, template_version_id, headers, tags, topic_id, broadcast_id, status, scheduled_at, api_key_id, contact_id, automation_id, automation_step
    )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     returning id, request_id, from_email as from, subject, status, scheduled_at, created_at`,
    [
      emailId,
      input.tenantId,
      input.requestId,
      input.idempotencyKey ?? null,
      fromAddress,
      fromName,
      JSON.stringify(replyTo ?? []),
      subject,
      originalHtml ?? null,
      trackedHtml ?? null,
      text ?? null,
      templateId,
      templateVersionId,
      JSON.stringify(input.headers ?? {}),
      JSON.stringify(input.tags ?? {}),
      input.topicId ?? null,
      input.broadcastId ?? null,
      initialStatus,
      scheduledAt,
      input.apiKeyId ?? null,
      input.contactId ?? null,
      input.automationId ?? null,
      input.automationStep ?? null,
    ],
  );

  const inserted = await client.query<{ id: string; email: string; status: string }>(
    `insert into email_recipients (id, tenant_id, email_id, email, kind, status)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
     returning id, email, status`,
    [
      prepared.map(() => id("rcpt")),
      prepared.map(() => input.tenantId),
      prepared.map(() => emailId),
      prepared.map((recipient) => recipient.email),
      prepared.map((recipient) => recipient.kind),
      prepared.map((recipient) => recipient.status),
    ],
  );

  for (const recipient of inserted.rows.filter((row) => row.status === "suppressed")) {
    const event = await appendEvent(client, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      emailId,
      recipientId: recipient.id,
      type: "email.suppressed",
      providerEventId: `${emailId}:suppressed:${recipient.email}`,
      data: {
        suppressed: {
          message: "Dispatch did not send to this address because it is on the suppression list.",
          type: "OnAccountSuppressionList",
        },
        email: recipient.email,
      },
    });
    if (event) await fanoutEvent(client, event);
  }

  await storeTokens(client, input.tenantId, emailId, tracking.tokens);

  if (sendable.length > 0) {
    await client.query(
      `insert into send_jobs (id, tenant_id, email_id, request_id, available_at)
       values ($1, $2, $3, $4, coalesce($5::timestamptz, now()))`,
      [id("job"), input.tenantId, emailId, input.requestId, isScheduled ? scheduledAt : null],
    );
  }

  if (isScheduled) {
    const event = await appendEvent(client, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      emailId,
      type: "email.scheduled",
      providerEventId: `${emailId}:scheduled`,
      data: { scheduled_at: scheduledAt?.toISOString() },
    });
    if (event) await fanoutEvent(client, event);
  }

  const toList = prepared.filter((recipient) => recipient.kind === "to").map((recipient) => recipient.email);
  return { email: { ...email.rows[0], to: toList }, tracking };
}

type TrackingDomain = {
  name: string;
  open_tracking: boolean | null;
  click_tracking: boolean | null;
  tracking_subdomain: string | null;
  records: Array<{ record?: string; status?: string }> | null;
};

// Tracked links stay on PUBLIC_URL unless the install says the per-domain tracking hosts are
// reachable over HTTPS. A verified CNAME alone is not enough: without a certificate for
// links.<domain>, every click would end in a TLS error.
function trackingBase(domain: TrackingDomain, publicUrl?: string) {
  const fallback = publicUrl ?? process.env.PUBLIC_URL ?? "http://localhost:3000";
  if (process.env.TRACKING_CUSTOM_HOSTS !== "true" || !domain.tracking_subdomain) return fallback;
  const record = (domain.records ?? []).find((item) => item.record === "Tracking");
  return record?.status === "verified" ? `https://${domain.tracking_subdomain}.${domain.name}` : fallback;
}

function trackHtml(domain: TrackingDomain, html: string | null | undefined, publicUrl: string | undefined, track: boolean): TrackingResult {
  if (!html || !track) return { html, tokens: [] };
  return prepareTracking(html, {
    baseUrl: trackingBase(domain, publicUrl),
    opens: Boolean(domain.open_tracking),
    clicks: Boolean(domain.click_tracking),
  });
}

async function storeTokens(client: Queryable, tenantId: string, emailId: string, tokens: TrackingResult["tokens"]) {
  if (tokens.length === 0) return;
  await client.query(
    `insert into tracking_tokens (token, tenant_id, email_id, kind, url)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])`,
    [
      tokens.map((token) => token.token),
      tokens.map(() => tenantId),
      tokens.map(() => emailId),
      tokens.map((token) => token.kind),
      tokens.map((token) => token.url ?? null),
    ],
  );
}

export function textFromHtml(html: string) {
  return convert(html, { wordwrap: false });
}

// An email edited before it is sent needs its tracked copy rebuilt from the new HTML. The old
// tokens point at links that may no longer be in the message, so they are replaced.
export async function retrackEmail(
  client: Queryable,
  input: { tenantId: string; emailId: string; html: string | null; publicUrl?: string },
) {
  await client.query("delete from tracking_tokens where tenant_id = $1 and email_id = $2", [input.tenantId, input.emailId]);
  if (!input.html) return null;
  const row = await client.query<TrackingDomain & { track: boolean | null }>(
    `select d.name, d.open_tracking, d.click_tracking, d.tracking_subdomain, d.records, t.track
     from emails e
     join domains d on d.tenant_id = e.tenant_id and lower(d.name) = lower(split_part(e.from_email, '@', 2)) and d.deleted_at is null
     left join templates t on t.tenant_id = e.tenant_id and t.id = e.template_id
     where e.tenant_id = $1 and e.id = $2`,
    [input.tenantId, input.emailId],
  );
  const domain = row.rows[0];
  if (!domain) return null;
  const tracking = trackHtml(domain, input.html, input.publicUrl, domain.track !== false);
  await storeTokens(client, input.tenantId, input.emailId, tracking.tokens);
  return tracking.tokens.length > 0 ? (tracking.html ?? null) : null;
}

type BrandRow = { name: string; brand: BrandRecord; domain: string | null };

const brandCache = new Map<string, { expires: number; row: BrandRow }>();

export function clearBrandCache(tenantId?: string) {
  if (!tenantId) {
    brandCache.clear();
    return;
  }
  brandCache.delete(tenantId);
}

export async function loadBrand(client: Queryable, tenantId: string) {
  const cached = brandCache.get(tenantId);
  if (cached && cached.expires > Date.now()) return cached.row;
  const tenant = await client.query<{ name: string; brand: BrandRecord | null }>(
    "select name, brand from tenants where id = $1",
    [tenantId],
  );
  const domain = await client.query<{ name: string }>(
    "select name from domains where tenant_id = $1 and status = 'verified' and deleted_at is null order by created_at limit 1",
    [tenantId],
  );
  const row: BrandRow = {
    name: tenant.rows[0]?.name ?? "",
    brand: tenant.rows[0]?.brand ?? {},
    domain: domain.rows[0]?.name ?? null,
  };
  brandCache.set(tenantId, { expires: Date.now() + 5_000, row });
  return row;
}
