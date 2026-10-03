import { ApiError, assertBlocks, brandContext, contactField, id, missingVariables, parseAddress, renderTemplate } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { publishedTemplate } from "./index.js";
import { loadBrand } from "./emails.js";

export type BroadcastRow = {
  id: string;
  name: string;
  from_email: string;
  from_name: string | null;
  reply_to: string[] | null;
  subject: string | null;
  preview_text: string | null;
  html: string | null;
  text: string | null;
  template_id: string | null;
  template_version_id: string | null;
  variables: Record<string, unknown> | null;
  topic_id: string | null;
  segment_id: string | null;
  status: string;
  recipient_count: number;
  sent_count: number;
  request_id: string | null;
  scheduled_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  sent_at: string | Date | null;
};

export type BroadcastWrite = {
  name?: string;
  segment_id?: string;
  from?: string;
  reply_to?: string[] | null;
  subject?: string;
  preview_text?: string | null;
  html?: string | null;
  text?: string | null;
  template?: string;
  variables?: Record<string, unknown>;
  topic_id?: string | null;
};

const columnNames = [
  "id",
  "name",
  "from_email",
  "from_name",
  "reply_to",
  "subject",
  "preview_text",
  "html",
  "text",
  "template_id",
  "template_version_id",
  "variables",
  "topic_id",
  "segment_id",
  "status",
  "recipient_count",
  "sent_count",
  "request_id",
  "scheduled_at",
  "created_at",
  "updated_at",
  "sent_at",
];

export const broadcastColumns = columnNames.join(", ");

export function broadcastColumnsOf(alias: string) {
  return columnNames.map((name) => `${alias}.${name}`).join(", ");
}

export function broadcastStatus(status: string) {
  if (status === "sending" || status === "paused") return "queued";
  if (status === "cancelled") return "canceled";
  return status;
}

function sender(row: Pick<BroadcastRow, "from_email" | "from_name">) {
  return row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email;
}

export function presentBroadcastSummary(row: BroadcastRow) {
  return {
    object: "broadcast" as const,
    id: row.id,
    name: row.name,
    audience_id: row.segment_id,
    segment_id: row.segment_id,
    status: broadcastStatus(row.status),
    created_at: row.created_at,
    scheduled_at: row.scheduled_at ?? null,
    sent_at: row.sent_at ?? null,
  };
}

export function presentBroadcast(row: BroadcastRow) {
  return {
    object: "broadcast" as const,
    id: row.id,
    name: row.name,
    audience_id: row.segment_id,
    segment_id: row.segment_id,
    from: sender(row),
    subject: row.subject,
    reply_to: row.reply_to?.length ? row.reply_to : null,
    preview_text: row.preview_text ?? null,
    html: row.html ?? null,
    text: row.text ?? null,
    topic_id: row.topic_id ?? null,
    status: broadcastStatus(row.status),
    paused: row.status === "paused",
    template_id: row.template_id ?? null,
    variables: row.variables ?? {},
    recipient_count: row.recipient_count ?? 0,
    sent_count: row.sent_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    scheduled_at: row.scheduled_at ?? null,
    sent_at: row.sent_at ?? null,
  };
}

