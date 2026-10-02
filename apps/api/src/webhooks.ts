import {
  ApiError,
  decrypt,
  encrypt,
  encrypted,
  formatWebhookPayload,
  id,
  list,
  makeWebhookSecret,
  webhookEventData,
} from "@dispatchmail/core";
import type { Queryable } from "@dispatchmail/db";
import {
  presentWebhook,
  presentWebhookAttempt,
  presentWebhookEvent,
  type WebhookRecord,
} from "./present.js";

export function presentStoredWebhook(row: WebhookRecord & { secret: string }, appSecret: string) {
  return presentWebhook(row, decrypt(row.secret, appSecret));
}

export async function rotateWebhookSecret(db: Queryable, tenantId: string, webhookId: string, appSecret: string) {
  const secret = makeWebhookSecret();
  const current = await db.query<{ secret: string }>(
    "select secret from webhooks where tenant_id = $1 and id = $2",
    [tenantId, webhookId],
  );
  if (!current.rows[0]) throw new ApiError("not_found", 404, "Webhook not found");
  // An endpoint created before secrets were encrypted still holds plaintext. It is encrypted
  // here so the old secret is never written back in the clear.
  const previous = encrypted(current.rows[0].secret)
    ? current.rows[0].secret
    : encrypt(current.rows[0].secret, appSecret);
  const row = await db.query(
    `update webhooks
     set previous_secret = $4,
         previous_secret_expires_at = now() + interval '24 hours',
         secret = $3,
         updated_at = now()
     where tenant_id = $1 and id = $2
     returning id, url, events, enabled, created_at`,
    [tenantId, webhookId, encrypt(secret, appSecret), previous],
  );
  const stored = row.rows[0] as WebhookRecord | undefined;
  if (!stored) throw new ApiError("not_found", 404, "Webhook not found");
  return presentWebhook(stored, secret);
}

export async function listWebhookEvents(
  db: Queryable,
  tenantId: string,
  webhookId: string,
  paging: { limit?: number; after?: string; before?: string },
) {
  if (paging.before) throw new ApiError("validation_error", 400, "before is not supported");
  if (paging.limit !== undefined && (!Number.isInteger(paging.limit) || paging.limit < 1 || paging.limit > 100)) {
    throw new ApiError("validation_error", 400, "limit must be between 1 and 100");
  }
  const limit = paging.limit ?? 20;
  const rows = await db.query(
    `select e.id, e.type, e.created_at,
            (array_agg(a.state order by a.created_at desc, a.id desc))[1] as state,
            (array_agg(a.attempt order by a.created_at desc, a.id desc))[1]::int as attempt
     from webhook_attempts a
     join email_events e on e.id = a.event_id and e.tenant_id = a.tenant_id
     where a.tenant_id = $1 and a.webhook_id = $2
       and ($3::text is null or (e.created_at, e.id) < (
         select created_at, id from email_events where tenant_id = $1 and id = $3 limit 1
       ))
     group by e.id, e.type, e.created_at
     order by e.created_at desc, e.id desc
     limit $4`,
    [tenantId, webhookId, paging.after ?? null, limit + 1],
  );
  const page = rows.rows.slice(0, limit).map((event) =>
    presentWebhookEvent({
      id: String(event.id),
      type: String(event.type),
      created_at: event.created_at as string,
      state: String(event.state),
      attempt: Number(event.attempt),
    }),
  );
  return list(page, rows.rows.length > limit);
}

