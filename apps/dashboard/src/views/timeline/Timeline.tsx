import { useNavigate } from "react-router-dom";
import { Badge } from "../../components/Badge";
import { Empty } from "../../components/Empty";
import { ListPage } from "../../components/ListPage";
import { Time } from "../../components/Time";
import { useList } from "../../hooks/useList";
import type { TimelineItem } from "../../types";

const kinds: Record<string, string> = {
  email: "Email",
  email_event: "Email event",
  custom_event: "Event",
  received_email: "Received",
  webhook_attempt: "Webhook",
  automation_run: "Automation run",
  api_log: "API call",
};

/** Where a timeline row leads, or null when it has no page. `summary` holds the parent id for events. */
export function timelineHref(item: TimelineItem): string | null {
  switch (item.kind) {
    case "email":
      return `/emails/${item.id}`;
    case "email_event":
      return item.summary ? `/emails/${item.summary}` : null;
    case "received_email":
      return `/emails/receiving/${item.id}`;
    case "webhook_attempt":
      return item.summary ? `/webhooks/${item.summary}` : null;
    case "automation_run":
      return item.summary ? `/automations/${encodeURIComponent(item.summary)}/editor?tab=runs&run=${encodeURIComponent(item.id)}` : null;
    case "api_log":
      return `/logs/${item.id}`;
    default:
      return null;
  }
}

/** Dispatch-only: emails, events, inbound mail, webhook attempts, runs, and API calls in one stream. */
export function Timeline() {
  const list = useList<TimelineItem>("/timeline");
  const navigate = useNavigate();
  return (
    <ListPage
      title="Timeline"
      description="Everything that happened in this tenant, newest first."
      list={list}
      noun="items"
      onRowClick={(row) => {
        const href = timelineHref(row);
        if (href) navigate(href);
      }}
      empty={<Empty title="Nothing yet" body="Activity across the API shows here." />}
      columns={[
        { header: "Kind", cell: (row) => kinds[row.kind] ?? row.kind },
        { header: "Name", cell: (row) => <Badge value={row.name} /> },
        { header: "Summary", cell: (row) => <span className="truncate">{row.summary}</span> },
        { header: "Request", cell: (row) => <span className="mono dim">{row.request_id ?? ""}</span> },
        { header: "When", cell: (row) => <Time value={row.created_at} mode="absolute" /> },
      ]}
    />
  );
}