// Who a send would reach right now, and why the rest are left out. Uses the same rules as
// snapshotBroadcast, so the number on the review step is the number that gets queued.
// `no_first_name` and `no_last_name` count the recipients who would see a blank for that field.
export async function broadcastAudience(db: Queryable, tenantId: string, filter: { segmentId: string | null; topicId: string | null }) {
  type Counts = { total: number; recipients: number; unsubscribed: number; suppressed: number; opted_out: number; no_first_name: number; no_last_name: number };
  const row = await db.query<Counts>(
    `select
       count(*)::integer as total,
       count(*) filter (where unsubscribed)::integer as unsubscribed,
       count(*) filter (where not unsubscribed and suppressed)::integer as suppressed,
       count(*) filter (where not unsubscribed and not suppressed and not topic_ok)::integer as opted_out,
       count(*) filter (where not unsubscribed and not suppressed and topic_ok)::integer as recipients,
       count(*) filter (where not unsubscribed and not suppressed and topic_ok and no_first_name)::integer as no_first_name,
       count(*) filter (where not unsubscribed and not suppressed and topic_ok and no_last_name)::integer as no_last_name
     from (
       select
         coalesce(trim(c.first_name), '') = '' as no_first_name,
         coalesce(trim(c.last_name), '') = '' as no_last_name,
         c.unsubscribed_at is not null as unsubscribed,
         exists (
           select 1 from suppressions sup
           where sup.tenant_id = c.tenant_id and lower(sup.email) = lower(c.email) and sup.removed_at is null
         ) as suppressed,
         (
           $3::text is null
           or (t.default_status = 'subscribed' and coalesce(s.status, 'subscribed') = 'subscribed')
           or (t.default_status = 'unsubscribed' and s.status = 'subscribed')
         ) as topic_ok
       from contacts c
       left join topics t on t.tenant_id = c.tenant_id and t.id = $3 and t.deleted_at is null
       left join topic_subscriptions s on s.tenant_id = c.tenant_id and s.topic_id = t.id and s.contact_id = c.id
       where c.tenant_id = $1
         and c.deleted_at is null
         and (
           $2::text is null
           or exists (
             select 1 from segment_contacts sc
             where sc.tenant_id = c.tenant_id and sc.segment_id = $2 and sc.contact_id = c.id
           )
         )
     ) audience`,
    [tenantId, filter.segmentId, filter.topicId],
  );
  const counts = row.rows[0] ?? { total: 0, recipients: 0, unsubscribed: 0, suppressed: 0, opted_out: 0, no_first_name: 0, no_last_name: 0 };
  return { object: "broadcast_audience" as const, ...counts };
}

