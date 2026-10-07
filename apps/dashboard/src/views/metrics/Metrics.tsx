import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, CircleHelp, RefreshCw } from "lucide-react";
import { AreaChart } from "../../components/AreaChart";
import type { BadgeVariant } from "../../components/Badge";
import { BarChart } from "../../components/BarChart";
import type { Series } from "../../components/chart";
import { Drawer } from "../../components/Drawer";
import { Select } from "../../components/Field";
import { Empty, Failed } from "../../components/Empty";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { useFilters } from "../../hooks/useFilters";
import { useList } from "../../hooks/useList";
import { useAll, useResource } from "../../hooks/useResource";
import { withQuery } from "../../lib/client";
import type { Automation, Broadcast, Domain, Metrics as MetricsResponse } from "../../types";
import { GoalConversions } from "../goals/GoalConversions";
import {
  bucketLabel,
  buckets,
  dateKey,
  granularities,
  percent,
  rate,
  ranges,
  timezone,
  windowFor,
  type Granularity,
} from "./range";
import "../../styles/metrics.css";

/** Bounce rate above this puts sending at risk. */
export const bounceRisk = 4;
/** Complaint rate, in percent, above which mailbox providers start to filter a sender. */
export const complaintLimit = 0.08;

type Row = Record<string, string | number | null>;

export const chartEvents: Array<{ id: string; label: string; metric: string; tone: BadgeVariant }> = [
  { id: "delivered", label: "Delivered", metric: "delivered", tone: "success" },
  { id: "sent", label: "Sent", metric: "sent", tone: "neutral" },
  { id: "opened", label: "Opened", metric: "unique_opened", tone: "info" },
  { id: "clicked", label: "Clicked", metric: "unique_clicked", tone: "accent" },
  { id: "bounced", label: "Bounced", metric: "bounced", tone: "danger" },
  { id: "complained", label: "Complained", metric: "complained", tone: "warning" },
];
const defaultEvents = ["delivered", "opened", "clicked", "bounced"];

const num = (row: Row | undefined, metric: string) => Number(row?.[metric] ?? 0) || 0;

/** The counts behind every tile and rate, with the API's formulas. */
export function summarize(row: Row | undefined) {
  const sent = num(row, "sent");
  const delivered = num(row, "delivered");
  const bounced = num(row, "bounced");
  const transient = num(row, "bounced_transient");
  const permanent = num(row, "bounced_permanent");
  return {
    sent,
    delivered,
    bounced,
    transient,
    permanent,
    // Bounces with no type from the provider count as undetermined, so the parts add up to the total.
    undetermined: Math.max(0, bounced - transient - permanent),
    complained: num(row, "complained"),
    opened: num(row, "unique_opened"),
    clicked: num(row, "unique_clicked"),
    deliveryRate: rate(delivered, sent),
    bounceRate: rate(bounced, sent),
    complaintRate: rate(num(row, "complained"), delivered),
    openRate: rate(num(row, "unique_opened"), delivered),
    clickRate: rate(num(row, "unique_clicked"), delivered),
  };
}