export async function webhookEventDetail(db: Queryable, tenantId: string, webhookId: string, eventId: string) {
  const row = await db.query(
    `select e.id, e.request_id, e.type, e.email_id, e.data, e.created_at,
            m.created_at as email_created_at, m.from_email, m.from_name, m.subject,
            m.message_id, m.tags, m.broadcast_id, m.template_id,
            coalesce((
              select jsonb_agg(r.email order by r.created_at)
              from email_recipients r
              where r.tenant_id = e.tenant_id and r.email_id = m.id and r.kind = 'to'
            ), '[]'::jsonb) as to,
            newest.state, newest.attempt, queued.available_at as next_attempt_at
     from email_events e
     join lateral (
       select state, attempt
       from webhook_attempts
       where tenant_id = $1 and webhook_id = $2 and event_id = e.id
       order by created_at desc, id desc
       limit 1
     ) newest on true
     left join emails m on m.tenant_id = e.tenant_id and m.id = e.email_id
     left join lateral (
       select available_at
       from webhook_attempts
       where tenant_id = $1 and webhook_id = $2 and event_id = e.id and state = 'queued'
       order by attempt
       limit 1
     ) queued on true
     where e.tenant_id = $1 and e.id = $3`,
    [tenantId, webhookId, eventId],
  );
  const event = row.rows[0];
  if (!event) throw new ApiError("not_found", 404, "Webhook event not found");
  const createdAt = stamp(event.created_at);
  const payload = formatWebhookPayload({
    id: String(event.id),
    request_id: event.request_id == null ? null : String(event.request_id),
    type: event.type as never,
    email_id: event.email_id == null ? null : String(event.email_id),
    data: webhookEventData({
      email_id: event.email_id == null ? null : String(event.email_id),
      email_created_at: stamp(event.email_created_at) ?? null,
      from_email: event.from_email == null ? null : String(event.from_email),
      from_name: event.from_name == null ? null : String(event.from_name),
      to: Array.isArray(event.to) ? (event.to as string[]) : [],
      subject: event.subject == null ? null : String(event.subject),
      message_id: event.message_id == null ? null : String(event.message_id),
      tags: (event.tags as Record<string, string> | null) ?? null,
      broadcast_id: event.broadcast_id == null ? null : String(event.broadcast_id),
      template_id: event.template_id == null ? null : String(event.template_id),
      data: (event.data as Record<string, unknown> | null) ?? {},
    }),
    created_at: createdAt,
  });
  return {
    ...presentWebhookEvent({
      id: String(event.id),
      type: String(event.type),
      created_at: createdAt ?? "",
      state: String(event.state),
      attempt: Number(event.attempt),
    }),
    payload,
    next_attempt_at: event.next_attempt_at ?? null,
  };
}

export async function webhookEventAttempts(db: Queryable, tenantId: string, webhookId: string, eventId: string) {
  const rows = await db.query(
    `select id, status, response, updated_at
     from webhook_attempts
     where tenant_id = $1 and webhook_id = $2 and event_id = $3
     order by created_at, id`,
    [tenantId, webhookId, eventId],
  );
  return list(
    rows.rows.map((attempt) =>
      presentWebhookAttempt({
        id: String(attempt.id),
        status: attempt.status == null ? null : Number(attempt.status),
        response: attempt.response == null ? null : String(attempt.response),
        updated_at: (attempt.updated_at as string | Date | null) ?? null,
      }),
    ),
  );
}

export async function queueWebhookReplay(
  db: Queryable,
  input: { tenantId: string; webhookId: string; eventId: string; requestId: string },
) {
  const row = await db.query(
    `select e.id, e.request_id
     from email_events e
     join webhooks w on w.tenant_id = e.tenant_id
     where w.id = $2 and w.tenant_id = $1 and e.id = $3 and w.enabled = true and w.events ? e.type
     limit 1`,
    [input.tenantId, input.webhookId, input.eventId],
  );
  const event = row.rows[0];
  if (!event) throw new ApiError("not_found", 404, "No event to replay");
  const attemptId = id("attempt");
  await db.query(
    `insert into webhook_attempts (id, tenant_id, request_id, webhook_id, event_id, state)
     values ($1, $2, $3, $4, $5, 'queued')`,
    [attemptId, input.tenantId, event.request_id ?? input.requestId, input.webhookId, event.id],
  );
  await db.query(
    `insert into webhook_replays (id, tenant_id, webhook_id, event_id, attempt_id, request_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [id("replay"), input.tenantId, input.webhookId, event.id, attemptId, input.requestId],
  );
  return { queued: true, event_id: String(event.id) };
}

function stamp(value: unknown) {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
