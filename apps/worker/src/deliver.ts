import { setTimeout as sleep } from "node:timers/promises";
import { backoffSecs, ProviderError, sandboxAddress, type Provider, type ProviderEmail } from "@dispatchmail/core";
import { appendEvent, fanoutEvent, reconcileBroadcastSent, tx, type Db, type Queryable } from "@dispatchmail/db";
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
  topic_id: string | null;
  provider_message_id: string | null;
  region: string | null;
  tls: "opportunistic" | "enforced" | null;
  sandbox: boolean;
  settings: { sandbox_domains?: string[] } | null;
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

// Unlike the local process map, this reservation survives cold starts and is shared by all
// serverless invocations. The statement commits before the short pacing delay starts.
export async function paceDurably(db: Queryable, region: string, maxPerSecond: number, wait: (ms: number) => Promise<void> = sleep) {
  if (maxPerSecond <= 0) return;
  const result = await db.query<{ delay_ms: number }>(
    `insert into send_slots (region, available_at)
     values ($1, clock_timestamp() + ($2::double precision * interval '1 millisecond'))
     on conflict (region) do update set available_at = greatest(send_slots.available_at, clock_timestamp())
       + ($2::double precision * interval '1 millisecond')
     returning greatest(0, extract(epoch from (available_at - clock_timestamp())) * 1000 - $2) as delay_ms`,
    [region, 1000 / maxPerSecond],
  );
  const delay = Number(result.rows[0]?.delay_ms ?? 0);
  if (delay > 0) await wait(delay);
}