/** `/metrics`: sent, bounce rate, and complaint rate over a range, by domain. */
export function Metrics() {
  const filters = useFilters(["range", "start", "end", "granularity", "domain", "events"]);
  const [, setParams] = useSearchParams();
  const [tick, setTick] = useState(0);
  const [help, setHelp] = useState(false);

  const span = useMemo(
    () => windowFor(filters),
    // `tick` re-reads "now" on refresh
    [filters, tick],
  );
  const domainIds = filters.domain ? filters.domain.split(",").filter(Boolean) : [];
  const events = filters.events ? filters.events.split(",").filter(Boolean) : defaultEvents;

  const base = {
    start_date: span.start.toISOString(),
    end_date: span.end.toISOString(),
    timezone: timezone(),
    granularity: span.granularity,
    domain_id: domainIds.join(","),
  };
  const byPeriod = useResource<MetricsResponse>(span.error ? null : withQuery("/emails/metrics", { ...base, dimensions: "period" }));
  const byDomain = useResource<MetricsResponse>(span.error ? null : withQuery("/emails/metrics", { ...base, dimensions: "domain" }));
  const domains = useList<Domain>("/domains", {}, { all: true });

  const set = (changes: Record<string, string | null>) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });

  const keys = useMemo(() => buckets(span.start, span.end, span.granularity), [span]);
  const periods = useMemo(() => {
    const rows = new Map<string, Row>();
    for (const row of byPeriod.data?.data ?? []) rows.set(String(row.period), row);
    return keys.map((key) => ({ key, row: rows.get(key), stats: summarize(rows.get(key)) }));
  }, [keys, byPeriod.data]);

  const totals = summarize(byPeriod.data?.totals);
  const loading = byPeriod.loading && !byPeriod.data;
  const error = byPeriod.error ?? byDomain.error;
  const quiet = Boolean(byPeriod.data) && Object.values(byPeriod.data!.totals ?? {}).every((value) => !value);
  const formatX = (value: string) => bucketLabel(value, span.granularity);
  const range = filters.range ?? "7d";

  const sentSeries: Series[] = chartEvents
    .filter((item) => events.includes(item.id))
    .map((item) => ({
      name: item.label,
      tone: item.tone,
      points: periods.map(({ key, row }) => ({ x: key, y: num(row, item.metric) })),
    }));
  const bounceSeries: Series[] = [
    { name: "Transient", tone: "warning", points: periods.map(({ key, stats }) => ({ x: key, y: rate(stats.transient, stats.sent) })) },
    { name: "Permanent", tone: "danger", points: periods.map(({ key, stats }) => ({ x: key, y: rate(stats.permanent, stats.sent) })) },
    { name: "Undetermined", tone: "neutral", points: periods.map(({ key, stats }) => ({ x: key, y: rate(stats.undetermined, stats.sent) })) },
  ];
  const complaintSeries: Series[] = [
    { name: "Complaint rate", tone: "warning", points: periods.map(({ key, stats }) => ({ x: key, y: stats.complaintRate })) },
  ];

  const domainRows = [...(byDomain.data?.data ?? [])]
    .map((row) => ({ id: String(row.domain_id ?? "other"), name: row.domain_name ? String(row.domain_name) : null, stats: summarize(row) }))
    .sort((a, b) => b.stats.sent - a.stats.sent);

  return (
    <div className="page">
      <PageHeader
        title="Metrics"
        actions={
          <>
            <button type="button" className="secondary" onClick={() => setHelp(true)}>
              <CircleHelp size={15} />
              How rates work
            </button>
            <button type="button" className="secondary" onClick={() => setTick((value) => value + 1)} disabled={byPeriod.loading}>
              <RefreshCw size={15} />
              Refresh
            </button>
          </>
        }
      />

      <div className="metricControls">
        <DomainPicker domains={domains.rows} selected={domainIds} onChange={(ids) => set({ domain: ids.join(",") || null })} />
        <div className="rangeGroup" role="group" aria-label="Date range">
          {ranges.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={range === item.id}
              onClick={() => set({ range: item.id === "7d" ? null : item.id, start: null, end: null })}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={range === "custom"}
            onClick={() =>
              set({
                range: "custom",
                start: filters.start ?? dateKey(span.start),
                end: filters.end ?? dateKey(span.end),
              })
            }
          >
            Custom
          </button>
        </div>
        {range === "custom" ? (
          <div className="customRange">
            <label>
              <span>From</span>
              <input type="date" aria-label="Start date" value={filters.start ?? ""} max={filters.end} onChange={(event) => set({ start: event.target.value })} />
            </label>
            <label>
              <span>To</span>
              <input type="date" aria-label="End date" value={filters.end ?? ""} min={filters.start} onChange={(event) => set({ end: event.target.value })} />
            </label>
          </div>
        ) : null}
        <select
          className="filterSelect"
          aria-label="Group by"
          value={filters.granularity ?? ""}
          onChange={(event) => set({ granularity: event.target.value || null })}
        >
          <option value="">Group automatically</option>
          {granularities.map((value) => (
            <option key={value} value={value}>
              {groupLabels[value]}
            </option>
          ))}
        </select>
      </div>

      {span.error ? (
        <div className="alert" role="alert">
          {span.error}
        </div>
      ) : null}

      {!span.error ? <GoalScopes start={base.start_date} end={base.end_date} /> : null}

      {error ? (
        <Failed
          message={error}
          onRetry={() => {
            void byPeriod.reload();
            void byDomain.reload();
          }}
        />
      ) : (
        <>
          <div className="statGrid">
            <Stat label="Sent" value={totals.sent} loading={loading} tone="neutral" />
            <Stat label="Delivered" value={totals.delivered} rate={totals.deliveryRate} rateLabel="of sent" loading={loading} tone="success" />
            <Stat label="Bounced" value={totals.bounced} rate={totals.bounceRate} rateLabel="of sent" loading={loading} tone="danger" />
            <Stat label="Complained" value={totals.complained} rate={totals.complaintRate} rateLabel="of delivered" digits={2} loading={loading} tone="warning" />
            <Stat label="Opened" value={totals.opened} rate={totals.openRate} rateLabel="of delivered" loading={loading} tone="info" />
            <Stat label="Clicked" value={totals.clicked} rate={totals.clickRate} rateLabel="of delivered" loading={loading} tone="accent" />
          </div>

          {loading ? (
            <Panel title="Sent emails">
              <Skeleton lines={6} />
            </Panel>
          ) : quiet ? (
            <Panel title="Sent emails">
              <Empty
                title="No email activity"
                body="Nothing was sent in this range. Pick a longer range or another domain."
                action={
                  <Link className="button secondary small" to="/emails/send">
                    Send a test email
                  </Link>
                }
              />
            </Panel>
          ) : (
            <>
              <Panel
                title="Sent emails"
                actions={
                  <div className="eventToggles" role="group" aria-label="Events in the chart">
                    {chartEvents.map((item) => (
                      <label key={item.id} className="eventToggle">
                        <input
                          type="checkbox"
                          checked={events.includes(item.id)}
                          onChange={(event) => {
                            const next = event.target.checked ? [...events, item.id] : events.filter((id) => id !== item.id);
                            const ordered = chartEvents.map((entry) => entry.id).filter((id) => next.includes(id));
                            set({ events: ordered.join(",") === defaultEvents.join(",") ? null : ordered.join(",") || "none" });
                          }}
                        />
                        <span className={`swatch ${item.tone}`} />
                        {item.label}
                      </label>
                    ))}
                  </div>
                }
              >
                <div className="bigNumber">
                  {totals.sent.toLocaleString()}
                  <span className="dim"> sent</span>
                </div>
                {sentSeries.length ? (
                  <AreaChart series={sentSeries} formatX={formatX} format={(value) => Math.round(value).toLocaleString()} label="Emails by event over time" />
                ) : (
                  <Empty title="No events chosen" body="Pick at least one event to chart." />
                )}
                <Table
                  compact
                  rows={domainRows}
                  loading={byDomain.loading && !byDomain.data}
                  empty={<p className="muted">No domains in this range.</p>}
                  columns={[
                    { header: "Domain", cell: (row) => (row.name ? <span className="mono">{row.name}</span> : <span className="dim">Other</span>) },
                    { header: "Sent", cell: (row) => row.stats.sent.toLocaleString(), className: "numeric" },
                    { header: "Delivered", cell: (row) => <Count value={row.stats.delivered} rate={row.stats.deliveryRate} />, className: "numeric" },
                    { header: "Bounced", cell: (row) => <Count value={row.stats.bounced} rate={row.stats.bounceRate} />, className: "numeric" },
                    { header: "Complained", cell: (row) => <Count value={row.stats.complained} rate={row.stats.complaintRate} digits={2} />, className: "numeric" },
                    { header: "Opened", cell: (row) => <Count value={row.stats.opened} rate={row.stats.openRate} />, className: "numeric" },
                    { header: "Clicked", cell: (row) => <Count value={row.stats.clicked} rate={row.stats.clickRate} />, className: "numeric" },
                  ]}
                />
              </Panel>

              <div className="rateCards">
                <Panel title="Bounce rate">
                  <div className={totals.bounceRate >= bounceRisk ? "bigNumber risk" : "bigNumber"}>{percent(totals.bounceRate, 2)}</div>
                  <BarChart
                    series={bounceSeries}
                    threshold={{ y: bounceRisk, label: `${bounceRisk}% risk` }}
                    format={(value) => percent(value)}
                    formatX={formatX}
                    label="Bounce rate by period, split into transient, permanent, and undetermined"
                  />
                </Panel>
                <Panel title="Complaint rate">
                  <div className={totals.complaintRate >= complaintLimit ? "bigNumber risk" : "bigNumber"}>{percent(totals.complaintRate, 2)}</div>
                  <BarChart
                    series={complaintSeries}
                    threshold={{ y: complaintLimit, label: `${complaintLimit}% limit` }}
                    format={(value) => percent(value, 2)}
                    formatX={formatX}
                    label="Complaint rate by period"
                  />
                </Panel>
              </div>
            </>
          )}
        </>
      )}

      <Drawer isOpen={help} onClose={() => setHelp(false)} title="How rates work" label="Help">
        <div className="stack helpText">
          <p>
            <strong>Bounce rate</strong> is permanent plus transient plus undetermined bounces, divided by emails sent, times 100. Above{" "}
            {bounceRisk}% your sending is at risk of review.
          </p>
          <p>
            <strong>Complaint rate</strong> is spam complaints divided by emails delivered, times 100. Keep it under {complaintLimit}%.
          </p>
          <p>
            <strong>Delivery rate</strong> is delivered divided by sent. <strong>Open rate</strong> and <strong>click rate</strong> count each email once,
            divided by delivered.
          </p>
          <p className="muted">
            Transient bounces are temporary, such as a full mailbox. Permanent bounces are addresses that do not exist. Undetermined bounces are the ones the
            provider could not classify. Counts are per email, not per recipient.
          </p>
        </div>
      </Drawer>
    </div>
  );
}

