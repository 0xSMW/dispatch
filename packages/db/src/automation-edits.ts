import { ApiError, type Step } from "@dispatchmail/core";
import { activeStates, automationGraph, type AutomationRow } from "./automations.js";
import { emitRunEvent } from "./run-events.js";
import type { Queryable } from "./index.js";

export const strandedError = "Its next step was removed or changed while the automation was paused";
export type DryRun = { stranded_runs: number; by_step: Record<string, number> };
type Position = { id: string; next_step_key: string | null; next_step_index: number };
type Waiting = { id: string; run_id: string; step_key: string | null; step_index: number };

export function usedKeys(steps: Step[], history: Record<string, string> = {}) {
  const keys = { ...history };
  for (const step of steps) {
    if (Object.hasOwn(keys, step.key) && keys[step.key] !== step.type) {
      throw new ApiError("conflict", 409, `Step key ${step.key} was already used for ${keys[step.key]}. Use a new key for ${step.type}.`);
    }
    Object.defineProperty(keys, step.key, { value: step.type, enumerable: true, configurable: true, writable: true });
  }
  return keys;
}

export function strandedRuns(positions: Array<{ id: string; key: string }>, before: Step[], after: Step[]) {
  const oldTypes = new Map(before.map((step) => [step.key, step.type]));
  const newTypes = new Map(after.map((step) => [step.key, step.type]));
  const ids: string[] = [];
  const by_step: Record<string, number> = {};
  for (const run of positions) {
    if (oldTypes.has(run.key) && oldTypes.get(run.key) === newTypes.get(run.key)) continue;
    ids.push(run.id);
    Object.defineProperty(by_step, run.key, {
      value: (Object.hasOwn(by_step, run.key) ? by_step[run.key]! : 0) + 1,
      enumerable: true, configurable: true, writable: true,
    });
  }
  return { ids, preview: { stranded_runs: ids.length, by_step } };
}

/** The caller holds the automation lock. Dry runs take the same run locks but write nothing. */
export async function editRuns(client: Queryable, tenantId: string, current: AutomationRow, after: Step[], dryRun: boolean) {
  const before = automationGraph(current);
  const runs = await client.query<Position>(
    `select id, next_step_key, next_step_index from automation_runs
     where tenant_id = $1 and automation_id = $2 and state = any($3)
     order by id for update`,
    [tenantId, current.id, activeStates],
  );
  const waiting = await client.query<Waiting>(
    `select s.id, s.run_id, s.step_key, s.step_index from automation_steps s
     join automation_runs r on r.tenant_id = s.tenant_id and r.id = s.run_id
     where s.tenant_id = $1 and r.automation_id = $2 and r.state = any($3) and s.state = 'waiting'
     order by s.created_at, s.id`,
    [tenantId, current.id, activeStates],
  );
  const waitsByRun = new Map(waiting.rows.map((step) => [step.run_id, step]));
  const legacy = !current.steps.length || !current.steps.every((step) => "key" in step);
  const positions = runs.rows.map((run) => {
    const wait = waitsByRun.get(run.id);
    // Old runs point one past a wait. Their indices refer to the pre-trigger linear list.
    const key = run.next_step_key ?? (legacy
      ? before.steps[wait && wait.step_index === run.next_step_index - 1 ? run.next_step_index : run.next_step_index + 1]?.key
      : before.connections.find((edge) => edge.from === before.steps.find((step) => step.type === "trigger")?.key && edge.type === "default")?.to
    ) ?? null;
    return { id: run.id, key };
  });
  const result = strandedRuns(positions.filter((run): run is { id: string; key: string } => run.key !== null), before.steps, after);
  if (dryRun) return result.preview;

  // Snapshot legacy waits before changing the graph. Existing timers, event decisions and
  // stored wait rules are not recalculated from the new configuration.
  for (const wait of waiting.rows) {
    const key = wait.step_key ?? before.steps[wait.step_index + 1]?.key;
    const config = before.steps.find((step) => step.key === key)?.config ?? {};
    await client.query(
      `update automation_steps set step_key = coalesce(step_key, $3),
         data = case when data ? 'wait_config' then data else coalesce(data, '{}'::jsonb) || jsonb_build_object('wait_config', $4::jsonb) end
       where tenant_id = $1 and id = $2`,
      [tenantId, wait.id, key ?? null, JSON.stringify(config)],
    );
  }
  if (positions.length) {
    await client.query(
      `update automation_runs r set next_step_key = p.key,
         state = case when p.key is null then 'done' else r.state end,
         exit_reason = case when p.key is null then 'completed' else r.exit_reason end
       from jsonb_to_recordset($2::jsonb) as p(id text, key text)
       where r.tenant_id = $1 and r.id = p.id`,
      [tenantId, JSON.stringify(positions)],
    );
  }
  for (const run of positions) if (run.key === null) await emitRunEvent(client, tenantId, run.id, "automation.run.completed");
  if (result.ids.length) {
    await client.query(
      `update automation_runs set state = 'stopped', exit_reason = 'stranded', error = $3, resume_at = null, wait_event = null,
         resume_data = null, updated_at = now()
       where tenant_id = $1 and id = any($2::text[])`,
      [tenantId, result.ids, strandedError],
    );
    await client.query(
      `update automation_steps set state = 'failed', error = 'cancelled', completed_at = now()
       where tenant_id = $1 and run_id = any($2::text[]) and state = 'waiting'`,
      [tenantId, result.ids],
    );
    for (const runId of result.ids) await emitRunEvent(client, tenantId, runId, "automation.run.completed");
  }
  return result.preview;
}
