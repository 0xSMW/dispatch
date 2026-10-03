import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw, Zap } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Code } from "../../components/Code";
import { DateRange, useDateRange } from "../../components/DateRange";
import { Drawer } from "../../components/Drawer";
import { Empty, Failed } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { FilterBar } from "../../components/FilterBar";
import { Tile } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Time } from "../../components/Time";
import { useFilters } from "../../hooks/useFilters";
import { useList } from "../../hooks/useList";
import { useResource } from "../../hooks/useResource";
import type { AutomationRun, AutomationRunDetail } from "../../types";
import { allKeys, stepLabels, type Tree } from "./graph";
import { StepList, elapsed, type RunStep, type StepOptions } from "./Steps";
import { Canvas, ViewSwitch, type View } from "./Canvas";

export const runStatuses = ["running", "completed", "failed", "cancelled"];

function contact(run: AutomationRun) {
  return run.event?.email ?? run.email ?? null;
}

function eventName(run: AutomationRun) {
  return run.event?.name ?? run.event_name ?? "";
}

function finished(run: AutomationRun) {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

/** The Runs tab of the builder: `GET /automations/:id/runs` with status and date filters, and a run drawer. */
export function Runs({ automationId, tree, options }: { automationId: string; tree: Tree | null; options?: StepOptions }) {
  const filters = useFilters(["status"]);
  const range = useDateRange();
  const runs = useList<AutomationRun>(`/automations/${automationId}/runs`, { ...filters, start_date: range.start, end_date: range.end });
  const [params, setParams] = useSearchParams();
  const open = params.get("run");
  const setOpen = (id: string | null) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (id) next.set("run", id);
      else next.delete("run");
      return next;
    });

  return (
    <div className="stack">
      <FilterBar search={false} filters={[{ param: "status", label: "Status", options: runStatuses, all: "All statuses" }]}>
        <DateRange />
        <button type="button" className="secondary small" onClick={() => void runs.reload()} disabled={runs.loading}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </FilterBar>
      <Table
        rows={runs.rows}
        loading={runs.loading}
        error={runs.error}
        onRetry={() => void runs.reload()}
        onRowClick={(row) => setOpen(row.id)}
        page={runs.page}
        hasMore={runs.hasMore}
        onNext={runs.next}
        onPrevious={runs.previous}
        noun="runs"
        empty={
          filters.status || range.start || range.end ? (
            <Empty title="No runs" body="No runs match these filters." />
          ) : (
            <Empty title="No runs yet" body="A run starts each time the trigger event fires while the automation is enabled." />
          )
        }
        columns={[
          { header: "Contact", cell: (row) => contact(row) ?? <span className="dim">No contact</span> },
          { header: "Event", cell: (row) => <span className="mono">{eventName(row)}</span> },
          { header: "Status", cell: (row) => <Badge value={row.status ?? "running"} /> },
          { header: "Started", cell: (row) => <Time value={row.created_at} /> },
          { header: "Duration", cell: (row) => (finished(row) ? elapsed(row.created_at, row.updated_at) : <span className="dim">—</span>) },
        ]}
      />
      {open ? <RunDrawer automationId={automationId} runId={open} tree={tree} options={options} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** One run from `GET /automations/:id/runs/:run_id`: the step list tinted by each step's status, with output. */
export function RunDrawer({ automationId, runId, tree, onClose, options }: { automationId: string; runId: string; tree: Tree | null; onClose: () => void; options?: StepOptions }) {
  const run = useResource<AutomationRunDetail>(`/automations/${automationId}/runs/${runId}`);
  const data = run.data;
  const steps = new Map<string, RunStep>((data?.steps ?? []).filter((step) => step.key).map((step) => [step.key!, step]));
  const known = tree ? allKeys(tree) : new Set<string>();
  const others = (data?.steps ?? []).filter((step) => !step.key || !known.has(step.key));
  const [view, setView] = useState<View>("list");

  return (
    <Drawer
      isOpen
      title={data ? (contact(data) ?? "Run") : "Run"}
      label="Run"
      onClose={onClose}
      width="wide"
      actions={
        <button type="button" className="secondary small" onClick={() => void run.reload()} disabled={run.loading}>
          <RefreshCw size={14} />
          Refresh
        </button>
      }
    >
      {run.error ? (
        <Failed message={run.error} onRetry={() => void run.reload()} />
      ) : !data ? (
        <Skeleton lines={6} />
      ) : (
        <div className="stack">
          <Facts
            columns={3}
            items={[
              { label: "Status", value: <Badge value={data.status ?? "running"} /> },
              { label: "Contact", value: contact(data) },
              { label: "Event", value: eventName(data), mono: true },
              { label: "Started", value: <Time value={data.created_at} mode="absolute" /> },
              { label: "Duration", value: finished(data) ? elapsed(data.created_at, data.updated_at) : "Running" },
              { label: "ID", value: data.id, copy: true },
            ]}
          />
          {data.error ? (
            <div className="alert" role="alert">
              {data.error}
            </div>
          ) : null}
          <Panel title="Event payload">
            <Code value={data.event?.payload ?? data.event_data ?? {}} />
          </Panel>
          {tree ? <ViewSwitch value={view} onChange={setView} /> : null}
          {tree && view === "canvas" ? (
            <Canvas tree={tree} run={steps} options={options} stacked />
          ) : tree ? (
            <div className="builder runView">
              <article className="stepCard tint success" aria-label="Trigger">
                <header className="stepHeader">
                  <Tile tone="accent">
                    <Zap size={14} />
                  </Tile>
                  <div className="stepTitle">
                    <strong>Trigger</strong>
                    <span className="mono dim">{tree.trigger}</span>
                  </div>
                </header>
                <p className="muted">
                  When <span className="mono">{eventName(data) || tree.event}</span> fires
                </p>
              </article>
              <StepList nodes={tree.steps} run={steps} options={options} />
            </div>
          ) : null}
          {others.length ? (
            <Panel title={tree ? "Steps no longer in this automation" : "Steps"}>
              <Table
                compact
                rows={others}
                rowKey={(step) => `${step.key}-${step.started_at ?? step.created_at ?? ""}`}
                columns={[
                  { header: "Step", cell: (step) => <span className="mono">{step.key}</span> },
                  { header: "Type", cell: (step) => stepLabels[step.type as keyof typeof stepLabels] ?? step.type },
                  { header: "Status", cell: (step) => <Badge value={step.status ?? step.state ?? "running"} /> },
                  { header: "Started", cell: (step) => <Time value={step.started_at ?? null} mode="absolute" /> },
                  { header: "Output", cell: (step) => (step.error ? <span className="errorText">{step.error}</span> : <Code value={step.output} copy={false} />) },
                ]}
              />
            </Panel>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
