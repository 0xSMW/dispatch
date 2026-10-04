import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Megaphone, Search } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { Code } from "../../components/Code";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Failed } from "../../components/Empty";
import { EventTimeline, type TimelineEvent } from "../../components/EventTimeline";
import { Facts } from "../../components/Facts";
import { Menu } from "../../components/Menu";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useAll, useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { BroadcastDetail, BroadcastRecipient, ClickedLink, List, Metrics, Segment, Topic } from "../../types";
import { Preview } from "../templates/editor";
import { contactField, fill, sampleContact } from "../templates/render";
import { useBrand } from "../templates/Versions";
import { deletable } from "./Broadcasts";
import "../../styles/editor.css";

export const recipientTabs = [
  { id: "opened", label: "Opened" },
  { id: "unsubscribed", label: "Unsubscribed" },
  { id: "bounced", label: "Bounced" },
  { id: "complained", label: "Complained" },
] as const;

type RecipientType = (typeof recipientTabs)[number]["id"];

export const statMetrics = [
  "sent", "delivered", "bounced", "unique_opened", "unique_clicked", "unsubscribed", "complained",
  "delivery_rate", "bounce_rate", "open_rate", "click_rate", "unsubscribe_rate", "complaint_rate",
];

/** Created, scheduled, sending, and finished, from the timestamps the API returns. */
export function timeline(row: BroadcastDetail): TimelineEvent[] {
  const events: TimelineEvent[] = [{ label: "Created", status: "draft", time: row.created_at }];
  if (row.scheduled_at) events.push({ label: "Scheduled", status: "scheduled", time: row.scheduled_at });
  if (row.status === "queued") events.push({ label: row.paused ? "Paused" : "Sending", status: row.paused ? "paused" : "sending", time: null });
  if (row.sent_at) events.push({ label: "Sent", status: "delivered", time: row.sent_at });
  if (row.status === "canceled") events.push({ label: "Canceled", status: "canceled", time: null });
  return events;
}

/** `GET /emails/metrics` for one broadcast, from just before it was created until now. */
export function metricsQuery(row: Pick<BroadcastDetail, "id" | "created_at">, now = new Date()) {
  return {
    broadcast_id: row.id,
    start_date: new Date(new Date(row.created_at).getTime() - 60_000).toISOString(),
    end_date: now.toISOString(),
    metrics: statMetrics.join(","),
  };
}

