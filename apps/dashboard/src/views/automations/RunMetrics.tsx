import { useState } from "react";
import { BarChart } from "../../components/BarChart";
import { DateRange, useDateRange } from "../../components/DateRange";
import { Failed } from "../../components/Empty";
import { FilterBar } from "../../components/FilterBar";
import { Select } from "../../components/Field";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { useResource } from "../../hooks/useResource";
import { Table } from "../../components/Table";
import type { ResourceState } from "../../hooks/useResource";
import { emailRows, type EmailReport } from "./EmailMetrics";
import type { Tree } from "./graph";
import { withQuery } from "../../lib/client";
import type { RunCounts, RunMetrics as Metrics } from "../../types";
import type { Series } from "../../components/chart";
import { GoalConversions } from "../goals/GoalConversions";
import "../../styles/audience.css";
import "../../styles/automations.css";

const shown = [
  { key: "running", label: "Running", tone: "info" },
  { key: "completed", label: "Completed", tone: "success" },
  { key: "failed", label: "Failed", tone: "danger" },
] as const;

/** A share of `total` as a percentage with up to one decimal, such as "12.5%". */
export function percent(count: number, total: number) {
  if (total <= 0) return "0%";
  return `${Math.round((count / total) * 1000) / 10}%`;
}

function day(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

/** YYYY-MM-DD in local time, for a range bound. */
function localDay(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * One entry per day from the first to the last, so quiet days chart as zero. The range bounds,
 * when set, stretch the span to the whole window.
 */
export function everyDay(data: Metrics["data"], range: { start?: string; end?: string } = {}) {
  const dates = data.map((item) => item.date);
  if (range.start) dates.push(localDay(range.start));
  if (range.end) dates.push(localDay(range.end));
  if (!dates.length) return [];
  dates.sort();
  const byDate = new Map(data.map((item) => [item.date, item]));
  const out: Metrics["data"] = [];
  const last = day(dates.at(-1)!);
  for (let cursor = day(dates[0]!); cursor <= last; cursor = new Date(cursor.getTime() + 86_400_000)) {
    const date = cursor.toISOString().slice(0, 10);
    out.push(byDate.get(date) ?? { date, running: 0, completed: 0, failed: 0, cancelled: 0 });
  }
  return out;
}

/** Stacked series for the runs-per-day chart, cancelled last. */
export function runSeries(days: Metrics["data"]): Series[] {
  const tones: Record<keyof RunCounts, Series["tone"]> = { completed: "success", failed: "danger", running: "info", cancelled: "neutral" };
  return (["completed", "failed", "running", "cancelled"] as const).map((key) => ({
    name: key.charAt(0).toUpperCase() + key.slice(1),
    tone: tones[key],
    points: days.map((item) => ({ x: item.date, y: item[key] })),
  }));
}

/** The builder's Metrics tab: status shares and runs per day, from `GET /automations/:id/runs/metrics`. */
export function RunMetrics({ automationId, tree = null, names = {}, emails }: {
  automationId: string; tree?: Tree | null; names?: Record<string, string>; emails?: ResourceState<EmailReport>;
}) {
  const range = useDateRange();
  const metrics = useResource<Metrics>(withQuery(`/automations/${automationId}/runs/metrics`, { start_date: range.start, end_date: range.end }));
  const data = metrics.data;
  const [stepKey, setStepKey] = useState("");
  const steps = emailRows(tree, names, emails?.data ?? null).filter((row) => row.key !== "legacy");
  const selectedStep = steps.some((row) => row.key === stepKey) ? stepKey : "";

  return (
    <div className="stack">
      <FilterBar search={false}>
        <DateRange />
      </FilterBar>
      {steps.length ? <Select label="Goal email step" value={selectedStep} onChange={setStepKey}
        options={[{ value: "", label: "All automation emails" }, ...steps.map((row) => ({ value: row.key, label: `${row.name} · ${row.key}` }))]} /> : null}
      <GoalConversions automationId={automationId} stepKey={selectedStep || undefined} start={range.start} end={range.end} />
      {emails ? <Panel title="Emails">
        <Table
          rows={emailRows(tree, names, emails.data)}
          rowKey={(row) => row.id}
          loading={emails.loading}
          error={emails.error}
          onRetry={() => void emails.reload()}
          columns={[
            { header: "Email", cell: (row) => <><strong>{row.name}</strong><div className="mono dim">{row.key}</div></> },
            { header: "Sent", cell: (row) => row.sent.toLocaleString() },
            { header: "Delivered", cell: (row) => row.delivered.toLocaleString() },
            { header: "Open rate", cell: (row) => `${row.open_rate}%` },
            { header: "Click rate", cell: (row) => `${row.click_rate}%` },
            { header: "Bounce rate", cell: (row) => `${row.bounce_rate}%` },
            { header: "Unsubscribes", cell: (row) => row.unsubscribed.toLocaleString() },
          ]}
        />
      </Panel> : null}
      {metrics.error ? (
        <Failed message={metrics.error} onRetry={() => void metrics.reload()} />
      ) : !data ? (
        <Skeleton lines={6} />
      ) : (
        <>
          <dl className="statStrip" aria-label="Runs by status">
            {shown.map((item) => (
              <div key={item.key} className="stat">
                <dt>{item.label}</dt>
                <dd>{percent(data.totals[item.key], data.total)}</dd>
                <dd className="statNote">
                  {data.totals[item.key].toLocaleString()} of {data.total.toLocaleString()} {data.total === 1 ? "run" : "runs"}
                </dd>
              </div>
            ))}
          </dl>
          <Panel title="Runs per day">
            <BarChart
              label="Runs per day by status"
              series={runSeries(everyDay(data.data, range))}
              formatX={(value) => day(value).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}
            />
          </Panel>
        </>
      )}
    </div>
  );
}
