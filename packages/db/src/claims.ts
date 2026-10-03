import { tx, type Db } from "./index.js";

export type ClaimCursor = { normal: string; bulk: string };
export type AutomationRunRef = { id: string; tenant_id: string; automation_id: string; priority: "normal" | "bulk"; wait_event: string | null };

const eligible = `(r.state = 'ready'
  or (r.state = 'waiting' and r.resume_at is not null and r.resume_at <= now())
  or (r.state = 'running' and r.updated_at < now() - interval '5 minutes'))`;

export async function claimAutomationRuns(db: Db, limit: number, cursor: ClaimCursor = { normal: "", bulk: "" }) {
  const runs = await tx(db, async (client) => {
    const selected: AutomationRunRef[] = [];
    const taken = new Map<string, number>();
    for (const priority of ["normal", "bulk"] as const) {
      if (selected.length >= limit) break;
      const automations = await client.query<{ id: string; tenant_id: string }>(
        `select a.id, a.tenant_id from automations a
         where a.enabled and a.deleted_at is null and a.paused_at is null
           and exists (select 1 from automation_runs r where r.tenant_id = a.tenant_id and r.automation_id = a.id
             and r.priority = $1 and ${eligible})
         order by (a.id <= $2), a.id`, [priority, cursor[priority]],
      );
      // Two rounds, one run per automation in each round. Skip locked rows before applying
      // the per-automation limit, so another worker's claim cannot hide available work.
      for (let round = 0; round < 2 && selected.length < limit; round += 1) {
        for (const automation of automations.rows) {
          if (selected.length >= limit) break;
          if ((taken.get(automation.id) ?? 0) >= 2) continue;
          const row = await client.query<AutomationRunRef>(
            `select r.id, r.tenant_id, r.automation_id, r.priority, r.wait_event from automation_runs r
             join automations a on a.tenant_id = r.tenant_id and a.id = r.automation_id
             where r.tenant_id = $1 and r.automation_id = $2 and r.priority = $3 and ${eligible}
               and a.enabled and a.deleted_at is null and a.paused_at is null
               and not (r.id = any($4::text[]))
             order by coalesce(r.resume_at, r.created_at), r.id limit 1 for update of r skip locked`,
            [automation.tenant_id, automation.id, priority, selected.map((run) => run.id)],
          );
          if (row.rows[0]) {
            selected.push(row.rows[0]);
            taken.set(automation.id, (taken.get(automation.id) ?? 0) + 1);
          }
        }
      }
    }
    if (!selected.length) return [];
    await client.query(
      `update automation_runs set
         resume_data = case when state = 'waiting' then jsonb_build_object('timed_out', wait_event is not null) else resume_data end,
         state = 'running', resume_at = null, wait_event = null, updated_at = now()
       where id = any($1::text[])`, [selected.map((row) => row.id)],
    );
    return selected;
  });
  for (const priority of ["normal", "bulk"] as const) {
    const last = runs.filter((run) => run.priority === priority).at(-1);
    if (last) cursor[priority] = last.automation_id;
  }
  return runs;
}
