import { useState } from "react";
import { Modal } from "../../components/Modal";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { Automation, RunMetrics } from "../../types";

/** Confirms `POST /automations/:id/stop`, which also cancels the automation's runs in progress. */
export function StopAutomation({ automation, onClose, onDone }: { automation: Pick<Automation, "id" | "name">; onClose: () => void; onDone: (row: Automation) => void }) {
  const client = useClient();
  const can = useCan();
  const [resetReentry, setResetReentry] = useState(false);
  const counts = useResource<RunMetrics>(`/automations/${automation.id}/runs/metrics?start_date=1970-01-01T00%3A00%3A00.000Z`);
  const running = counts.data?.totals?.running;
  const blocked = !can || counts.loading || !!counts.error || running === undefined;
  const stop = useMutation(() => client.post<Automation>(`/automations/${automation.id}/stop`, { reset_reentry: resetReentry }), {
    success: "Automation stopped.",
    onSuccess: (row) => {
      onDone(row);
      onClose();
    },
  });
  return (
    <Modal
      isOpen
      title="Stop and cancel runs"
      onClose={onClose}
      onSubmit={() => { if (!blocked && !stop.isLoading) void stop.mutate(); }}
      submitLabel="Stop and cancel runs"
      submitDisabled={blocked}
      submitting={stop.isLoading}
      danger
      size="small"
    >
      <p className="muted">
        {automation.name} stops accepting new triggers and cancels every run in progress, including runs waiting on a delay or event.
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
      <label className="check">
        <input type="checkbox" checked={resetReentry} disabled={!can || stop.isLoading} onChange={(event) => setResetReentry(event.target.checked)} />
        Let cancelled contacts enter again
      </label>
      <p className="fieldHint">Clears the once-per-contact entry record only for contacts whose runs are cancelled by this stop.</p>
      <p className="muted">Starting again accepts future triggers. It does not restore cancelled runs. The count may change before you stop.</p>
    </Modal>
  );
}

export function isEnabled(row: Pick<Automation, "status" | "enabled">) {
  return (row.status ?? (row.enabled ? "enabled" : "disabled")) === "enabled";
}
