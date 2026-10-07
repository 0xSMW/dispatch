import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../components/Badge";
import { Failed } from "../../components/Empty";
import { Select } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Skeleton } from "../../components/Skeleton";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { Automation, EnrollmentJob, Segment } from "../../types";
import { automationTrigger } from "./graph";
import { isEnabled } from "./Stop";

export function canEnroll(automation: Automation) {
  return isEnabled(automation) && automationTrigger(automation).type !== "event";
}

export const jobActive = (status: EnrollmentJob["status"]) => status === "queued" || status === "in_progress";

/** The same action in the list and both builder views. Existing jobs are also readable by viewers. */
export function Enroll({ automation, jobId, onJob, onClose }: {
  automation: Automation;
  jobId?: string | null;
  onJob?: (id: string) => void;
  onClose: () => void;
}) {
  const can = useCan();
  const client = useClient();
  const segments = useList<Segment>("/segments", {}, { all: true });
  const [audience, setAudience] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const id = jobId ?? created;
  const allowed = can && canEnroll(automation);
  const valid = allowed && (audience === "all" || (!segments.loading && !segments.error && segments.rows.some((row) => row.id === audience)));
  const start = useMutation(() => client.post<EnrollmentJob>(`/automations/${automation.id}/enroll`,
    audience === "all" ? { all: true } : { segment_id: audience }, { idempotencyKey: `${requestKey}:${audience}` }), {
    onSuccess: (job) => { setCreated(job.id); onJob?.(job.id); },
  });

  return (
    <Modal isOpen title={id ? "Enrollment progress" : "Enroll contacts"} onClose={onClose}
      onSubmit={!id && allowed ? () => { if (valid && !start.isLoading) void start.mutate(); } : undefined}
      submitLabel="Enroll contacts" submitDisabled={!valid} submitting={start.isLoading}>
      {id ? <EnrollmentProgress key={id} automationId={automation.id} id={id} /> : !allowed ? (
        <p className="muted">Only enabled, non-event automations can enroll contacts, and a full-access role is required.</p>
      ) : (
        <div className="form">
          <p className="muted">Enroll existing contacts in {automation.name}. Lifetime re-entry rules still apply.</p>
          <Select label="Audience" value={audience} onChange={setAudience} disabled={start.isLoading}
            placeholder="Choose an audience"
            options={[{ value: "all", label: "All contacts" }, ...(!segments.error && !segments.loading ? segments.rows.filter((row) => row.type !== "dynamic").map((row) => ({ value: row.id, label: row.name })) : [])]} />
          {segments.loading ? <p className="fieldHint">Loading segments…</p> : null}
          {segments.error ? <div role="alert">Could not load segments: {segments.error} <button type="button" className="secondary small" onClick={() => void segments.reload()}>Retry</button></div> : null}
          <p className="notice warning">This can send emails immediately.</p>
          {automationTrigger(automation).type === "contact_updated" ? <p className="fieldHint">Enrollment for contact_updated ignores from/to transition filters and uses the contact's current values.</p> : null}
          {start.error ? <p className="fieldError" role="alert">{start.error.message}</p> : null}
        </div>
      )}
    </Modal>
  );
}

export function EnrollmentProgress({ automationId, id }: { automationId: string; id: string }) {
  const path = `/automations/${automationId}/enroll-jobs/${id}`;
  const run = useResource<EnrollmentJob>(path);
  const client = useClient();
  const can = useCan();
  const active = run.data ? jobActive(run.data.status) : false;
  const cancel = useMutation(() => client.delete<EnrollmentJob>(path), { onSuccess: run.setData });
  useEffect(() => {
    if (!active || run.loading || cancel.isLoading) return;
    const timer = setTimeout(() => void run.reload(), run.error ? 5000 : 1500);
    return () => clearTimeout(timer);
  }, [active, run.loading, run.error, run.data, run.reload, cancel.isLoading]);

  if (run.error && !run.data) return <Failed message={run.error} onRetry={run.reload} />;
  if (!run.data) return <Skeleton lines={3} />;
  const { status, counts } = run.data;
  const share = counts.total ? Math.min(100, Math.round(counts.processed / counts.total * 100)) : 0;
  return (
    <div className="stack">
      <Badge value={status} label={status.replace("_", " ")} />
      <Link to={`/automations/${automationId}/editor?enroll_job=${id}`}>Open this enrollment job</Link>
      <div className="progress" role="progressbar" aria-label="Enrollment progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
        <div className="progressFill" style={{ width: `${share}%` }} />
      </div>
      <dl className="statStrip five">
        {(["total", "processed", "enrolled", "skipped", "failed"] as const).map((key) => <div className="stat" key={key}><dt>{key}</dt><dd>{counts[key].toLocaleString()}</dd></div>)}
      </dl>
      {run.data.error ? <p className="fieldError" role="alert">{run.data.error}</p> : null}
      {run.error ? <p className="fieldError" role="alert">Could not refresh progress: {run.error}{active ? " Retrying." : ""}</p> : null}
      {cancel.error ? <p className="fieldError" role="alert">{cancel.error.message}</p> : null}
      <p className="fieldHint">Cancellation stops future batches, not runs already enrolled.</p>
      {can && active ? <button type="button" className="secondary" disabled={run.loading || cancel.isLoading} onClick={() => { if (can && active && !run.loading && !cancel.isLoading) void cancel.mutate(); }}>Cancel enrollment</button> : null}
    </div>
  );
}
