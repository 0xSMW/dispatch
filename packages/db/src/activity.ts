import { paginate, type PagingParams, type Queryable } from "./index.js";

export type ActivityRow = {
  id: string;
  type: string;
  resource_id: string | null;
  label: string | null;
  email_id: string | null;
  created_at: string | Date;
  automation_id?: string | null;
  run_id?: string | null;
  exit_reason?: "completed" | "exit" | "filter" | "stopped" | "stranded" | null;
};

// $1 tenant, $2 contact id, $3 contact email. paginate() adds the tenant filter and the cursor outside.
export const contactActivitySource = `(
  select c.id, c.tenant_id, 'contact.created' as type, c.id as resource_id, c.email as label, null::text as email_id, c.created_at,
    null::text as automation_id, null::text as run_id, null::text as exit_reason
  from contacts c
  where c.tenant_id = $1 and c.id = $2
  union all
  select sc.id, sc.tenant_id, 'segment.added', s.id, s.name, null::text, sc.created_at, null::text, null::text, null::text
  from segment_contacts sc
  join segments s on s.tenant_id = sc.tenant_id and s.id = sc.segment_id
  where sc.tenant_id = $1 and sc.contact_id = $2
  union all
  select ts.id, ts.tenant_id,
    case when ts.status = 'unsubscribed' then 'topic.opted_out' else 'topic.opted_in' end,
    t.id, t.name, null::text, ts.updated_at, null::text, null::text, null::text
  from topic_subscriptions ts
  join topics t on t.tenant_id = ts.tenant_id and t.id = ts.topic_id
  where ts.tenant_id = $1 and ts.contact_id = $2
  union all
  select ev.id, ev.tenant_id, ev.type, ev.email_id, e.subject, ev.email_id, ev.created_at, null::text, null::text, null::text
  from email_events ev
  join emails e on e.tenant_id = ev.tenant_id and e.id = ev.email_id
  where ev.tenant_id = $1 and exists (
    select 1 from email_recipients r
    where r.tenant_id = ev.tenant_id and r.email_id = ev.email_id and lower(r.email) = lower($3)
      and (ev.recipient_id is null or ev.recipient_id = r.id)
  )
  union all
  select e.id, e.tenant_id, 'event.fired', e.id, e.name, null::text, e.created_at, null::text, null::text, null::text
  from custom_events e
  where e.tenant_id = $1 and lower(e.email) = lower($3) and e.name not like '@%'
  union all
  select r.id || ':started', r.tenant_id, 'automation.run.started', r.id, a.name, null::text, r.created_at, r.automation_id, r.id, null::text
  from automation_runs r
  join custom_events e on e.tenant_id = r.tenant_id and e.id = r.event_id
  join automations a on a.tenant_id = r.tenant_id and a.id = r.automation_id
  where r.tenant_id = $1 and lower(e.email) = lower($3)
  union all
  select r.id || ':completed', r.tenant_id, 'automation.run.completed', r.id, r.state, null::text, r.updated_at, r.automation_id, r.id, r.exit_reason
  from automation_runs r
  join custom_events e on e.tenant_id = r.tenant_id and e.id = r.event_id
  where r.tenant_id = $1 and lower(e.email) = lower($3) and r.state in ('done', 'failed', 'stopped')
) activity`;

export async function contactActivity(
  db: Queryable,
  tenantId: string,
  contact: { id: string; email: string },
  paging: PagingParams = {},
) {
  return paginate<ActivityRow>(db, contactActivitySource, tenantId, paging, {
    params: [contact.id, contact.email],
    select: "id, type, resource_id, label, email_id, created_at, automation_id, run_id, exit_reason",
  });
}

export function presentActivity(row: ActivityRow) {
  return {
    object: "contact_activity" as const,
    id: row.id,
    type: row.type,
    resource_id: row.resource_id ?? null,
    label: row.label ?? null,
    email_id: row.email_id ?? null,
    created_at: row.created_at,
    automation_id: row.automation_id ?? null,
    run_id: row.run_id ?? null,
    exit_reason: row.type === "automation.run.completed" ? row.exit_reason ?? null : null,
  };
}

export async function contactStats(db: Queryable, tenantId: string) {
  const row = await db.query<{ all: number; subscribed: number; unsubscribed: number }>(
    `select count(*)::integer as "all",
       count(*) filter (where unsubscribed_at is null)::integer as subscribed,
       count(*) filter (where unsubscribed_at is not null)::integer as unsubscribed
     from contacts
     where tenant_id = $1 and deleted_at is null`,
    [tenantId],
  );
  const counts = row.rows[0] ?? { all: 0, subscribed: 0, unsubscribed: 0 };
  return {
    object: "contact_stats" as const,
    all: counts.all,
    subscribed: counts.subscribed,
    unsubscribed: counts.unsubscribed,
  };
}
