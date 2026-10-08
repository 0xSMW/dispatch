import { Link, useParams } from "react-router-dom";
import { CircleAlert, ScrollText } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { Code } from "../../components/Code";
import { Failed } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Time } from "../../components/Time";
import { useResource } from "../../hooks/useResource";
import type { LogDetail } from "../../types";
import "../../styles/operations.css";

/** The email a request created or touched: from the path, then from the response body's `id`. */
export function relatedEmail(log: Pick<LogDetail, "endpoint" | "response_body">): string | null {
  const fromPath = log.endpoint.match(/^\/emails\/(email_[A-Za-z0-9]+)/)?.[1];
  if (fromPath) return fromPath;
  const body = log.response_body as { id?: unknown } | null;
  return typeof body?.id === "string" && body.id.startsWith("email_") ? body.id : null;
}

/** The API's error message, from `{ message }` in an error response. */
export function errorText(log: Pick<LogDetail, "response_status" | "response_body">): string | null {
  if (log.response_status < 400) return null;
  const body = log.response_body as { message?: unknown; name?: unknown } | null;
  return typeof body?.message === "string" ? body.message : `The request failed with status ${log.response_status}.`;
}

export function Log() {
  const { id } = useParams<{ id: string }>();
  const log = useResource<LogDetail>(`/logs/${id}`);

  if (log.error) return <Failed message={log.error} onRetry={log.reload} />;
  const row = log.data;
  const email = row ? relatedEmail(row) : null;
  const error = row ? errorText(row) : null;

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/logs", label: "Logs" }}
        icon={<ScrollText size={20} />}
        tone={row ? statusToVariant(row.response_status) : "neutral"}
        label="Log"
        title={
          row ? (
            <span className="mono">
              {row.method} {row.endpoint}
            </span>
          ) : (
            <Skeleton width="medium" />
          )
        }
        actions={
          email ? (
            <Link className="button secondary" to={`/emails/${email}`}>
              View email
            </Link>
          ) : null
        }
      />

      {error ? (
        <div className="problem" role="alert">
          <CircleAlert size={16} aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}

      {row ? (
        <Facts
          items={[
            { label: "Endpoint", value: row.endpoint, mono: true },
            { label: "Date", value: <Time value={row.created_at} mode="absolute" /> },
            { label: "Status", value: <Badge value={row.response_status} /> },
            { label: "Method", value: row.method, mono: true },
            { label: "User-Agent", value: row.user_agent, mono: true },
            { label: "ID", value: row.id, copy: true },
          ]}
        />
      ) : (
        <Skeleton lines={3} />
      )}

      <Panel title="Response body">
        {row ? <Code value={row.response_body} language="json" empty={<p className="muted">Not saved. Dispatch doesn't store list responses or bodies over 64 KB.</p>} /> : <Skeleton lines={4} />}
      </Panel>
      <Panel title="Request body">
        {row ? <Code value={row.request_body} language="json" empty={<p className="muted">No request body.</p>} /> : <Skeleton lines={4} />}
      </Panel>
    </div>
  );
}
