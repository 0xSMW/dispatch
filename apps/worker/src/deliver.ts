import { setTimeout as sleep } from "node:timers/promises";
import { backoffSecs, ProviderError, type Provider, type ProviderEmail } from "@dispatchmail/core";
import { appendEvent, fanoutEvent, tx, type Db, type Queryable } from "@dispatchmail/db";
import type { Storage } from "@dispatchmail/storage";

export type Job = {
  id: string;
  tenant_id: string;
  email_id: string;
  request_id: string;
};

type StoredEmail = {
  id: string;
  tenant_id: string;
  from_email: string;
  from_name: string | null;
  reply_to: string[] | null;
  subject: string;
  html: string | null;
  html_tracked: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  status: string;
  broadcast_id: string | null;
  provider_message_id: string | null;
  region: string | null;
  tls: "opportunistic" | "enforced" | null;
};

const nextSlots = new Map<string, number>();

// Each caller reserves the next free send time for its region before it awaits anything, so
// jobs that start together line up one interval apart. A shared window that every caller reads,
// sleeps on, and writes back lets all the sleepers wake in the same millisecond.
export async function pace(
  region: string,
  maxPerSecond: number,
  options: { now?: number; sleep?: (ms: number) => Promise<void>; slots?: Map<string, number> } = {}
) {
  if (maxPerSecond <= 0) return;
  const slots = options.slots ?? nextSlots;
  const now = options.now ?? Date.now();
  const slot = Math.max(now, slots.get(region) ?? 0);
  slots.set(region, slot + 1000 / maxPerSecond);
  if (slot > now) await (options.sleep ?? sleep)(slot - now);
}

export async function loadProviderEmail(
  db: Queryable,
  storage: Storage,
  job: Job
): Promise<(ProviderEmail & { provider_message_id: string | null }) | null> {
  const email = await db.query<StoredEmail>(
    `select e.id, e.tenant_id, e.from_email, e.from_name, e.reply_to, e.subject, e.html, e.html_tracked, e.text, e.headers, e.status,
            e.broadcast_id, e.provider_message_id, d.region, d.tls
     from emails e
     left join domains d on d.tenant_id = e.tenant_id and lower(d.name) = lower(split_part(e.from_email, '@', 2)) and d.deleted_at is null
     where e.id = $1 and e.tenant_id = $2`,
    [job.email_id, job.tenant_id]
  );
  const row = email.rows[0];
  if (!row || row.status === "cancelled") return null;
  // Checked again at the moment of sending. An email can wait in the queue, or be scheduled
  // days ahead, and in that time the address may have bounced or the person unsubscribed.
  // Suppression applies to every email. A global unsubscribe applies to broadcast mail.
  const recipients = await db.query<{ email: string; kind: "to" | "cc" | "bcc" }>(
    `select r.email, r.kind from email_recipients r
     where r.email_id = $1 and r.status not in ('suppressed', 'failed')
       and not exists (
         select 1 from suppressions s
         where s.tenant_id = $2 and lower(s.email) = lower(r.email) and s.removed_at is null
       )
       and not ($3::boolean and exists (
         select 1 from contacts c
         where c.tenant_id = $2 and lower(c.email) = lower(r.email) and c.deleted_at is null and c.unsubscribed_at is not null
       ))
     order by r.created_at`,
    [job.email_id, job.tenant_id, Boolean(row.broadcast_id)]
  );
  if (recipients.rows.length === 0) {
    await db.query(
      "update emails set status = 'cancelled', updated_at = now() where tenant_id = $1 and id = $2 and status in ('queued', 'scheduled')",
      [job.tenant_id, job.email_id]
    );
    return null;
  }
  const attachments = await db.query<{
    filename: string;
    content_type: string;
    content_id: string | null;
    disposition: "attachment" | "inline";
    storage_key: string;
  }>(
    "select filename, content_type, content_id, disposition, storage_key from email_attachments where email_id = $1",
    [job.email_id]
  );
  const files = [];
  for (const attachment of attachments.rows) {
    files.push({
      filename: attachment.filename,
      content_type: attachment.content_type,
      content_id: attachment.content_id,
      disposition: attachment.disposition,
      bytes: await storage.get(attachment.storage_key)
    });
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    from: row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email,
    recipients: recipients.rows,
    reply_to: row.reply_to ?? [],
    subject: row.subject,
    html: row.html_tracked ?? row.html,
    text: row.text,
    headers: row.headers ?? {},
    attachments: files,
    region: row.region ?? "us-east-1",
    tls: row.tls ?? "opportunistic",
    provider_message_id: row.provider_message_id ?? null
  };
}

