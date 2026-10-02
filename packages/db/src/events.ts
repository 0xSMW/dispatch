import type { Queryable } from "./index.js";
import { incrementUsage } from "./index.js";
import { id, statusFor, type EventType } from "@dispatchmail/core";

// SQS does not keep events in order. A status only moves forward: a late "sent" must not undo
// "delivered", and nothing replaces a bounce, a complaint, or a failure except a later one of those.
const statusRanks: Record<string, number> = { queued: 0, scheduled: 0, sent: 1, delivery_delayed: 2, delivered: 3, opened: 4, clicked: 5 };

function statusRank(status: string) {
  return statusRanks[status] ?? 6;
}

const currentRank = `case status
  when 'queued' then 0 when 'scheduled' then 0 when 'sent' then 1 when 'delivery_delayed' then 2
  when 'delivered' then 3 when 'opened' then 4 when 'clicked' then 5 else 6 end`;

export async function appendEvent(
  client: Queryable,
  input: {
    tenantId: string;
    requestId: string;
    emailId: string | null;
    recipientId?: string | null;
    type: string;
    providerEventId: string;
    data: Record<string, unknown>;
    mode?: "api" | "delivery";
    recipients?: string[];
    provider?: string;
  },
): Promise<{
  id: string;
  tenant_id: string;
  request_id: string | null;
  email_id: string | null;
  type: string;
  data: Record<string, unknown>;
} | null> {
  const mode = input.mode ?? "api";
  const row = await client.query<{
    id: string;
    tenant_id: string;
    request_id: string | null;
    email_id: string | null;
    type: string;
    data: Record<string, unknown>;
  }>(
    `insert into email_events (id, tenant_id, request_id, email_id, recipient_id, type, provider_event_id, data)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (provider_event_id) do nothing
     returning id, tenant_id, request_id, email_id, type, data`,
    [
      id("event"),
      input.tenantId,
      input.requestId,
      input.emailId,
      mode === "delivery" ? null : (input.recipientId ?? null),
      input.type,
      input.providerEventId,
      JSON.stringify(input.data),
    ],
  );
  const event = row.rows[0];
  if (!event) return null;

  if (mode === "delivery") {
    const status = statusFor(input.type as EventType);
    if (status) {
      const rank = statusRank(status);
      await client.query(
        `update emails set status = $3, updated_at = now()
         where tenant_id = $1 and id = $2 and (${currentRank}) <= $4`,
        [input.tenantId, input.emailId, status, rank],
      );
      if (input.recipients) {
        await client.query(
          `update email_recipients set status = $3, updated_at = now()
           where tenant_id = $1 and email_id = $2 and lower(email) = any($5::text[]) and (${currentRank}) <= $4`,
          [input.tenantId, input.emailId, status, rank, input.recipients.map((email) => email.toLowerCase())],
        );
      } else {
        await client.query(
          `update email_recipients set status = $3, updated_at = now()
           where tenant_id = $1 and email_id = $2 and (${currentRank}) <= $4`,
          [input.tenantId, input.emailId, status, rank],
        );
      }
    }

    const bounce = input.data.bounce as { type?: string } | undefined;
    const suppress =
      input.type === "email.complained" ||
      (input.type === "email.bounced" && (bounce?.type ?? "Permanent") === "Permanent");
    if (suppress) {
      const origin = input.type === "email.complained" ? "complaint" : "bounce";
      // Removing a suppression keeps its row with removed_at set. A new bounce or complaint must
      // bring that row back, or the address keeps getting mail.
      const revive = `on conflict (tenant_id, email) do update set
               removed_at = null, reason = excluded.reason, origin = excluded.origin,
               source_id = excluded.source_id, created_at = now()
             where suppressions.removed_at is not null
             returning id, email`;
      const inserted = input.recipients
        ? await client.query<{ id: string; email: string }>(
            `insert into suppressions (id, tenant_id, email, reason, origin, source_id)
             select 'supp_' || md5($1 || email), $1, email, $3, $4, $5
             from (select distinct lower(email) as email from unnest($2::text[]) as t(email)) as addresses
             ${revive}`,
            [input.tenantId, input.recipients, input.type, origin, input.emailId],
          )
        : await client.query<{ id: string; email: string }>(
            `insert into suppressions (id, tenant_id, email, reason, origin, source_id)
             select 'supp_' || md5($1 || email), $1, email, $3, $4, $2
             from (select distinct lower(email) as email from email_recipients where tenant_id = $1 and email_id = $2) as addresses
             ${revive}`,
            [input.tenantId, input.emailId, input.type, origin],
          );
      for (const suppression of inserted.rows) {
        await emit(client, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          type: "suppression.added",
          resourceId: suppression.id,
          data: { id: suppression.id, email: suppression.email, origin },
        });
      }
    }

    await client.query(
      `insert into event_dedupe_keys (id, tenant_id, key, event_id)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, key) do nothing`,
      [id("dedupe"), input.tenantId, input.providerEventId, event.id],
    );
    await client.query(
      `insert into provider_events_raw (id, tenant_id, provider, provider_event_id, event_id, payload)
       values ($1, $2, $6, $3, $4, $5)
       on conflict (tenant_id, provider, provider_event_id)
       do update set event_id = excluded.event_id`,
      [
        id("raw"),
        input.tenantId,
        input.providerEventId,
        event.id,
        JSON.stringify({ type: input.type, data: input.data }),
        input.provider ?? "fake",
      ],
    );
    await incrementUsage(client, input.tenantId, `events.${input.type}`, 1);
    if (input.type === "email.sent")
      await incrementUsage(client, input.tenantId, "emails.sent", 1);
  } else if (input.emailId) {
    const status =
      input.type === "email.opened" || input.type === "email.clicked"
        ? statusFor(input.type as EventType)
        : null;
    if (status) {
      await client.query(
        `update emails set status = $3, updated_at = now()
         where tenant_id = $1 and id = $2
           and status not in ('bounced', 'complained', 'failed', 'cancelled')`,
        [input.tenantId, input.emailId, status],
      );
    }
  }

  return event;
}

export async function emit(
  client: Queryable,
  // `key` makes the event unique. A second emit with the same key is dropped. The default ties it
  // to the request, which suits a worker task that may run twice. An API route passes its own
  // key, because a client is free to reuse one x-request-id for two different calls.
  input: { tenantId: string; requestId: string; type: EventType; resourceId: string; data: Record<string, unknown>; key?: string },
) {
  const event = await appendEvent(client, {
    tenantId: input.tenantId,
    requestId: input.requestId,
    emailId: null,
    type: input.type,
    providerEventId: input.key ?? `${input.resourceId}:${input.type}:${input.requestId}`,
    data: input.data,
  });
  if (event) await fanoutEvent(client, event);
  return event;
}

export async function fanoutEvent(
  client: Queryable,
  event: {
    id: string;
    tenant_id: string;
    request_id: string | null;
    type: string;
  },
): Promise<void> {
  await client.query(
    `insert into webhook_attempts (id, tenant_id, request_id, webhook_id, event_id, state)
     select 'attempt_' || md5(random()::text || clock_timestamp()::text || id), tenant_id, $3, id, $4, 'queued'
     from webhooks
     where tenant_id = $1 and enabled = true and events ? $2`,
    [event.tenant_id, event.type, event.request_id, event.id],
  );
}