const groupLabels: Record<Granularity, string> = { hourly: "By hour", daily: "By day", weekly: "By week", monthly: "By month" };

/** Goal scope is independent of the email-domain filter; only the date range is shared. */
function GoalScopes({ start, end }: { start: string; end: string }) {
  const [scope, setScope] = useState("global");
  const [selected, setSelected] = useState("");
  const automations = useAll<Automation>(scope === "automation" ? "/automations" : null);
  const broadcasts = useAll<Broadcast>(scope === "broadcast" ? "/broadcasts" : null);
  const resource = scope === "automation" ? automations : broadcasts;
  const rows = resource.data?.data ?? [];
  const id = rows.find((row) => row.id === selected)?.id ?? rows[0]?.id;
  return <div className="stack">
    <Select label="Goal scope" value={scope} onChange={(next) => { setScope(next); setSelected(""); }}
      options={[{ value: "global", label: "All real sends" }, { value: "automation", label: "Automation" }, { value: "broadcast", label: "Broadcast" }]} />
    {scope !== "global" ? resource.error ? <Failed message={resource.error} onRetry={() => void resource.reload()} /> : resource.loading ? <Skeleton lines={2} /> : resource.data?.has_more ? <p role="alert">Not all scopes could be loaded.</p> : rows.length ? <Select
      label={scope === "automation" ? "Goal automation" : "Goal broadcast"} value={id ?? ""} onChange={setSelected}
      options={rows.map((row) => ({ value: row.id, label: row.name }))} /> : <p className="muted">No {scope === "automation" ? "automations" : "broadcasts"} available.</p> : null}
    <p className="muted">Goal conversions share the date range, not the email-domain filter.</p>
    {scope === "global" || (id && !resource.loading && !resource.error && !resource.data?.has_more) ? <GoalConversions
      key={`${scope}:${id ?? ""}`} automationId={scope === "automation" ? id : undefined}
      broadcastId={scope === "broadcast" ? id : undefined} start={start} end={end} /> : null}
  </div>;
}

