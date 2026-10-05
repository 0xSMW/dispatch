import { createHash } from "node:crypto";
import { ApiError, splitSchema, type SplitMetricsInput, type SplitReport, type SplitVariant } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { countMetrics, withRates, type CountMetric } from "./metrics.js";
import { realEmailEvent } from "./sandbox.js";

/** Hash only the UTF-8 run ID; ordered weights partition the 100 buckets. */
export function assignVariant(runId: string, variants: readonly SplitVariant[]): string {
  const config = splitSchema.parse({ variants });
  const bucket = createHash("sha256").update(runId, "utf8").digest().readUInt32BE(0) % 100;
  let boundary = 0;
  for (const variant of config.variants) {
    boundary += variant.weight;
    if (bucket < boundary) return variant.key;
  }
  // Validation guarantees a total of 100 and the bucket is always below 100.
  throw new Error("Split weights do not cover the assignment bucket");
}

/**
 * Runs use assignment dates; email counts use event dates, both in [start, end).
 * Older assignments still attribute events in the window. Current weights never
 * recompute a stored decision; historical keys remain visible with weight null.
 */
export async function splitMetrics(
  db: Queryable,
  tenantId: string,
  input: SplitMetricsInput,
  variants: readonly SplitVariant[],
): Promise<SplitReport> {
  const config = splitSchema.parse({ variants });
  if (!tenantId.trim() || !input.automationId.trim() || !input.stepKey.trim()) {
    throw new ApiError("validation_error", 422, "tenant, automation_id and step_key are required");
  }
  if (!(input.start instanceof Date) || !(input.end instanceof Date)
    || !Number.isFinite(input.start.getTime()) || !Number.isFinite(input.end.getTime())
    || input.start >= input.end) {
    throw new ApiError("validation_error", 422, "start_date must be a valid date before end_date");
  }
  const result = await db.query(`
    with assignments as (
      -- One recorded decision per run/step, even if historical retries duplicated rows.
      select distinct on (s.run_id)
        s.run_id, s.data->>'variant' as key, s.created_at
      from automation_steps s
      join automation_runs r on r.tenant_id = s.tenant_id and r.id = s.run_id
      join automations a on a.tenant_id = r.tenant_id and a.id = r.automation_id
      where s.tenant_id = $1 and r.automation_id = $2 and s.step_key = $3
        and s.type = 'split' and s.state = 'done'
        and jsonb_typeof(s.data->'variant') = 'string' and s.data->>'variant' <> ''
      order by s.run_id, s.created_at, s.id
    ), run_counts as (
      select key, count(*) as runs from assignments
      where created_at >= $4 and created_at < $5
      group by key
    ), event_counts as (
      -- Aggregate each email before joining its stored assignment: no event/run fanout.
      select ev.email_id,
        count(*) filter (where ev.type = 'email.sent') as sent,
        count(*) filter (where ev.type = 'email.delivered') as delivered,
        count(*) filter (where ev.type = 'email.opened') as opened,
        count(*) filter (where ev.type = 'email.clicked') as clicked,
        count(distinct ev.email_id) filter (where ev.type = 'email.opened') as unique_opened,
        count(distinct ev.email_id) filter (where ev.type = 'email.clicked') as unique_clicked,
        count(*) filter (where ev.type = 'email.bounced') as bounced,
        count(*) filter (where ev.type = 'email.complained') as complained,
        count(*) filter (where ev.type = 'email.unsubscribed') as unsubscribed
      from email_events ev
      join emails e on e.tenant_id = ev.tenant_id and e.id = ev.email_id
      where ev.tenant_id = $1 and e.automation_id = $2
        and ev.created_at >= $4 and ev.created_at < $5 and ${realEmailEvent()}
      group by ev.email_id
    ), email_counts as (
      select s.key,
        sum(ev.sent) as sent, sum(ev.delivered) as delivered,
        sum(ev.opened) as opened, sum(ev.clicked) as clicked,
        sum(ev.unique_opened) as unique_opened, sum(ev.unique_clicked) as unique_clicked,
        sum(ev.bounced) as bounced, sum(ev.complained) as complained,
        sum(ev.unsubscribed) as unsubscribed
      from event_counts ev
      join emails e on e.tenant_id = $1 and e.id = ev.email_id and e.automation_id = $2
      join assignments s on s.run_id = e.automation_run_id and e.created_at >= s.created_at
      group by s.key
    ), keys as (
      select unnest($6::text[]) as key
      union select key from assignments
    )
    select k.key, coalesce(r.runs, 0) as runs,
      coalesce(e.sent, 0) as sent, coalesce(e.delivered, 0) as delivered,
      coalesce(e.opened, 0) as opened, coalesce(e.clicked, 0) as clicked,
      coalesce(e.unique_opened, 0) as unique_opened, coalesce(e.unique_clicked, 0) as unique_clicked,
      coalesce(e.bounced, 0) as bounced, coalesce(e.complained, 0) as complained,
      coalesce(e.unsubscribed, 0) as unsubscribed
    from keys k
    left join run_counts r on r.key = k.key
    left join email_counts e on e.key = k.key
    order by k.key
  `, [tenantId, input.automationId, input.stepKey, input.start, input.end, config.variants.map((variant) => variant.key)]);
  const rows = new Map<string, Record<string, unknown>>(
    result.rows.map((row: Record<string, unknown>) => [String(row.key), row]),
  );
  const configured = new Map(config.variants.map((variant) => [variant.key, variant]));
  // Configured order first, then stable historical order; include zero-result config
  // even when a mock/queryable returns no rows.
  const keys = [...configured.keys(), ...[...rows.keys()].filter((key) => !configured.has(key)).sort()];
  return {
    object: "automation_split_metrics",
    automation_id: input.automationId,
    step_key: input.stepKey,
    start_date: input.start.toISOString(),
    end_date: input.end.toISOString(),
    data: keys.map((key) => {
      const row = rows.get(key) ?? {};
      const variant = configured.get(key);
      const counts = Object.fromEntries(
        countMetrics.map((name) => [name, Number(row[name] ?? 0)]),
      ) as Record<CountMetric, number>;
      const rates = withRates(counts);
      return {
        key, label: variant?.label ?? key, weight: variant?.weight ?? null,
        runs: Number(row.runs ?? 0),
        sent: counts.sent, delivered: counts.delivered, opened: counts.opened, clicked: counts.clicked,
        unique_opened: counts.unique_opened, unique_clicked: counts.unique_clicked,
        bounced: counts.bounced, complained: counts.complained, unsubscribed: counts.unsubscribed,
        delivery_rate: rates.delivery_rate, open_rate: rates.open_rate, click_rate: rates.click_rate,
        bounce_rate: rates.bounce_rate, complaint_rate: rates.complaint_rate,
        unsubscribe_rate: rates.unsubscribe_rate,
      };
    }),
  };
}
