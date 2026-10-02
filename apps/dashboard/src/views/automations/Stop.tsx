import { Modal } from "../../components/Modal";
import { useMutation } from "../../hooks/useMutation";
import { useClient } from "../../shell/session";
import type { Automation } from "../../types";

/** Confirms `POST /automations/:id/stop`, which also cancels the automation's runs in progress. */
export function StopAutomation({ automation, onClose, onDone }: { automation: Pick<Automation, "id" | "name">; onClose: () => void; onDone: (row: Automation) => void }) {
  const client = useClient();
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
      submitting={stop.isLoading}
      danger
      size="small"
    >
      <p className="muted">
        {automation.name} stops listening for its event, and runs in progress are cancelled. You can start it again later.
      </p>
    </Modal>
  );
}

export function isEnabled(row: Pick<Automation, "status" | "enabled">) {
  return (row.status ?? (row.enabled ? "enabled" : "disabled")) === "enabled";
}
