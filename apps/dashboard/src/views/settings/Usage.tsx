import { useState } from "react";
import { Badge, badgeLabel } from "../../components/Badge";
import { Empty, Failed } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { useList } from "../../hooks/useList";
import { useResource } from "../../hooks/useResource";
import type { Sending, System, UsageCounter } from "../../types";
import { Region } from "../domains/Domains";
import { settingsTabs } from "../tabs";
import "../../styles/settings.css";
import "../../styles/usage.css";

/** State counts such as `{ queued: 3, sent: 40 }` as badges. */
function Counts({ value }: { value: Record<string, unknown> | undefined }) {
  const entries = Object.entries(value ?? {}).filter(([, count]) => typeof count === "number");
  if (!entries.length) return <span className="dim">None</span>;
  return (
    <span className="counts">
      {entries.map(([state, count]) => (
        <Badge key={state} value={state} label={`${badgeLabel(state)} ${Number(count).toLocaleString()}`} />
      ))}
    </span>
  );
}

/** Share of the 24-hour quota used, from 0 to 100. */
export function quotaShare(sending: Pick<Sending, "max_24_hour" | "sent_24_hour">) {
  if (sending.max_24_hour <= 0) return 0;
  return Math.max(0, Math.min(100, (sending.sent_24_hour / sending.max_24_hour) * 100));
}

function Quota({ sending }: { sending: Sending | null }) {
  if (!sending) return <p className="note">Could not read the provider's sending limits. Check the provider credentials and region.</p>;
  const share = quotaShare(sending);
  return (
    <div className="stack">
      <Facts
        columns={4}
        items={[
          {
            label: "Sent in the last 24 hours",
            value: `${sending.sent_24_hour.toLocaleString()} of ${sending.max_24_hour.toLocaleString()}`,
          },
          { label: "Send rate", value: `${sending.max_per_second.toLocaleString()} per second` },
          { label: "Region", value: <Region code={sending.region} /> },
          {
            label: "Account",
            value: sending.sandbox ? <Badge value="pending" label="Sandbox" /> : <Badge value="verified" label="Production" />,
          },
        ]}
      />
      <div
        className={share >= 90 ? "meter danger" : share >= 75 ? "meter warning" : "meter"}
        role="meter"
        aria-label="24-hour quota used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={share}
        aria-valuetext={`${quotaLabel(share)} of the 24-hour quota used`}
      >
        <span style={{ width: `${share}%`, minWidth: share > 0 ? 2 : 0 }} />
      </div>
      <p className="note">{quotaLabel(share)} of the 24-hour quota used.</p>
      {sending.sandbox ? (
        <p className="note">In the sandbox, the provider sends only to verified addresses. Request production access to send to anyone.</p>
      ) : null}
    </div>
  );
}