export function Broadcast() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const can = useCan();
  const navigate = useNavigate();
  const broadcast = useResource<BroadcastDetail>(`/broadcasts/${id}`);
  const segments = useAll<Segment>("/segments");
  const topics = useAll<Topic>("/topics");
  const brand = useBrand();
  const [confirm, setConfirm] = useState<"cancel" | "delete" | null>(null);
  const [content, setContent] = useState<"preview" | "html">("preview");
  const row = broadcast.data;

  const pause = useMutation(() => client.post<BroadcastDetail>(`/broadcasts/${id}/pause`), {
    success: "Broadcast paused.",
    onSuccess: (next) => broadcast.setData(next),
  });
  const resume = useMutation(() => client.post<BroadcastDetail>(`/broadcasts/${id}/resume`), {
    success: "Broadcast resumed.",
    onSuccess: (next) => broadcast.setData(next),
  });
  const duplicate = useMutation(() => client.post<BroadcastDetail>(`/broadcasts/${id}/duplicate`), {
    success: "Broadcast duplicated.",
    onSuccess: (copy) => navigate(`/broadcasts/${copy.id}/editor`),
  });

  const preview = useMemo(() => (row ? fill(row, { ...brand, ...sampleContact }, [], { blank: contactField }).html : ""), [row, brand]);

  if (broadcast.error) return <Failed message={broadcast.error} onRetry={broadcast.reload} />;
  const segment = segments.data?.data.find((item) => item.id === row?.segment_id);
  const topic = topics.data?.data.find((item) => item.id === row?.topic_id);
  const queued = row?.status === "queued";

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/broadcasts", label: "Broadcasts" }}
        icon={<Megaphone size={20} />}
        tone={row ? statusToVariant(row.paused ? "paused" : row.status) : "neutral"}
        label="Broadcast"
        title={row ? row.name : <Skeleton width="medium" />}
        actions={
          row && can ? (
            <>
              {row.status === "draft" ? (
                <Link className="button" to={`/broadcasts/${row.id}/editor`}>
                  Edit
                </Link>
              ) : null}
              {queued && !row.paused ? (
                <button type="button" className="secondary" disabled={pause.isLoading} onClick={() => void pause.mutate()}>
                  Pause
                </button>
              ) : null}
              {queued && row.paused ? (
                <button type="button" disabled={resume.isLoading} onClick={() => void resume.mutate()}>
                  Resume
                </button>
              ) : null}
              {queued || row.status === "scheduled" ? (
                <button type="button" className="secondary" onClick={() => setConfirm("cancel")}>
                  Cancel broadcast
                </button>
              ) : null}
              <Menu
                items={[
                  { label: "Duplicate", disabled: duplicate.isLoading, onSelect: () => void duplicate.mutate() },
                  { label: "Delete", danger: true, hidden: !deletable(row.status), onSelect: () => setConfirm("delete") },
                ]}
              />
            </>
          ) : null
        }
      />

      {row ? (
        <Facts
          items={[
            { label: "Status", value: <Badge value={row.paused ? "paused" : row.status} /> },
            { label: "Kind", value: <Badge value="marketing" label="Marketing" /> },
            { label: "From", value: row.from },
            { label: "Subject", value: row.subject },
            { label: "ID", value: row.id, copy: true },
            { label: "Segment", value: segment?.name ?? row.segment_id },
            { label: "Topic", value: topic?.name ?? row.topic_id },
            { label: "Recipients", value: row.recipient_count ? String(row.recipient_count) : null },
            { label: "Sent", value: row.sent_count ? String(row.sent_count) : null },
            { label: "Reply-To", value: row.reply_to?.join(", "), hidden: !row.reply_to?.length },
            { label: "Preview text", value: row.preview_text, hidden: !row.preview_text },
            { label: "Scheduled for", value: <Time value={row.scheduled_at} mode="absolute" />, hidden: !row.scheduled_at },
            { label: "Created", value: <Time value={row.created_at} mode="absolute" /> },
          ]}
        />
      ) : (
        <Skeleton lines={3} />
      )}

      {row ? (
        <Panel title="Status">
          <EventTimeline events={timeline(row)} />
        </Panel>
      ) : null}

      {row && row.status !== "draft" ? <Stats row={row} /> : null}
      {row && row.status !== "draft" ? <Recipients id={row.id} /> : null}
      {row && row.status !== "draft" ? <ClickedLinks id={row.id} /> : null}

      <Panel title="Email">
        <Tabs
          label="Email"
          value={content}
          onChange={setContent}
          tabs={[
            { id: "preview", label: "Preview" },
            { id: "html", label: "HTML" },
          ]}
        />
        {!row ? (
          <Skeleton lines={6} />
        ) : content === "preview" ? (
          row.html ? (
            <Preview html={preview} />
          ) : (
            <Code value={row.text ?? ""} language="text" empty={<p className="muted">No content.</p>} />
          )
        ) : (
          <Code value={row.html ?? ""} language="html" empty={<p className="muted">No HTML.</p>} />
        )}
      </Panel>

      {confirm === "cancel" && row ? (
        <ConfirmPhrase
          title="Cancel broadcast"
          body={
            row.status === "scheduled"
              ? "The broadcast goes back to draft and does not send."
              : "Emails not sent yet are dropped. Emails already sent stay sent."
          }
          phrase="CANCEL"
          action="Cancel broadcast"
          onConfirm={() => client.post<BroadcastDetail>(`/broadcasts/${row.id}/cancel`)}
          onClose={() => setConfirm(null)}
          onDone={() => {
            toast.success("Broadcast canceled.");
            void broadcast.reload();
          }}
        />
      ) : null}
      {confirm === "delete" && row ? (
        <ConfirmPhrase
          title="Delete broadcast"
          body={row.status === "scheduled" ? "Deleting a scheduled broadcast cancels the send." : `${row.name} will be deleted.`}
          phrase={row.name}
          action="Delete broadcast"
          onConfirm={() => client.delete(`/broadcasts/${row.id}`)}
          onClose={() => setConfirm(null)}
          onDone={() => {
            toast.success("Broadcast deleted.");
            navigate("/broadcasts");
          }}
        />
      ) : null}
    </div>
  );
}