function Stat({
  label,
  value,
  rate: share,
  rateLabel,
  digits = 1,
  loading,
  tone,
}: {
  label: string;
  value: number;
  rate?: number;
  rateLabel?: string;
  digits?: number;
  loading: boolean;
  tone: BadgeVariant;
}) {
  return (
    <section className="stat" aria-label={label}>
      <div className="statLabel">
        <span className={`swatch ${tone}`} />
        {label}
      </div>
      {loading ? (
        <Skeleton width="short" />
      ) : (
        <>
          <div className="statValue">{value.toLocaleString()}</div>
          {share !== undefined ? (
            <div className="statSub">
              {percent(share, digits)} {rateLabel}
            </div>
          ) : (
            <div className="statSub">&nbsp;</div>
          )}
        </>
      )}
    </section>
  );
}

function Count({ value, rate: share, digits = 1 }: { value: number; rate: number; digits?: number }) {
  return (
    <span>
      {value.toLocaleString()} <span className="dim">{percent(share, digits)}</span>
    </span>
  );
}

/** Multi-select of domains. The selection lives in `?domain=` as comma-separated ids. */
function DomainPicker({ domains, selected, onChange }: { domains: Domain[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const names = domains.filter((domain) => selected.includes(domain.id)).map((domain) => domain.name);
  const label = selected.length === 0 ? "All domains" : selected.length === 1 ? (names[0] ?? "1 domain") : `${selected.length} domains`;
  return (
    <div className="domainPicker" ref={root}>
      <button type="button" className="secondary" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="domainList" role="group" aria-label="Domains">
          {domains.length === 0 ? <p className="dim">No domains yet.</p> : null}
          {domains.map((domain) => (
            <label key={domain.id} className="check">
              <input
                type="checkbox"
                checked={selected.includes(domain.id)}
                onChange={(event) => onChange(event.target.checked ? [...selected, domain.id] : selected.filter((id) => id !== domain.id))}
              />
              <span className="mono">{domain.name}</span>
            </label>
          ))}
          {selected.length ? (
            <button type="button" className="ghost small" onClick={() => onChange([])}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
