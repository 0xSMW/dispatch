import { emit } from "./events.js";
import type { Queryable } from "./index.js";

export type RunEventType =
  | "automation.run.started"
  | "automation.run.completed"
  | "automation.run.failed";

/** Called on the state change's transaction. A retry cannot fan out the same transition twice. */
export async function emitRunEvent(
  db: Queryable,
  tenantId: string,
  runId: string,
  type: RunEventType,
) {
  const result = await db.query<{
    id: string;
    automation_id: string;
    request_id: string;
    contact_id: string | null;
    state: string;
  }>(
    `select r.id, r.automation_id, coalesce(e.request_id, r.id) as request_id, c.id as contact_id, r.state
     from automation_runs r
     join custom_events e on e.tenant_id = r.tenant_id and e.id = r.event_id
     left join contacts c on c.tenant_id = r.tenant_id and lower(c.email) = lower(e.email)
     where r.tenant_id = $1 and r.id = $2`,
    [tenantId, runId],
  );
  const run = result.rows[0];
  if (!run) return;
  await emit(db, {
    tenantId,
    requestId: run.request_id,
    resourceId: runId,
    type,
    key: `${runId}:${type}`,
    data: {
      automation_id: run.automation_id,
      run_id: runId,
      contact_id: run.contact_id ?? null,
      state: run.state,
    },
  });
}