export async function findBroadcast(db: Queryable, tenantId: string, broadcastId: string) {
  const row = await db.query<BroadcastRow>(
    `select ${broadcastColumns} from broadcasts where tenant_id = $1 and id = $2 and deleted_at is null`,
    [tenantId, broadcastId],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Broadcast not found");
  return row.rows[0];
}

async function assertAudience(db: Queryable, tenantId: string, segmentId?: string | null, topicId?: string | null) {
  if (segmentId) {
    const segment = await db.query(
      "select id from segments where tenant_id = $1 and id = $2 and deleted_at is null",
      [tenantId, segmentId],
    );
    if (!segment.rows[0]) throw new ApiError("not_found", 404, "Segment not found");
  }
  if (topicId) {
    const topic = await db.query(
      "select id from topics where tenant_id = $1 and id = $2 and deleted_at is null",
      [tenantId, topicId],
    );
    if (!topic.rows[0]) throw new ApiError("not_found", 404, "Topic not found");
  }
}

// Template content is copied raw. Placeholders are filled per recipient in the worker.
async function templateContent(db: Queryable, tenantId: string, input: BroadcastWrite) {
  const template = await publishedTemplate(db, tenantId, input.template!);
  return {
    subject: input.subject ?? template.subject ?? null,
    html: input.html ?? template.html ?? null,
    text: input.text ?? template.text ?? null,
    template_id: template.template_id,
    template_version_id: template.id,
  };
}

export async function createBroadcast(
  db: Queryable,
  tenantId: string,
  requestId: string,
  input: BroadcastWrite & { segment_id: string; from: string },
) {
  await assertAudience(db, tenantId, input.segment_id, input.topic_id);
  const content = input.template
    ? await templateContent(db, tenantId, input)
    : {
        subject: input.subject ?? null,
        html: input.html ?? null,
        text: input.text ?? null,
        template_id: null,
        template_version_id: null,
      };
  if (!content.subject) throw new ApiError("validation_error", 422, "subject is required");
  const from = parseAddress(input.from);
  const row = await db.query<BroadcastRow>(
    `insert into broadcasts (
       id, tenant_id, name, from_email, from_name, reply_to, subject, preview_text, html, text,
       template_id, template_version_id, variables, topic_id, segment_id, request_id
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning ${broadcastColumns}`,
    [
      id("broadcast"),
      tenantId,
      input.name ?? content.subject,
      from.email,
      from.name,
      JSON.stringify(input.reply_to ?? []),
      content.subject,
      input.preview_text ?? null,
      content.html,
      content.text,
      content.template_id,
      content.template_version_id,
      JSON.stringify(input.variables ?? {}),
      input.topic_id ?? null,
      input.segment_id,
      requestId,
    ],
  );
  return row.rows[0];
}

export async function updateBroadcast(db: Queryable, tenantId: string, broadcastId: string, input: BroadcastWrite) {
  const current = await findBroadcast(db, tenantId, broadcastId);
  if (current.status !== "draft") {
    throw new ApiError("validation_error", 422, "Only draft broadcasts can be updated");
  }
  await assertAudience(db, tenantId, input.segment_id, input.topic_id);
  const content = input.template
    ? await templateContent(db, tenantId, input)
    : {
        subject: input.subject ?? current.subject,
        html: input.html === undefined ? current.html : input.html,
        text: input.text === undefined ? current.text : input.text,
        template_id: current.template_id,
        template_version_id: current.template_version_id,
      };
  const from = input.from ? parseAddress(input.from) : { email: current.from_email, name: current.from_name };
  const row = await db.query<BroadcastRow>(
    `update broadcasts set name = $3, from_email = $4, from_name = $5, reply_to = $6, subject = $7, preview_text = $8,
       html = $9, text = $10, template_id = $11, template_version_id = $12, variables = $13, topic_id = $14,
       segment_id = $15, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null and status = 'draft'
     returning ${broadcastColumns}`,
    [
      tenantId,
      broadcastId,
      input.name ?? current.name,
      from.email,
      from.name,
      JSON.stringify(input.reply_to === undefined ? (current.reply_to ?? []) : (input.reply_to ?? [])),
      content.subject,
      input.preview_text === undefined ? current.preview_text : input.preview_text,
      content.html,
      content.text,
      content.template_id,
      content.template_version_id,
      JSON.stringify(input.variables ?? current.variables ?? {}),
      input.topic_id === undefined ? current.topic_id : input.topic_id,
      input.segment_id ?? current.segment_id,
    ],
  );
  if (!row.rows[0]) throw new ApiError("validation_error", 422, "Only draft broadcasts can be updated");
  return row.rows[0];
}

// One conditional update per transition, so a concurrent change cannot slip between the check and the write.
async function transition(
  db: Queryable,
  tenantId: string,
  broadcastId: string,
  from: string[],
  set: string,
  params: unknown[],
  message: string,
) {
  const row = await db.query<BroadcastRow>(
    `update broadcasts set ${set}, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null and status = any($3::text[])
     returning ${broadcastColumns}`,
    [tenantId, broadcastId, from, ...params],
  );
  if (row.rows[0]) return row.rows[0];
  await findBroadcast(db, tenantId, broadcastId);
  throw new ApiError("validation_error", 422, message);
}

export async function sendBroadcast(
  db: Queryable,
  tenantId: string,
  broadcastId: string,
  options: { scheduledAt?: Date | null; requestId: string; now?: number },
) {
  const current = await findBroadcast(db, tenantId, broadcastId);
  if (current.status !== "draft") {
    throw new ApiError("validation_error", 422, "Only draft broadcasts can be sent");
  }
  if (!current.segment_id) throw new ApiError("validation_error", 422, "segment_id is required");
  if (!current.subject || (!current.html && !current.text)) {
    throw new ApiError("validation_error", 422, "subject and html or text are required");
  }
  // Checked once here, so a broken block fails the send request and not every recipient.
  assertBlocks(current);
  // A placeholder that nothing fills would fail every recipient the same way: a brand value that
  // was never set, such as the company address a newsletter prints, or a variable with no value.
  // That is found here, with sample renders. A missing contact field never fails: it prints as a
  // blank for the contact who lacks it. Two samples, one with every contact field the content
  // names and one with none, take both sides of a block that tests a contact field.
  const missing = new Set<string>();
  for (const recipient of samples(current)) {
    try {
      await previewBroadcast(db, tenantId, broadcastId, {}, recipient);
    } catch (error) {
      const keys = missingVariables(error);
      if (keys.length === 0) throw error;
      keys.forEach((key) => missing.add(key));
    }
  }
  if (missing.size) {
    const same = [...missing];
    const brand = same.filter((key) => brandNames.includes(key));
    throw new ApiError(
      "validation_error",
      422,
      brand.length
        ? `The broadcast uses ${brand.join(", ")}, which the brand settings do not set. Add ${brand.length === 1 ? "it" : "them"} under Settings, Brand, or remove ${brand.length === 1 ? "it" : "them"} from the content.`
        : `The broadcast uses ${same.join(", ")} and nothing gives ${same.length === 1 ? "it" : "them"} a value. Add a fallback, or pass ${same.length === 1 ? "it" : "them"} in variables.`,
    );
  }
  // The same check a single send gets. Without it every recipient would fail one by one and
  // the broadcast would end as sent with nothing sent.
  const domain = await db.query<{ sending: string | null }>(
    `select sending from domains
     where tenant_id = $1 and lower(name) = lower(split_part($2, '@', 2)) and status = 'verified' and deleted_at is null`,
    [tenantId, current.from_email],
  );
  if (!domain.rows[0]) throw new ApiError("validation_error", 403, "Sender domain is not verified");
  if (domain.rows[0].sending === "disabled") throw new ApiError("validation_error", 403, "Sending is disabled for this domain");
  const later = Boolean(options.scheduledAt && options.scheduledAt.getTime() > (options.now ?? Date.now()));
  return transition(
    db,
    tenantId,
    broadcastId,
    ["draft"],
    "status = $4, scheduled_at = $5, request_id = $6",
    [later ? "scheduled" : "sending", later ? options.scheduledAt : null, options.requestId],
    "Only draft broadcasts can be sent",
  );
}

const brandNames = ["PRODUCT_NAME", "PRODUCT_URL", "LOGO_URL", "BRAND_COLOR", "BRAND_TEXT_COLOR", "SUPPORT_EMAIL", "SUPPORT_URL", "PRIVACY_URL", "COMPANY_NAME", "COMPANY_ADDRESS", "CURRENT_YEAR"];

type Recipient = { email: string; first_name: string | null; last_name: string | null; properties: Record<string, unknown> | null };

/** What a broadcast's content can read about the contact it is being sent to. */
export function recipientContext(recipient: Recipient, unsubscribeUrl: string) {
  const firstName = recipient.first_name ?? undefined;
  const lastName = recipient.last_name ?? undefined;
  return {
    contact: { ...(recipient.properties ?? {}), email: recipient.email, first_name: firstName, last_name: lastName },
    FIRST_NAME: firstName,
    LAST_NAME: lastName,
    EMAIL: recipient.email,
    UNSUBSCRIBE_URL: unsubscribeUrl,
    RESEND_UNSUBSCRIBE_URL: unsubscribeUrl,
    DISPATCH_UNSUBSCRIBE_URL: unsubscribeUrl,
  };
}

/** One recipient's email. `overrides` replace context values, for a test send. */
export function renderBroadcast(
  broadcast: Pick<BroadcastRow, "subject" | "html" | "text" | "variables" | "preview_text"> & { declared?: unknown },
  recipient: Recipient,
  brand: Record<string, unknown>,
  unsubscribeUrl: string,
  overrides: Record<string, unknown> = {},
) {
  const rendered = renderTemplate(
    { subject: broadcast.subject, html: broadcast.html, text: broadcast.text, variables: broadcast.declared },
    broadcast.variables ?? {},
    { ...brand, ...recipientContext(recipient, unsubscribeUrl), ...overrides },
    { blank: contactField },
  );
  return {
    subject: rendered.subject,
    html: rendered.html ? withPreview(rendered.html, broadcast.preview_text) : rendered.html,
    text: rendered.text,
  };
}

const hidden =
  "display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all";

export function withPreview(html: string, previewText: string | null | undefined) {
  if (!previewText) return html;
  const escaped = previewText.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const block = `<div style="${hidden}">${escaped}</div>`;
  return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (tag) => `${tag}${block}`) : `${block}${html}`;
}

