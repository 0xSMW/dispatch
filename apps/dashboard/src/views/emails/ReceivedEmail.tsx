import { useState } from "react";
import { useParams } from "react-router-dom";
import { Download, Inbox } from "lucide-react";
import { Badge, type BadgeVariant } from "../../components/Badge";
import { Code } from "../../components/Code";
import { Empty, Failed } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { Menu } from "../../components/Menu";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { useResource } from "../../hooks/useResource";
import { useCan } from "../../shell/session";
import type { ReceivedEmailDetail } from "../../types";
import { Preview } from "./Preview";
import { Share } from "./Share";
import "../../styles/operations.css";

type Body = "preview" | "text" | "html" | "headers" | "attachments" | "raw";

const verdicts: Record<string, BadgeVariant> = {
  pass: "success",
  fail: "danger",
  permerror: "danger",
  softfail: "warning",
  temperror: "warning",
};

/** The SPF, DKIM, and DMARC results from the receiving server, as badges. */
export function Verdicts({ authentication }: { authentication: ReceivedEmailDetail["authentication"] }) {
  const entries = Object.entries(authentication ?? {}).filter(([, value]) => typeof value === "string" && value);
  if (entries.length === 0) return <span className="dim">Not checked</span>;
  return (
    <span className="chips">
      {entries.map(([name, value]) => (
        <Badge key={name} value={String(value)} label={`${name.toUpperCase()} ${String(value)}`} variant={verdicts[String(value).toLowerCase()] ?? "neutral"} />
      ))}
    </span>
  );
}

export function ReceivedEmail() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const email = useResource<ReceivedEmailDetail>(`/emails/receiving/${id}`);
  const [body, setBody] = useState<Body>("preview");
  const [sharing, setSharing] = useState(false);

  if (email.error) return <Failed message={email.error} onRetry={email.reload} />;
  const row = email.data;
  const files = row?.attachments ?? [];

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/emails/receiving", label: "Received" }}
        icon={<Inbox size={20} />}
        tone="info"
        label="Received email"
        title={row ? row.subject || "(no subject)" : <Skeleton width="medium" />}
        actions={
          row ? (
            <>
              {row.raw ? (
                <a className="button secondary" href={row.raw.download_url} rel="noreferrer" download="message.eml">
                  <Download size={14} /> Raw
                </a>
              ) : null}
              {can ? <Menu label="Email actions" items={[{ label: "Share email", onSelect: () => setSharing(true) }]} /> : null}
            </>
          ) : null
        }
      />

      {row ? (
        <Facts
          items={[
            { label: "From", value: row.from },
            { label: "To", value: row.to.join(", ") },
            { label: "Subject", value: row.subject },
            { label: "ID", value: row.id, copy: true },
            { label: "CC", value: (row.cc ?? []).join(", "), hidden: !row.cc?.length },
            { label: "Reply-To", value: (row.reply_to ?? []).join(", "), hidden: !row.reply_to?.length },
            { label: "Received", value: <Time value={row.created_at} mode="absolute" /> },
            { label: "Authentication", value: <Verdicts authentication={row.authentication} /> },
            { label: "Message ID", value: row.message_id ?? null, mono: true, hidden: !row.message_id },
          ]}
        />
      ) : (
        <Skeleton lines={3} />
      )}

      <Panel>
        <Tabs<Body>
          label="Email body"
          tabs={[
            { id: "preview", label: "Preview" },
            { id: "text", label: "Plain text" },
            { id: "html", label: "HTML" },
            { id: "headers", label: "Headers" },
            { id: "attachments", label: "Attachments", count: files.length },
            { id: "raw", label: "Raw" },
          ]}
          value={body}
          onChange={setBody}
        />
        {!row ? (
          <Skeleton lines={4} />
        ) : body === "preview" ? (
          <Preview html={row.html} untrusted />
        ) : body === "text" ? (
          <Code value={row.text} language="text" empty={<Empty title="No plain text part" />} />
        ) : body === "html" ? (
          <Code value={row.html} language="html" empty={<Empty title="No HTML part" />} />
        ) : body === "headers" ? (
          <Table
            compact
            rows={Object.entries(row.headers ?? {}).map(([name, value]) => ({ id: name, name, value: String(value) }))}
            empty={<p className="muted">No headers.</p>}
            columns={[
              { header: "Name", cell: (header) => <span className="mono">{header.name}</span> },
              { header: "Value", cell: (header) => <span className="mono wrapText">{header.value}</span> },
            ]}
          />
        ) : body === "attachments" ? (
          <Table
            compact
            rows={files}
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
              { header: "Size", cell: (file) => `${file.size ?? 0} bytes` },
            ]}
          />
        ) : row.raw ? (
          <div className="stack">
            <p className="muted">
              The original MIME message as the server received it. The link expires <Time value={row.raw.expires_at} />.
            </p>
            <a className="button secondary" href={row.raw.download_url} rel="noreferrer" download="message.eml">
              <Download size={14} /> Download message.eml
            </a>
          </div>
        ) : (
          <Empty title="No raw message" body="Dispatch kept no raw MIME copy of this email." />
        )}
      </Panel>

      {sharing && row ? <Share emailId={row.id} onClose={() => setSharing(false)} /> : null}
    </div>
  );
}
