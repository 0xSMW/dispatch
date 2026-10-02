import { paginate, type PagingParams, type Queryable } from "./index.js";

export type ActivityRow = {
  id: string;
  type: string;
  resource_id: string | null;
  label: string | null;
  email_id: string | null;
  created_at: string | Date;
};

// $1 tenant, $2 contact id, $3 contact email. paginate() adds the tenant filter and the cursor outside.
export const contactActivitySource = `(
  select c.id, c.tenant_id, 'contact.created' as type, c.id as resource_id, c.email as label, null::text as email_id, c.created_at
  from contacts c
  where c.tenant_id = $1 and c.id = $2
  union all
  select sc.id, sc.tenant_id, 'segment.added', s.id, s.name, null::text, sc.created_at
  from segment_contacts sc
  join segments s on s.tenant_id = sc.tenant_id and s.id = sc.segment_id
  where sc.tenant_id = $1 and sc.contact_id = $2
  union all
  select ts.id, ts.tenant_id,
    case when ts.status = 'unsubscribed' then 'topic.opted_out' else 'topic.opted_in' end,
    t.id, t.name, null::text, ts.updated_at
  from topic_subscriptions ts
  join topics t on t.tenant_id = ts.tenant_id and t.id = ts.topic_id
  where ts.tenant_id = $1 and ts.contact_id = $2
  union all
  select ev.id, ev.tenant_id, ev.type, ev.email_id, e.subject, ev.email_id, ev.created_at
  from email_events ev
  join email_recipients r on r.tenant_id = ev.tenant_id and r.email_id = ev.email_id and r.email = $3
  join emails e on e.tenant_id = ev.tenant_id and e.id = ev.email_id
  where ev.tenant_id = $1 and (ev.recipient_id is null or ev.recipient_id = r.id)
) activity`;

export async function contactActivity(
  db: Queryable,
  tenantId: string,
  contact: { id: string; email: string },
  paging: PagingParams = {},
) {
  return paginate<ActivityRow>(db, contactActivitySource, tenantId, paging, {
    params: [contact.id, contact.email],
    select: "id, type, resource_id, label, email_id, created_at",
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