/** A sample contact for previews and test sends, with every built-in field filled. */
export const sampleRecipient: Recipient = { email: "ada@example.com", first_name: "Ada", last_name: "Lovelace", properties: {} };

/** A contact with every field the content names, and one with none. */
function samples(broadcast: Pick<BroadcastRow, "subject" | "html" | "text">) {
  const content = [broadcast.subject, broadcast.html, broadcast.text].join("\n");
  const keys = new Set([...content.matchAll(/contact\.([A-Za-z0-9_]+)/g)].map((match) => match[1]!));
  const properties = Object.fromEntries([...keys].map((key) => [key, "sample"]));
  return [
    { ...sampleRecipient, properties },
    { email: sampleRecipient.email, first_name: null, last_name: null, properties: {} },
  ];
}

/**
 * The saved broadcast rendered the way the worker renders it, for the sample contact. Test sends
 * use this, so the test email is what a real recipient gets. `values` replace context values,
 * such as `contact` or `FIRST_NAME`.
 */
export async function previewBroadcast(db: Queryable, tenantId: string, broadcastId: string, values: Record<string, unknown> = {}, recipient: Recipient = sampleRecipient) {
  const row = await db.query<DueBroadcast>(
    `select b.tenant_id, ${broadcastColumnsOf("b")}, v.variables as declared
     from broadcasts b
     left join template_versions v on v.tenant_id = b.tenant_id and v.id = b.template_version_id
     where b.tenant_id = $1 and b.id = $2 and b.deleted_at is null`,
    [tenantId, broadcastId],
  );
  const broadcast = row.rows[0];
  if (!broadcast) throw new ApiError("not_found", 404, "Broadcast not found");
  const brand = await loadBrand(db, tenantId);
  const brandVars = brandContext(brand.brand, { tenantName: brand.name, domain: brand.domain, from: broadcast.from_email });
  return renderBroadcast(broadcast, recipient, brandVars, "https://example.com/unsubscribe", values);
}

