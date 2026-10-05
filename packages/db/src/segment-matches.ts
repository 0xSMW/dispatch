import type { Queryable } from "./index.js";
import { segmentFilter, type Bind } from "./segments.js";

/** A matcher over aliases segments s and contacts c, never contact rows in Node. */
export async function segmentMatch(db: Queryable, tenantId: string, bind: Bind): Promise<string> {
  const segments = await db.query<{ id: string }>("select id from segments where tenant_id = $1 and deleted_at is null and rule is not null order by id", [tenantId]);
  const dynamic: string[] = [];
  for (const segment of segments.rows) {
    const predicate = await segmentFilter(db, tenantId, segment.id, bind);
    dynamic.push(`(s.rule is not null and s.id = ${bind(segment.id)}::text and (${predicate}))`);
  }
  return `(s.tenant_id = c.tenant_id and s.deleted_at is null and (
    (s.rule is null and exists (
      select 1 from segment_contacts sc where sc.tenant_id = c.tenant_id and sc.segment_id = s.id and sc.contact_id = c.id
    )) ${dynamic.length ? `or ${dynamic.join(" or ")}` : ""}
  ))`;
}

export async function contactSegments(db: Queryable, tenantId: string, contactId: string): Promise<string[]> {
  const params: unknown[] = [tenantId, contactId];
  const match = await segmentMatch(db, tenantId, (value) => { params.push(value); return `$${params.length}`; });
  const rows = await db.query<{ id: string }>(
    `select s.id from segments s join contacts c on c.tenant_id = s.tenant_id
     where s.tenant_id = $1 and c.id = $2 and c.deleted_at is null and ${match} order by s.id`, params,
  );
  return rows.rows.map((row) => row.id);
}
