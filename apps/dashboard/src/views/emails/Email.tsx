import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Mail, Paperclip } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { Checks, type CheckRow } from "../../components/Checks";
import { Code } from "../../components/Code";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Empty, Failed } from "../../components/Empty";
import { EventTimeline, type TimelineEvent } from "../../components/EventTimeline";
import { Facts } from "../../components/Facts";
import { Field } from "../../components/Field";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useMutation } from "../../hooks/useMutation";
import { useAll, useResource } from "../../hooks/useResource";
import { usable, useWhen, whenHint } from "../../lib/when";
import { useCan, useClient } from "../../shell/session";
import type { Attachment, Email as EmailRow, EmailEvent, EmailInsights, List } from "../../types";
import { cancelable, retryable } from "./Emails";
import { Preview } from "./Preview";
import { problemOf, ProblemBanner } from "./Problem";
import { Share } from "./Share";
import { Sandbox, sandboxHint } from "./Sandbox";
import "../../styles/operations.css";

type Body = "preview" | "text" | "html" | "attachments" | "insights";

/** One timeline node per event. Bounces and failures carry their reason on hover. */
export function timeline(events: EmailEvent[]): TimelineEvent[] {
  return events.map((event) => {
    const data = event.data ?? {};
    const simulated = data.sandbox === true;
    const bounce = data.bounce as { type?: string; subType?: string; message?: string } | undefined;
    const failed = data.failed as { reason?: string } | undefined;
    const suppressed = data.suppressed as { message?: string } | undefined;
    const click = data.click as { link?: string } | undefined;
    const detail = bounce
      ? [bounce.type, bounce.subType, bounce.message].filter(Boolean).join(" · ")
      : (failed?.reason ?? suppressed?.message ?? click?.link ?? (Array.isArray(data.recipients) ? `To ${(data.recipients as string[]).join(", ")}` : undefined));
    return {
      id: event.id,
      label: event.type.replace(/^email\./, "").replaceAll("_", " ") + (simulated ? " (simulated)" : ""),
      status: event.type,
      time: event.created_at,
      detail: simulated ? [sandboxHint, detail].filter(Boolean).join(" ") : detail || undefined,
    };
  });
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Email() {
  const can = useCan();
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const navigate = useNavigate();
  const email = useResource<EmailRow>(`/emails/${id}`);
  const events = useAll<EmailEvent>(`/emails/${id}/events`);
  const attachments = useAll<Attachment>(`/emails/${id}/attachments`);
  const [body, setBody] = useState<Body>("preview");
  const insights = useResource<EmailInsights>(body === "insights" ? `/emails/${id}/insights` : null);
  const [dialog, setDialog] = useState<"share" | "schedule" | "cancel" | null>(null);

  const reload = () => {
    void email.reload();
    void events.reload();
  };
  const retry = useMutation(() => client.post(`/emails/${id}/retry`), { success: "Email queued again.", onSuccess: reload });

  if (email.error) return <Failed message={email.error} onRetry={email.reload} />;
  const row = email.data;
  const list = events.data?.data ?? [];
  const files = attachments.data?.data ?? [];
  const last = [...list].reverse().find((event) => event.type === "email.bounced" || event.type === "email.suppressed");
  const problem = row && last && ["bounced", "suppressed"].includes(row.last_event) ? problemOf(last, row.to) : null;

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/emails", label: "Emails" }}
        icon={<Mail size={20} />}
        tone={row ? statusToVariant(row.last_event) : "neutral"}
        label="Email"
        title={row ? row.to.join(", ") || row.subject : <Skeleton width="medium" />}
        actions={
          row ? (
            <>
              <Badge value={row.last_event} />
              {row.sandbox ? <Sandbox /> : null}
              <Menu
                label="Email actions"
                items={[
                  { label: "Share email", hidden: !can, onSelect: () => setDialog("share") },
                  { label: "View logs", onSelect: () => navigate(`/logs?email_id=${row.id}`) },
                  { label: "Edit schedule", hidden: !can || !cancelable(row), onSelect: () => setDialog("schedule") },
                  { label: "Retry", hidden: !can || !retryable(row), onSelect: () => void retry.mutate() },
                  { label: "Cancel send", danger: true, hidden: !can || !cancelable(row), onSelect: () => setDialog("cancel") },
                ]}
              />
            </>
          ) : null
        }
      />

      {problem ? <ProblemBanner problem={problem} /> : null}

      {row?.sandbox ? <p className="muted">{sandboxHint}</p> : row?.recipients?.some((recipient) => recipient.sandbox) ? (
        <p className="muted">Sandbox recipients are simulated and are never sent externally. Other recipients follow normal delivery.</p>
      ) : null}

      {row ? (
        <Facts
          items={[
            { label: "From", value: row.from },
            { label: "Subject", value: row.subject },
            { label: "To", value: row.to.join(", ") },
            { label: "ID", value: row.id, copy: true },
            { label: "CC", value: row.cc.join(", "), hidden: row.cc.length === 0 },
            { label: "BCC", value: row.bcc.join(", "), hidden: row.bcc.length === 0 },
            { label: "Reply-To", value: row.reply_to.join(", "), hidden: row.reply_to.length === 0 },
            { label: "Scheduled at", value: <Time value={row.scheduled_at} mode="absolute" />, hidden: !row.scheduled_at },
            { label: "Created", value: <Time value={row.created_at} mode="absolute" /> },
            { label: "Message ID", value: row.message_id, mono: true, hidden: !row.message_id },
            {
              label: "Attachments",
              hidden: files.length === 0,
              value: (
                <span className="chips">
                  {files.map((file) =>
                    file.download_url ? (
                      <a key={file.id} className="chip fileChip" href={file.download_url} rel="noreferrer" download={file.filename}>
                        <Paperclip size={12} aria-hidden />
                        {file.filename}
                      </a>
                    ) : (
                      <span key={file.id} className="chip fileChip">
                        {file.filename}
                      </span>
                    ),
                  )}
                </span>
              ),
            },
          ]}
        />
      ) : (
        <Skeleton lines={3} />
      )}

      {row?.recipients?.length ? (
        <Panel title="Recipients">
          <Table
            compact
            rows={row.recipients}
            columns={[
              { header: "Email", cell: (recipient) => recipient.email },
              { header: "Kind", cell: (recipient) => recipient.kind.toUpperCase() },
              { header: "Status", cell: (recipient) => <span className="inline"><Badge value={recipient.status} />{recipient.sandbox ? <Sandbox /> : null}</span> },
            ]}
          />
        </Panel>
      ) : null}

      <Panel title="Events">
        {events.error ? (
          <Failed message={events.error} onRetry={events.reload} />
        ) : (
          <EventTimeline events={timeline(list)} empty={<p className="muted">{events.loading ? "Loading events." : "No events yet."}</p>} />
        )}
      </Panel>

      <Panel>
        <Tabs<Body>
          label="Email body"
          tabs={[
            { id: "preview", label: "Preview" },
            { id: "text", label: "Plain text" },
            { id: "html", label: "HTML" },
            { id: "attachments", label: "Attachments", count: files.length },
            { id: "insights", label: "Insights" },
          ]}
          value={body}
          onChange={setBody}
        />
        {!row ? (
          <Skeleton lines={4} />
        ) : body === "preview" ? (
          <Preview html={row.html} />
        ) : body === "text" ? (
          <Code value={row.text} language="text" empty={<Empty title="No plain text version" body="Add a plain text version when you send, for email apps that can't show HTML." />} />
        ) : body === "html" ? (
          <Code value={row.html} language="html" empty={<Empty title="No HTML version" />} />
        ) : body === "attachments" ? (
          <Table
            compact
            rows={files}
            loading={attachments.loading}
            error={attachments.error}
            onRetry={attachments.reload}
            empty={<p className="muted">No attachments.</p>}
            columns={[
              {
                header: "File",
                cell: (file) =>
                  file.download_url ? (
                    <a href={file.download_url} rel="noreferrer" download={file.filename}>
                      {file.filename}
                    </a>
                  ) : (
                    file.filename
                  ),
              },
              { header: "Type", cell: (file) => <span className="mono">{file.content_type}</span> },
              { header: "Size", cell: (file) => size(file.size) },
              { header: "Link expires", cell: (file) => <Time value={file.expires_at} /> },
            ]}
          />
        ) : (
          <Insights state={insights} />
        )}
      </Panel>

      {dialog === "share" && row ? <Share emailId={row.id} onClose={() => setDialog(null)} /> : null}
      {dialog === "schedule" && row ? <Reschedule email={row} onClose={() => setDialog(null)} onDone={reload} /> : null}
      {dialog === "cancel" && row ? (
        <ConfirmPhrase
          title="Cancel email"
          body={`The email to ${row.to.join(", ")} will not be sent.`}
          phrase="CANCEL"
          action="Cancel email"
          onConfirm={() => client.post(`/emails/${row.id}/cancel`)}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast.success("Email canceled.");
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function Reschedule({ email, onClose, onDone }: { email: EmailRow; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [when, setWhen] = useState(email.scheduled_at ?? "");
  // Read in the browser's zone and shown before saving. The API gets the exact instant.
  const schedule = useWhen(when);
  const save = useMutation(() => client.patch(`/emails/${email.id}`, { scheduled_at: schedule.when!.date.toISOString() }), {
    success: "Schedule updated.",
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal isOpen title="Edit schedule" onClose={onClose} onSubmit={() => void save.mutate()} submitLabel="Save" submitDisabled={!usable(schedule)} submitting={save.isLoading} size="small">
      <div className="form">
        <Field label="Send at" value={when} onChange={setWhen} placeholder="in 1 hour" hint={whenHint(when, schedule)} required autoFocus />
      </div>
    </Modal>
  );
}

const groups: Array<{ key: keyof Omit<EmailInsights, "object" | "email_id">; title: string; tone: CheckRow["tone"] }> = [
  { key: "needs_attention", title: "Needs attention", tone: "fail" },
  { key: "possible_improvements", title: "Possible improvements", tone: "warn" },
  { key: "doing_great", title: "Doing great", tone: "ok" },
];

function Insights({ state }: { state: { data: EmailInsights | null; loading: boolean; error: string | null; reload: () => Promise<void> } }) {
  return (
    <Checks
      rows={groups.flatMap((group) => (state.data?.[group.key] ?? []).map((item): CheckRow => ({
        id: item.id,
        group: group.key,
        tone: group.tone,
        text: item.title,
        detail: item.detail,
      })))}
      groups={groups.map((group) => ({ id: group.key, title: group.title, tone: group.tone }))}
      loading={!state.data}
      error={state.error}
      onRetry={state.reload}
    />
  );
}