export async function cancelBroadcast(db: Queryable, tenantId: string, broadcastId: string) {
  const row = await transition(
    db,
    tenantId,
    broadcastId,
    ["scheduled", "sending", "paused"],
    `status = case when status = 'scheduled' then 'draft' else 'cancelled' end,
     scheduled_at = case when status = 'scheduled' then null else scheduled_at end`,
    [],
    "Only queued or scheduled broadcasts can be canceled",
  );
  if (row.status === "cancelled") {
    await db.query(
      `update broadcast_recipients set status = 'cancelled', updated_at = now()
       where tenant_id = $1 and broadcast_id = $2 and status = 'queued'`,
      [tenantId, broadcastId],
    );
    // Emails already created for this broadcast but not yet handed to the provider are
    // cancelled too. The delivery worker skips a cancelled email.
    await db.query(
      `update send_jobs j set state = 'cancelled', updated_at = now()
       from emails e
       where e.tenant_id = $1 and e.broadcast_id = $2 and j.email_id = e.id and j.state = 'ready'`,
      [tenantId, broadcastId],
    );
    await db.query(
      `update emails set status = 'cancelled', updated_at = now()
       where tenant_id = $1 and broadcast_id = $2 and status in ('queued', 'scheduled')`,
      [tenantId, broadcastId],
    );
  }
  return row;
}

export function pauseBroadcast(db: Queryable, tenantId: string, broadcastId: string) {
  return transition(db, tenantId, broadcastId, ["sending"], "status = 'paused'", [], "Only sending broadcasts can be paused");
}

