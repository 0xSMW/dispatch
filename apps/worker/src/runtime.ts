import { randomUUID } from "node:crypto";
import { connect, type Db, type Queryable } from "@dispatchmail/db";
import { nodeResolvers, readIdentity, sesClient } from "@dispatchmail/provider-ses";
import { verifyDueDomains } from "./domains.js";

let pool: Db | undefined;
const database = () => pool ??= connect();

export type TickResult = { nextAt: string | null; processed: number };

// The database schedules work; Workflow only stores a timestamp and identifiers. In particular,
// message bodies, attachment bytes and contact rows never become workflow arguments/results.
export async function nextWorkAt(db: Queryable): Promise<string | null> {
  const result = await db.query<{ next_at: Date | string | null }>(
    `select min(due_at) as next_at from (
       select case when j.state = 'ready' then j.available_at
         else j.locked_at + interval '5 minutes' end as due_at
       from send_jobs j join emails e on e.id = j.email_id
       left join broadcasts b on b.id = e.broadcast_id
       where j.state in ('ready', 'running', 'sending') and (b.id is null or b.status <> 'paused')
       union all
       select case when a.state = 'queued' then a.available_at else a.updated_at + interval '1 minute' end
       from webhook_attempts a join webhooks w on w.id = a.webhook_id and w.tenant_id = a.tenant_id
       where a.state in ('queued', 'running')
       union all
       select case when state = 'ready' then now() when state = 'waiting' then resume_at
         else updated_at + interval '5 minutes' end
       from automation_runs where state in ('ready', 'running') or (state = 'waiting' and resume_at is not null)
       union all
       select case when status = 'queued' then now() else locked_at + interval '10 minutes' end
       from contact_imports where status in ('queued', 'in_progress')
       union all
       select now() from automation_enrollment_jobs where status in ('queued', 'in_progress')
       union all
       select case when b.status = 'scheduled' then b.scheduled_at else now() end
       from broadcasts b where b.deleted_at is null and b.status in ('scheduled', 'sending')
         and (select count(*) from (
           select 1 from emails e join send_jobs j on j.email_id = e.id and j.state in ('ready', 'running', 'sending')
           where e.tenant_id = b.tenant_id and e.broadcast_id = b.id limit 400
         ) backlog) < 400
     ) pending`,
  );
  const value = result.rows[0]?.next_at;
  return value ? new Date(value).toISOString() : null;
}

export async function recoverInterruptedSends(db: Queryable) {
  // A request that died after the provider boundary cannot be automatically sent again.
  // SES callbacks (or an operator) can reconcile it. A saved provider id is safe to finish.
  await db.query(
    `update send_jobs j set state = case when e.provider_message_id is null then 'uncertain' else 'ready' end,
       available_at = now(), error = case when e.provider_message_id is null then 'SES acceptance is uncertain after an interrupted send' else j.error end,
       updated_at = now()
     from emails e where e.id = j.email_id and j.state = 'sending' and j.locked_at < now() - interval '5 minutes'`,
  );
}

// A lease works with Neon/PgBouncer transaction pooling, unlike session advisory locks.
// Its insert/update commits immediately, and no transaction spans network calls or timers.
export async function acquireLease(db: Queryable, owner: string) {
  const result = await db.query(
    `insert into worker_leases (name, owner, expires_at) values ('dispatch', $1, now() + interval '10 minutes')
     on conflict (name) do update set owner = excluded.owner, expires_at = excluded.expires_at
     where worker_leases.expires_at <= now() returning owner`,
    [owner],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function runTick(): Promise<TickResult> {
  const db = database();
  const owner = randomUUID();
  if (!await acquireLease(db, owner)) {
    // Recheck after contention: an API write may have arrived after the owner's last due query.
    return { nextAt: new Date(Date.now() + 5_000).toISOString(), processed: 0 };
  }
  try {
    await recoverInterruptedSends(db);
    const { tick } = await import("./worker.js");
    const result = await tick({ durable: true });
    if (process.env.SES_PROVIDER === "ses") {
      const due = await db.query(
        `select 1 from domains where deleted_at is null and status in ('pending', 'temporary_failure')
         and (checked_at is null or checked_at <= now() - interval '15 minutes') limit 1`,
      );
      if (due.rows.length) await verifyDueDomains(db, {
        read: (name, region) => readIdentity(sesClient(region), name),
        resolvers: nodeResolvers,
        limit: 2,
        onError: (domain, error) => console.error(`domain check failed for ${domain.name}`, error),
      }, { last: 0 });
    }
    const processed = Object.values(result).reduce((total, count) => total + count, 0);
    const nextAt = await nextWorkAt(db);
    // Avoid a tight durable loop if a resource repeatedly fails before making progress.
    return { nextAt: nextAt && processed === 0
      ? new Date(Math.max(Date.parse(nextAt), Date.now() + 30_000)).toISOString() : nextAt, processed };
  } finally {
    await db.query("delete from worker_leases where name = 'dispatch' and owner = $1", [owner]);
  }
}