export async function deliverJob(
  db: Db,
  storage: Storage,
  provider: Provider,
  job: Job,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
) {
  const message = await loadProviderEmail(db, storage, job);
  if (!message) {
    await db.query("update send_jobs set state = $2, updated_at = now() where id = $1", [job.id, "done"]);
    return;
  }
  const { provider_message_id: sentAs, ...email } = message;
  // A stored provider id means an earlier attempt reached the provider and then failed while
  // recording it. Sending again would deliver the email twice, so only the record is completed.
  const result = sentAs
    ? {
        provider_message_id: sentAs,
        message_id: undefined,
        events: [{
          type: "email.sent" as const,
          provider_event_id: `${sentAs}:sent`,
          delay_ms: 0,
          recipients: email.recipients.map((recipient) => recipient.email),
          data: { provider_message_id: sentAs }
        }]
      }
    : await sendOnce(provider, email, options);
  for (const [index, event] of result.events.entries()) {
    if (event.delay_ms > 0) await (options.sleep ?? sleep)(event.delay_ms);
    // The provider id, the event, and its webhook attempts commit together. A crash between
    // them would leave an event that no retry can deliver, because the event is deduplicated.
    await tx(db, async (client) => {
      if (index === 0 && !sentAs) {
        await client.query(
          "update emails set provider_message_id = $3, message_id = $4, updated_at = now() where tenant_id = $1 and id = $2",
          [job.tenant_id, job.email_id, result.provider_message_id, result.message_id ?? null]
        );
      }
      const row = await appendEvent(client, {
        tenantId: job.tenant_id,
        requestId: job.request_id,
        emailId: job.email_id,
        type: event.type,
        providerEventId: event.provider_event_id,
        data: event.data,
        mode: "delivery",
        recipients: event.recipients,
        provider: provider.name
      });
      if (row) await fanoutEvent(client, row);
    });
  }
  await db.query("update send_jobs set state = $2, updated_at = now() where id = $1", [job.id, "done"]);
}

async function sendOnce(
  provider: Provider,
  email: ProviderEmail,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number }
) {
  const quota = await provider.quota(email.region);
  await pace(email.region, quota.max_per_second, { now: options.now?.(), sleep: options.sleep });
  return provider.send(email);
}

export async function handleSendFailure(db: Db, job: Job, error: unknown) {
  const reason = error instanceof ProviderError ? error.reason : String(error);
  const permanent = error instanceof ProviderError && !error.retryable;
  const attempts = await db.query<{ attempts: number }>("select attempts from send_jobs where id = $1", [job.id]);
  const next = attempts.rows[0]?.attempts ?? 1;
  if (permanent || next >= 5) {
    await tx(db, async (client) => {
      await client.query("update send_jobs set state = 'failed', error = $2, updated_at = now() where id = $1", [job.id, reason]);
      const row = await appendEvent(client, {
        tenantId: job.tenant_id,
        requestId: job.request_id,
        emailId: job.email_id,
        type: "email.failed",
        providerEventId: `${job.id}:failed:${next}`,
        data: { failed: { reason } },
        mode: "delivery"
      });
      if (row) await fanoutEvent(client, row);
    });
    return;
  }
  await db.query(
    `update send_jobs set state = 'ready', available_at = now() + make_interval(secs => $2), error = $3, updated_at = now()
     where id = $1`,
    [job.id, backoffSecs(next, 30), reason]
  );
}