export function resumeBroadcast(db: Queryable, tenantId: string, broadcastId: string) {
  return transition(db, tenantId, broadcastId, ["paused"], "status = 'sending'", [], "Only paused broadcasts can be resumed");
}

export function deleteBroadcast(db: Queryable, tenantId: string, broadcastId: string) {
  return transition(
    db,
    tenantId,
    broadcastId,
    ["draft", "scheduled", "cancelled"],
    `deleted_at = now(),
     status = case when status = 'scheduled' then 'cancelled' else status end,
     scheduled_at = case when status = 'scheduled' then null else scheduled_at end`,
    [],
    "Only draft or scheduled broadcasts can be deleted",
  );
}

export function copyName(name: string) {
  return `${name} (copy)`.slice(0, 70);
}

export async function duplicateBroadcast(db: Queryable, tenantId: string, broadcastId: string, requestId: string, name?: string) {
  const source = await findBroadcast(db, tenantId, broadcastId);
  const row = await db.query<BroadcastRow>(
    `insert into broadcasts (
       id, tenant_id, name, from_email, from_name, reply_to, subject, preview_text, html, text,
       template_id, template_version_id, variables, topic_id, segment_id, request_id, status
     )
     select $3, tenant_id, $4, from_email, from_name, reply_to, subject, preview_text, html, text,
       template_id, template_version_id, variables, topic_id, segment_id, $5, 'draft'
     from broadcasts
     where tenant_id = $1 and id = $2
     returning ${broadcastColumns}`,
    [tenantId, source.id, id("broadcast"), name ?? copyName(source.name), requestId],
  );
  return row.rows[0];
}

export async function snapshotBroadcast(client: Queryable, tenantId: string, broadcastId: string) {
  const broadcast = await client.query<{
    topic_id: string | null;
    segment_id: string | null;
  }>("select topic_id, segment_id from broadcasts where tenant_id = $1 and id = $2 for update", [tenantId, broadcastId]);
  if (!broadcast.rows[0]) throw new ApiError("not_found", 404, "Broadcast not found");
  // One statement, entirely in the database: a segment of millions never crosses into Node.
  // `distinct on` keeps one row per mailbox when two contacts differ only by letter case.
  const inserted = await client.query(
    `insert into broadcast_recipients (id, tenant_id, broadcast_id, contact_id, email, status)
     select 'br_' || md5($4 || ':' || picked.contact_id), $1, $4, picked.contact_id, picked.email, 'queued'
     from (
     select distinct on (lower(c.email)) c.id as contact_id, c.email, c.created_at
     from contacts c
     left join topics t on t.tenant_id = c.tenant_id and t.id = $3 and t.deleted_at is null
     left join topic_subscriptions s on s.tenant_id = c.tenant_id and s.topic_id = t.id and s.contact_id = c.id
     where c.tenant_id = $1
       and c.deleted_at is null
       and c.unsubscribed_at is null
       and not exists (
         select 1 from suppressions sup
         where sup.tenant_id = c.tenant_id and lower(sup.email) = lower(c.email) and sup.removed_at is null
       )
       and (
         $2::text is null
         or exists (
           select 1 from segment_contacts sc
           where sc.tenant_id = c.tenant_id and sc.segment_id = $2 and sc.contact_id = c.id
         )
       )
       and (
         $3::text is null
         or (t.default_status = 'subscribed' and coalesce(s.status, 'subscribed') = 'subscribed')
         or (t.default_status = 'unsubscribed' and s.status = 'subscribed')
       )
     order by lower(c.email), c.created_at
     ) picked
     on conflict (tenant_id, broadcast_id, contact_id)
     do update set email = excluded.email, status = 'queued', updated_at = now()`,
    [tenantId, broadcast.rows[0].segment_id, broadcast.rows[0].topic_id, broadcastId],
  );
  return inserted.rowCount ?? 0;
}

