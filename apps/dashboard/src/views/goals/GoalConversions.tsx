import { Link } from "react-router-dom";
import { useState } from "react";
import { Empty, Failed } from "../../components/Empty";
import { Select } from "../../components/Field";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { useAll, useResource } from "../../hooks/useResource";
import { withQuery } from "../../lib/client";
import { isIsoDate } from "../../lib/rules";
import type { Goal, GoalMetrics } from "../../types";

export type GoalConversionsProps = {
  automationId?: string;
  broadcastId?: string;
  stepKey?: string;
  start?: string;
  end?: string;
};

export function goalScopeIssue({ automationId, broadcastId, stepKey, start, end }: GoalConversionsProps): string | null {
  if (automationId && broadcastId) return "Choose one automation or broadcast, not both.";
  if (stepKey && !automationId) return "An email step requires an automation.";
  for (const value of [start, end]) {
    if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !isIsoDate(value))) return "Use ISO timestamps with a timezone for the date range.";
  }
  if (start && end && Date.parse(start) >= Date.parse(end)) return "The range start must precede its end.";
  return null;
}

export function goalMetricsPath(id: string, scope: GoalConversionsProps = {}): string | null {
  if (!id || goalScopeIssue(scope)) return null;
  return withQuery(`/goals/${encodeURIComponent(id)}/metrics`, {
    automation_id: scope.automationId, broadcast_id: scope.broadcastId, step_key: scope.stepKey,
    start_date: scope.start, end_date: scope.end,
  });
}

/** Goal metrics return fractions, unlike email-metric percentages. */
export function conversionRate(rate: number): string {
  return `${(rate * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

export function GoalConversions(scope: GoalConversionsProps) {
  const goals = useAll<Goal>("/goals");
  const [picked, setPicked] = useState("");
  const rows = goals.data?.data ?? [];
  const goal = rows.find((row) => row.id === picked) ?? rows[0];
  const issue = goalScopeIssue(scope);
  const path = goal ? goalMetricsPath(goal.id, scope) : null;
  return <Panel title="Goal conversions">
    <div className="stack">
      {goals.error ? <Failed message={goals.error} onRetry={() => void goals.reload()} /> : goals.loading ? <Skeleton lines={2} /> : goals.data?.has_more ? <p role="alert">Not all goals could be loaded. Retry before choosing a goal.</p> : rows.length ? <>
        <Select label="Goal" value={goal?.id ?? ""} onChange={setPicked} options={rows.map((row) => ({ value: row.id, label: row.name }))} />
        {goal ? <p className="muted">{"event" in goal.target ? `Event: ${goal.target.event}` : "Recorded contact-state entry"} · {goal.window_days}-day conversion window</p> : null}
        {issue ? <p role="alert">{issue}</p> : path ? <ConversionResults key={path} path={path} /> : null}
      </> : <Empty title="No goals" body="Create a goal to measure conversions from your sends." action={<Link className="button secondary" to="/goals">View goals</Link>} />}
      {rows.length ? <p className="muted">The date range selects first-send cohorts: start inclusive, end exclusive. Conversion can happen through the inclusive window after that first scoped send, even after the range ends. Days are UTC. Eligibility uses current contact state. Sandbox sends are excluded; later sandbox activity does not replace prior real-send attribution.</p> : null}
    </div>
  </Panel>;
}

function ConversionResults({ path }: { path: string }) {
  const metrics = useResource<GoalMetrics>(path);
  if (metrics.error) return <Failed message={metrics.error} onRetry={() => void metrics.reload()} />;
  const data = metrics.data;
  if (!data) return <Skeleton lines={4} />;
  return <div className="stack">
    <dl className="statStrip" aria-label="Goal conversion totals">
      <div className="stat"><dt>Contacts reached</dt><dd>{data.contacts_reached.toLocaleString()}</dd></div>
      <div className="stat"><dt>Converted</dt><dd>{data.converted.toLocaleString()}</dd></div>
      <div className="stat"><dt>Conversion rate</dt><dd>{conversionRate(data.rate)}</dd></div>
    </dl>
    {!data.contacts_reached ? <p className="muted">No eligible contacts reached in this cohort range.</p> : null}
    <Table rows={data.data} rowKey={(row) => row.date} empty={<p className="muted">No first-send cohorts in this range.</p>} columns={[
      { header: "First-send day (UTC)", cell: (row) => row.date },
      { header: "Contacts reached", cell: (row) => row.contacts_reached.toLocaleString() },
      { header: "Converted", cell: (row) => row.converted.toLocaleString() },
      { header: "Conversion rate", cell: (row) => conversionRate(row.rate) },
    ]} />
    <p className="muted">{data.history.limitation}</p>
    <p className="muted">Contact history available from: {data.history.available_from ?? "No recorded contact history yet"}</p>
  </div>;
}