export function estimateLabel(value: number) {
  return value > 0 && value < 0.01 ? "<$0.01" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function quotaLabel(share: number) {
  return share > 0 && share < 0.1 ? "<0.1%" : `${Math.round(share * 10) / 10}%`;
}

type UsageSummary = {
  month: string; recipients: number; ses_recipients: number; api_requests: number;
  unmeasured_sends: number; ses_estimate_usd: number; ses_rate_per_1000_usd: number;
  days: Array<{ date: string; recipients: number; api_requests: number }>;
};

function MonthlyUsage({ data }: { data: UsageSummary }) {
  const max = Math.max(1, ...data.days.map((day) => day.recipients));
  return <div className="stack">
    <div className="usageSummary">
      <div><span>Recipients sent</span><strong>{data.recipients.toLocaleString()}</strong></div>
      <div><span>API requests</span><strong>{data.api_requests.toLocaleString()}</strong></div>
      <div><span>SES base estimate</span><strong>{estimateLabel(data.ses_estimate_usd)}</strong></div>
    </div>
    <p className="note">{data.ses_recipients.toLocaleString()} SES recipient sends × ${data.ses_rate_per_1000_usd.toFixed(2)} per 1,000. Excludes data transfer, attachments, add-ons, taxes and credits. <a href="https://aws.amazon.com/ses/pricing/" target="_blank" rel="noreferrer">SES pricing</a></p>
    {data.unmeasured_sends > 0 ? <p className="note">{data.unmeasured_sends.toLocaleString()} older sends have no recorded recipient count and are excluded from the recipient total and estimate.</p> : null}
    <figure className="usageActivity">
      <figcaption>Daily recipient sends <span className="dim">UTC</span></figcaption>
      <div className="usageBars" style={{ gridTemplateColumns: `repeat(${data.days.length}, minmax(0, 1fr))` }}>
        {data.days.map((day) => <div key={day.date} tabIndex={0} aria-label={`${day.date}: ${day.recipients.toLocaleString()} recipients, ${day.api_requests.toLocaleString()} API requests`} title={`${day.date}: ${day.recipients.toLocaleString()} recipients · ${day.api_requests.toLocaleString()} API requests`}>
          <span style={{ height: `${day.recipients / max * 100}%`, minHeight: day.recipients > 0 ? 2 : 0 }} />
        </div>)}
      </div>
      <div className="usageAxis"><span>{data.days[0]?.date}</span><span>{data.days.at(-1)?.date}</span></div>
      {data.recipients === 0 ? <p className="note">No recorded recipient sends this month.</p> : null}
    </figure>
    <section><h3>Daily totals</h3><div className="usageDaily"><table><thead><tr><th>Date (UTC)</th><th>Recipients</th><th>API requests</th></tr></thead><tbody>{data.days.map((day) => <tr key={day.date}><td>{day.date}</td><td>{day.recipients.toLocaleString()}</td><td>{day.api_requests.toLocaleString()}</td></tr>)}</tbody></table></div></section>
  </div>;
}

/** Tenant calendar-month activity and the independent AWS account sending limits. */
export function Usage() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const monthly = useResource<UsageSummary>(`/usage/summary?month=${month}`);
  const usage = useList<UsageCounter>("/usage", {}, { limit: 100 });
  const system = useResource<System>("/system");
  const data = system.data;

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <Tabs tabs={settingsTabs} />

      <Panel title="Monthly usage" actions={<label className="usageMonth">Month (UTC)<input aria-label="Month (UTC)" type="month" value={month} max={new Date().toISOString().slice(0, 7)} onChange={(event) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) setMonth(event.target.value); }} /></label>}>
        {monthly.loading ? <Skeleton lines={3} /> : monthly.error ? <Failed message={monthly.error} onRetry={monthly.reload} /> : monthly.data ? <MonthlyUsage data={monthly.data} /> : null}
      </Panel>

      <Panel title="AWS account sending quota">
        <p className="note">Regional AWS account usage over the last 24 hours, across all applications and tenants using that account. Separate from this tenant's selected calendar month.</p>
        {system.error ? <Failed message={system.error} onRetry={system.reload} /> : !data ? <Skeleton lines={2} /> : <Quota sending={data.sending ?? null} />}
      </Panel>

      <Panel title="System details">
        {system.error ? (
          <Failed message={system.error} onRetry={system.reload} />
        ) : !data ? (
          <Skeleton lines={3} />
        ) : (
          <Facts
            columns={3}
            items={[
              { label: "Provider", value: <Badge value={data.provider} variant={data.provider === "ses" ? "success" : "warning"} /> },
              { label: "Worker concurrency", value: String(data.worker.concurrency) },
              { label: "API logs", value: data.logs ? Number(data.logs.count).toLocaleString() : "0" },
              { label: "Send jobs", value: <Counts value={data.worker.backlog} /> },
              { label: "Webhook attempts", value: <Counts value={data.webhooks.attempts as Record<string, unknown>} /> },
              { label: "Automation runs", value: <Counts value={data.automations} /> },
              {
                label: "Webhooks",
                value: `${Number(data.webhooks.enabled_webhooks ?? 0)} enabled, ${Number(data.webhooks.disabled_webhooks ?? 0)} disabled`,
              },
              { label: "Last API call", value: <Time value={data.logs?.last_seen_at} /> },
            ]}
          />
        )}
      </Panel>

      <Panel title="Raw usage counters">
        <div className="stack">
          {usage.loading || usage.error || usage.rows.length || usage.page > 1 ? <p className="note">Counters for this tenant.</p> : null}
          <Table
            compact
            rows={usage.rows}
            loading={usage.loading}
            error={usage.error}
            onRetry={() => void usage.reload()}
            empty={<Empty compact title="No usage yet" body="Your usage shows up here after your first API call."
              // action={<Link to="/emails/send">Send a test email</Link>}
            />}
            page={usage.page}
            hasMore={usage.hasMore}
            onNext={usage.next}
            onPrevious={usage.previous}
            columns={[
              { header: "Counter", cell: (row) => <span className="mono">{row.name}</span> },
              { header: "Period", cell: (row) => row.period },
              { header: "Value", cell: (row) => Number(row.value).toLocaleString() },
              { header: "Updated", cell: (row) => <Time value={row.updated_at} /> },
            ]}
          />
        </div>
      </Panel>
    </div>
  );
}