// A broadcast that keeps failing is stopped after five tries, with the reason on its row, so
// one bad broadcast cannot hold the worker's attention forever.
export const broadcastFailureLimit = 5;

export async function failBroadcast(db: Queryable, broadcastId: string, message: string) {
  await db.query(
    `update broadcasts set
       failures = failures + 1,
       error = $2,
       status = case when failures + 1 >= $3 then 'cancelled' else status end,
       updated_at = now()
     where id = $1`,
    [broadcastId, message.slice(0, 1000), broadcastFailureLimit],
  );
}

export type DueBroadcast = BroadcastRow & { tenant_id: string; declared: unknown };

// A broadcast is claimed only while fewer than `backlog` of its emails are waiting to be
// delivered. Emails are created far faster than SES accepts them, and an email that already
// exists cannot be held back by a pause, a cancel, or a late unsubscribe. Keeping the backlog
// short is what makes those take effect within a few hundred emails.
export async function claimBroadcast(client: Queryable, exclude: string[] = [], backlog = 400) {
  const row = await client.query<DueBroadcast>(
    `select b.tenant_id, ${broadcastColumnsOf("b")}, v.variables as declared
     from broadcasts b
     left join template_versions v on v.tenant_id = b.tenant_id and v.id = b.template_version_id
     where b.deleted_at is null
       and (b.status = 'sending' or (b.status = 'scheduled' and b.scheduled_at <= now()))
       and not (b.id = any($1::text[]))
       and (
         select count(*) from (
           select 1 from emails e
           join send_jobs j on j.email_id = e.id and j.state in ('ready', 'running')
           where e.tenant_id = b.tenant_id and e.broadcast_id = b.id
           limit $2
         ) waiting
       ) < $2
     order by coalesce(b.scheduled_at, b.updated_at), b.id
     limit 1
     for update of b skip locked`,
    [exclude, backlog],
  );
  const broadcast = row.rows[0];
  if (!broadcast) return null;
  if (broadcast.status === "scheduled") {
    await client.query("update broadcasts set status = 'sending', updated_at = now() where tenant_id = $1 and id = $2", [
      broadcast.tenant_id,
      broadcast.id,
    ]);
    broadcast.status = "sending";
  }
  return broadcast;
}

export async function hasRecipients(client: Queryable, tenantId: string, broadcastId: string) {
  const row = await client.query<{ found: boolean }>(
    "select exists (select 1 from broadcast_recipients where tenant_id = $1 and broadcast_id = $2) as found",
    [tenantId, broadcastId],
  );
  return Boolean(row.rows[0]?.found);
}

export async function countRecipients(client: Queryable, tenantId: string, broadcastId: string, count: number) {
  await client.query("update broadcasts set recipient_count = $3, updated_at = now() where tenant_id = $1 and id = $2", [
    tenantId,
    broadcastId,
    count,
  ]);
}

export type QueuedRecipient = {
  id: string;
  contact_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  properties: Record<string, unknown> | null;
  skip: boolean;
};

export async function queuedRecipients(client: Queryable, tenantId: string, broadcastId: string, limit: number) {
  const rows = await client.query<QueuedRecipient>(
    `select br.id, br.contact_id, br.email, c.first_name, c.last_name, c.properties,
       (c.id is null or c.deleted_at is not null or c.unsubscribed_at is not null) as skip
     from broadcast_recipients br
     left join contacts c on c.tenant_id = br.tenant_id and c.id = br.contact_id
     where br.tenant_id = $1 and br.broadcast_id = $2 and br.status = 'queued'
     order by br.created_at, br.id
     limit $3`,
    [tenantId, broadcastId, limit],
  );
  return rows.rows;
}

export type RecipientResult = { id: string; status: "sent" | "failed" | "skipped"; email_id?: string | null; error?: string | null };