export async function loadProviderEmail(
  db: Queryable,
  storage: Storage,
  job: Job
): Promise<(ProviderEmail & { provider_message_id: string | null; sandbox_recipients: string[] }) | null> {
  const email = await db.query<StoredEmail>(
    `select e.id, e.tenant_id, e.from_email, e.from_name, e.reply_to, e.subject, e.html, e.html_tracked, e.text, e.headers, e.status,
            e.broadcast_id, e.topic_id, e.provider_message_id, e.sandbox, t.settings, d.region, d.tls
     from emails e
     join tenants t on t.id = e.tenant_id
     left join domains d on d.tenant_id = e.tenant_id and lower(d.name) = lower(split_part(e.from_email, '@', 2)) and d.deleted_at is null
     where e.id = $1 and e.tenant_id = $2`,
    [job.email_id, job.tenant_id]
  );
  const row = email.rows[0];
  if (!row || row.status === "cancelled") return null;
  // Match the broadcast chunk/cancel lock order before changing its email attribution.
  if (row.broadcast_id) await db.query(
    "select id from broadcasts where tenant_id = $1 and id = $2 for update",
    [job.tenant_id, row.broadcast_id],
  );
  // Checked again at the moment of sending. An email can wait in the queue, or be scheduled
  // days ahead, and in that time the address may have bounced or the person unsubscribed.
  // Suppression applies to every email. Marketing mail also rechecks current opt-outs.
  if (row.topic_id || row.broadcast_id) {
    const dropped = await db.query<{ id: string; email: string }>(
      `update email_recipients r set status = 'failed', updated_at = now()
       where r.tenant_id = $2 and r.email_id = $1 and r.status not in ('suppressed', 'failed')
         and exists (
           select 1 from contacts c
           left join topics t on t.tenant_id = c.tenant_id and t.id = $3 and t.deleted_at is null
           left join topic_subscriptions s on s.tenant_id = c.tenant_id and s.contact_id = c.id and s.topic_id = t.id
           where c.tenant_id = $2 and lower(c.email) = lower(r.email)
             and (c.unsubscribed_at is not null or c.deleted_at is not null
               or ($3::text is not null and coalesce(s.status, t.default_status, 'unsubscribed') <> 'subscribed'))
         ) returning r.id, r.email`,
      [job.email_id, job.tenant_id, row.topic_id ?? null],
    );
    for (const recipient of dropped.rows) {
      const event = await appendEvent(db, {
        tenantId: job.tenant_id, requestId: job.request_id, emailId: job.email_id,
        recipientId: recipient.id, type: "email.failed",
        providerEventId: `${job.email_id}:opted_out:${recipient.id}`,
        data: { email: recipient.email, failed: { reason: "opted_out" } },
      });
      if (event) await fanoutEvent(db, event);
    }
    if (dropped.rows.length) await db.query("update send_jobs set error = 'opted_out' where id = $1", [job.id]);
  }
  const recipients = await db.query<{ email: string; kind: "to" | "cc" | "bcc"; sandbox: boolean }>(
    `select r.email, r.kind, r.sandbox from email_recipients r
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
    [job.email_id, job.tenant_id, Boolean(row.broadcast_id || row.topic_id)]
  );
  if (recipients.rows.length === 0) {
    await db.query(
      "update emails set status = 'cancelled', updated_at = now() where tenant_id = $1 and id = $2 and status in ('queued', 'scheduled')",
      [job.tenant_id, job.email_id]
    );
    return null;
  }
  // Stored attribution survives setting removal. Rechecking also protects queued legacy mail
  // and domains added before the provider accepts a send. Once a provider ID is stored,
  // keep real attribution: reconciliation is not a new send or simulated delivery.
  const sandboxRecipients = recipients.rows.filter((recipient) =>
    row.sandbox || recipient.sandbox || (!row.provider_message_id && sandboxAddress(recipient.email, row.settings?.sandbox_domains)));
  if (sandboxRecipients.length) {
    // Legacy events did not store a real boolean. Freeze their existing attribution
    // before changing routing, including recipient-specific mixed-send history.
    await db.query(
      `update email_events ev set data = jsonb_set(ev.data, '{sandbox}', to_jsonb(
         e.sandbox or exists (select 1 from email_recipients r
           where r.tenant_id = ev.tenant_id and r.id = ev.recipient_id and r.sandbox)
       ))
       from emails e where ev.tenant_id = $1 and ev.email_id = $2
         and e.tenant_id = ev.tenant_id and e.id = ev.email_id
         and coalesce(ev.data->>'sandbox', '') not in ('true', 'false')`,
      [job.tenant_id, job.email_id],
    );
    await db.query(
      `update email_recipients set sandbox = true where tenant_id = $1 and email_id = $2
       and lower(email) = any($3::text[]) and not sandbox`,
      [job.tenant_id, job.email_id, sandboxRecipients.map((recipient) => recipient.email.toLowerCase())],
    );
    await db.query(
      `update emails e set sandbox = true where tenant_id = $1 and id = $2 and not sandbox
       and not exists (select 1 from email_recipients r where r.tenant_id = e.tenant_id and r.email_id = e.id and not r.sandbox)`,
      [job.tenant_id, job.email_id],
    );
    if (row.broadcast_id) await reconcileBroadcastSent(db, job.tenant_id, row.broadcast_id);
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
    recipients: recipients.rows.filter((recipient) => !sandboxRecipients.includes(recipient))
      .map(({ email, kind }) => ({ email, kind })),
    sandbox_recipients: sandboxRecipients.map((recipient) => recipient.email),
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
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number; durable?: boolean } = {}
) {
  const message = await tx(db, (client) => loadProviderEmail(client, storage, job));
  if (!message) {
    await db.query("update send_jobs set state = $2, updated_at = now() where id = $1", [job.id, "done"]);
    return;
  }
  const { provider_message_id: sentAs, sandbox_recipients: sandboxRecipients, ...email } = message;
  if (sandboxRecipients.length) {
    await tx(db, async (client) => {
      const event = await appendEvent(client, {
        tenantId: job.tenant_id, requestId: job.request_id, emailId: job.email_id,
        type: "email.delivered", providerEventId: `${job.email_id}:sandbox:delivered`,
        data: { sandbox: true, recipients: sandboxRecipients },
        mode: "delivery", recipients: sandboxRecipients, provider: "sandbox",
      });
      if (event) await fanoutEvent(client, event);
    });
  }
  if (!email.recipients.length) {
    // A mixed email may have no eligible real recipients left. Its simulation must not leave
    // it queued forever, or claim real delivery for recipients suppressed before the send.
    await db.query(
      `update emails e set status = case
         when exists (select 1 from email_recipients r where r.tenant_id = e.tenant_id and r.email_id = e.id and not r.sandbox and r.status = 'failed') then 'failed'
         when exists (select 1 from email_recipients r where r.tenant_id = e.tenant_id and r.email_id = e.id and not r.sandbox and r.status = 'suppressed') then 'suppressed'
         else 'cancelled' end, updated_at = now()
       where e.tenant_id = $1 and e.id = $2 and not e.sandbox and e.status in ('queued', 'scheduled')`,
      [job.tenant_id, job.email_id],
    );
    await db.query("update send_jobs set state = $2, updated_at = now() where id = $1", [job.id, "done"]);
    return;
  }
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
    : await sendOnce(db, provider, email, job, options);
  if (options.durable && !sentAs) {
    // Persist acceptance before doing event fanout. An interrupted fanout can safely complete
    // using this id, without asking SES to send again.
    await db.query(
      "update emails set provider_message_id = $3, message_id = $4, updated_at = now() where tenant_id = $1 and id = $2",
      [job.tenant_id, job.email_id, result.provider_message_id, result.message_id ?? null],
    );
  }
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
  db: Db,
  provider: Provider,
  email: ProviderEmail,
  job: Job,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number; durable?: boolean }
) {
  const quota = await provider.quota(email.region);
  if (options.durable) {
    await paceDurably(db, email.region, quota.max_per_second, options.sleep);
    // The claim is safe to reclaim until this point. Once a request may reach SES, a crash
    // must require reconciliation rather than another provider call.
    await db.query("update send_jobs set state = 'sending', locked_at = now(), updated_at = now() where id = $1", [job.id]);
  } else {
    await pace(email.region, quota.max_per_second, { now: options.now?.(), sleep: options.sleep });
  }
  return provider.send(email);
}

export async function handleSendFailure(db: Db, job: Job, error: unknown, options: { durable?: boolean } = {}) {
  const reason = error instanceof ProviderError ? error.reason : String(error);
  const permanent = error instanceof ProviderError && !error.retryable;
  if (options.durable) {
    const current = await db.query<{ state: string; provider_message_id: string | null }>(
      "select j.state, e.provider_message_id from send_jobs j join emails e on e.id = j.email_id where j.id = $1", [job.id],
    );
    if (current.rows[0]?.state === "sending" || current.rows[0]?.state === "uncertain") {
      if (current.rows[0].provider_message_id) {
        await db.query("update send_jobs set state = 'ready', available_at = now(), error = $2, updated_at = now() where id = $1", [job.id, reason]);
        return;
      }
      if (!(error instanceof ProviderError && error.rejected)) {
        await db.query("update send_jobs set state = 'uncertain', error = $2, updated_at = now() where id = $1", [job.id, `SES acceptance is uncertain: ${reason}`]);
        return;
      }
    }
  }
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