// Two decimals: a 0.08% complaint rate is under the 0.1% line and must not read as "0.1%".
export function percent(value: number | undefined) {
  return `${(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function Stats({ row }: { row: BroadcastDetail }) {
  const client = useClient();
  const [state, setState] = useState<{ data: Metrics | null; error: string | null }>({ data: null, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    client
      .get<Metrics>("/emails/metrics", metricsQuery(row))
      .then((data) => live && setState({ data, error: null }))
      .catch((error: Error) => live && setState({ data: null, error: error.message }));
    return () => {
      live = false;
    };
  }, [client, row.id, row.created_at, attempt]);

  if (state.error) return <Failed message={state.error} onRetry={() => setAttempt((count) => count + 1)} />;
  const totals = state.data?.totals;
  const value = (count: string, rate: string, label: string) => (
    <div className="statValue">
      <strong>{totals ? (totals[count] ?? 0).toLocaleString() : <Skeleton width="short" />}</strong>
      <span>
        {label} {totals ? `· ${percent(totals[rate])}` : null}
      </span>
    </div>
  );

  return (
    <div className="statGrid" aria-label="Analytics">
      <section className="stat">
        <h3>Deliverability</h3>
        <div className="statPair">
          {value("delivered", "delivery_rate", "Delivered")}
          {value("bounced", "bounce_rate", "Bounced")}
        </div>
      </section>
      <section className="stat">
        <h3>Engagement</h3>
        <div className="statPair">
          {value("unique_opened", "open_rate", "Opened")}
          {value("unique_clicked", "click_rate", "Clicked")}
        </div>
      </section>
      <section className="stat">
        <h3>Opt-out</h3>
        <div className="statPair">
          {value("unsubscribed", "unsubscribe_rate", "Unsubscribed")}
          {value("complained", "complaint_rate", "Complained")}
        </div>
      </section>
    </div>
  );
}

function Recipients({ id }: { id: string }) {
  const [type, setType] = useState<RecipientType>("opened");
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setEmail(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const list = useList<BroadcastRecipient>(`/broadcasts/${id}/recipients`, { type, email }, { limit: 20 });

  return (
    <Panel
      title="Recipients"
      actions={
        <label className="searchBox">
          <Search size={15} aria-hidden />
          <input type="search" aria-label="Search recipients" placeholder="Search by email" value={text} onChange={(event) => setText(event.target.value)} />
        </label>
      }
    >
      <Tabs label="Recipient type" value={type} onChange={setType} tabs={[...recipientTabs]} />
      <Table
        compact
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => void list.reload()}
        empty={<p className="muted">No recipients {type} yet.</p>}
        page={list.page}
        hasMore={list.hasMore}
        onNext={list.next}
        onPrevious={list.previous}
        noun="recipients"
        columns={[
          {
            header: "Email",
            cell: (recipient) => (recipient.email_id ? <Link to={`/emails/${recipient.email_id}`}>{recipient.email}</Link> : recipient.email),
          },
          { header: "Status", cell: (recipient) => <Badge value={recipient.status} /> },
          { header: "Added", cell: (recipient) => <Time value={recipient.created_at} /> },
        ]}
      />
    </Panel>
  );
}

function ClickedLinks({ id }: { id: string }) {
  const list = useList<ClickedLink & { id: string }>(`/broadcasts/${id}/clicked-links`, {}, { limit: 20 });
  return (
    <Panel title="Top clicked links">
      <Table
        compact
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => void list.reload()}
        empty={<p className="muted">No clicks yet.</p>}
        page={list.page}
        hasMore={list.hasMore}
        onNext={list.next}
        onPrevious={list.previous}
        columns={[
          {
            header: "Link",
            cell: (link) =>
              /^https?:\/\//i.test(link.url) ? (
                <a className="truncate" href={link.url} target="_blank" rel="noreferrer noopener">
                  {link.url}
                </a>
              ) : (
                <span className="truncate mono">{link.url}</span>
              ),
          },
          { header: "Clicks", cell: (link) => link.clicks.toLocaleString() },
          { header: "Unique", cell: (link) => link.unique_clicks.toLocaleString() },
        ]}
      />
    </Panel>
  );
}