export async function markRecipients(client: Queryable, tenantId: string, results: RecipientResult[]) {
  if (results.length === 0) return;
  await client.query(
    `update broadcast_recipients br
     set status = u.status, email_id = u.email_id, error = u.error, updated_at = now()
     from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as u(id, status, email_id, error)
     where br.tenant_id = $1 and br.id = u.id`,
    [
      tenantId,
      results.map((row) => row.id),
      results.map((row) => row.status),
      results.map((row) => row.email_id ?? null),
      results.map((row) => row.error ?? null),
    ],
  );
}

// Adds this chunk's sends and marks the broadcast sent once no queued recipients remain.
export async function finishChunk(client: Queryable, tenantId: string, broadcastId: string, sent: number) {
  const row = await client.query<{ status: string }>(
    `update broadcasts b set
       sent_count = b.sent_count + $3,
       status = case when q.queued then b.status else 'sent' end,
       sent_at = case when q.queued then b.sent_at else now() end,
       updated_at = now()
     from (
       select exists (
         select 1 from broadcast_recipients where tenant_id = $1 and broadcast_id = $2 and status = 'queued'
       ) as queued
     ) q
     where b.tenant_id = $1 and b.id = $2
     returning b.status`,
    [tenantId, broadcastId, sent],
  );
  return row.rows[0]?.status ?? null;
}

const eventTypes: Record<string, string> = {
  sent: "email.sent",
  delivered: "email.delivered",
  opened: "email.opened",
  clicked: "email.clicked",
  bounced: "email.bounced",
  complained: "email.complained",
  suppressed: "email.suppressed",
};

// Builds the paginate() filter for GET /broadcasts/:id/recipients. Parameters number from $2.
export function recipientFilter(broadcastId: string, query: { type: string; email?: string; bounce_type?: string }) {
  const params: unknown[] = [broadcastId];
  const clauses = ["br.broadcast_id = $2"];
  if (query.type === "unsubscribed") {
    clauses.push("br.unsubscribed_at is not null");
  } else {
    const type = eventTypes[query.type];
    if (!type) throw new ApiError("validation_error", 422, `Unknown recipient type: ${query.type}`);
    params.push(type);
    let event = `ev.tenant_id = br.tenant_id and ev.email_id = br.email_id and ev.type = $${params.length + 1}`;
    if (query.bounce_type) {
      params.push(query.bounce_type);
      event += ` and lower(ev.data->'bounce'->>'type') = lower($${params.length + 1})`;
    }
    clauses.push(`exists (select 1 from email_events ev where ${event})`);
  }
  if (query.email) {
    params.push(`%${query.email.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    clauses.push(`br.email ilike $${params.length + 1}`);
  }
  return { where: clauses.join(" and "), params };
}

export function presentRecipient(row: {
  id: string;
  contact_id: string;
  email: string;
  email_id: string | null;
  status: string;
  created_at: string | Date;
}) {
  return {
    object: "broadcast_recipient" as const,
    id: row.id,
    contact_id: row.contact_id,
    email: row.email,
    email_id: row.email_id,
    status: row.status,
    created_at: row.created_at,
  };
}

export async function clickedLinks(db: Queryable, tenantId: string, broadcastId: string) {
  const rows = await db.query<{ id: string; url: string; clicks: number; unique_clicks: number }>(
    `select 'link_' || md5(link.url) as id, link.url,
       count(*)::int as clicks,
       count(distinct ev.email_id)::int as unique_clicks
     from email_events ev
     join emails e on e.tenant_id = ev.tenant_id and e.id = ev.email_id
     cross join lateral (select coalesce(ev.data->'click'->>'link', ev.data->>'url') as url) link
     where ev.tenant_id = $1 and e.broadcast_id = $2 and ev.type = 'email.clicked' and link.url is not null
       and not e.sandbox and coalesce(ev.data->>'sandbox', 'false') <> 'true'
       and not exists (select 1 from email_recipients r where r.tenant_id = ev.tenant_id and r.id = ev.recipient_id and r.sandbox)
     group by link.url
     order by clicks desc, link.url`,
    [tenantId, broadcastId],
  );
  return rows.rows.map((row) => ({ object: "clicked_link" as const, ...row }));
}
