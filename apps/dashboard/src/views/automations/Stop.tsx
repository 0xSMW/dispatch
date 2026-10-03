import { Modal } from "../../components/Modal";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useClient } from "../../shell/session";
import type { Automation, RunMetrics } from "../../types";

/** Confirms `POST /automations/:id/stop`, which also cancels the automation's runs in progress. */
export function StopAutomation({ automation, onClose, onDone }: { automation: Pick<Automation, "id" | "name">; onClose: () => void; onDone: (row: Automation) => void }) {
  const client = useClient();
  const counts = useResource<RunMetrics>(`/automations/${automation.id}/runs/metrics?start_date=1970-01-01T00%3A00%3A00.000Z`);
  const running = counts.data?.totals.running;
  const stop = useMutation(() => client.post<Automation>(`/automations/${automation.id}/stop`), {
    success: "Automation stopped.",
    onSuccess: (row) => {
      onDone(row);
      onClose();
    },
  });
  return (
    <Modal
      isOpen
      title="Stop automation"
      onClose={onClose}
      onSubmit={() => void stop.mutate()}
      submitLabel="Stop"
      submitDisabled={counts.loading || !!counts.error || running === undefined}
      submitting={stop.isLoading}
      danger
      size="small"
    >
      <p className="muted">
        {automation.name} stops listening for its event and cancels every run in progress, including runs waiting on a delay or event.
      </p>
      {counts.error ? (
        <div role="alert">
          <p>Could not load the run count: {counts.error}</p>
          <button type="button" className="secondary" onClick={() => void counts.reload()}>Retry</button>
        </div>
      ) : (
        <p className="muted" role="status">
          {running === undefined ? "Loading runs in progress…" : `${running.toLocaleString()} ${running === 1 ? "run" : "runs"} in progress will be cancelled.`}
        </p>
      )}
      <p className="muted">Starting again accepts future events. It does not restore cancelled runs. The count may change before you stop.</p>
    </Modal>
  );
}

export function isEnabled(row: Pick<Automation, "status" | "enabled">) {
  return (row.status ?? (row.enabled ? "enabled" : "disabled")) === "enabled";
}
