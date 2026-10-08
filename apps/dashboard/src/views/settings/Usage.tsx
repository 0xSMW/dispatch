import { Link } from "react-router-dom";
import { Badge } from "../../components/Badge";
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

/** State counts such as `{ queued: 3, sent: 40 }` as badges. */
function Counts({ value }: { value: Record<string, unknown> | undefined }) {
  const entries = Object.entries(value ?? {}).filter(([, count]) => typeof count === "number");
  if (!entries.length) return <span className="dim">None</span>;
  return (
    <span className="counts">
      {entries.map(([state, count]) => (
        <Badge key={state} value={state} label={`${state.replaceAll("_", " ")} ${Number(count).toLocaleString()}`} />
      ))}
    </span>
  );
}

/** Share of the 24-hour quota used, from 0 to 100. */
export function quotaShare(sending: Pick<Sending, "max_24_hour" | "sent_24_hour">) {
  if (sending.max_24_hour <= 0) return 0;
  return Math.min(100, Math.round((sending.sent_24_hour / sending.max_24_hour) * 1000) / 10);
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
      >
        <span style={{ width: `${share}%` }} />
      </div>
      {sending.sandbox ? (
        <p className="note">In the sandbox, the provider sends only to verified addresses. Request production access to send to anyone.</p>
      ) : null}
    </div>
  );
}

/** Sending quota, usage counters, and system state. */
export function Usage() {
  const usage = useList<UsageCounter>("/usage", {}, { limit: 100 });
  const system = useResource<System>("/system");
  const data = system.data;

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <Tabs tabs={settingsTabs} />

      <Panel title="Sending quota">
        {system.error ? null : !data ? <Skeleton lines={2} /> : <Quota sending={data.sending ?? null} />}
      </Panel>

      <Panel title="System">
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

      <Panel title="Usage">
        <div className="stack">
          {usage.loading || usage.error || usage.rows.length || usage.page > 1 ? <p className="note">Counters for this tenant.</p> : null}
          <Table
            compact
            rows={usage.rows}
            loading={usage.loading}
            error={usage.error}
            onRetry={() => void usage.reload()}
            empty={<Empty compact title="No usage yet" body="Your usage shows up here after your first API call." action={<Link to="/emails/send">Send a test email</Link>} />}
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
