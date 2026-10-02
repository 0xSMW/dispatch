import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { GitBranch } from "lucide-react";
import { Badge } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { Empty } from "../../components/Empty";
import { Field } from "../../components/Field";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useBulkKeys } from "../../hooks/useBulkKeys";
import { useFilters } from "../../hooks/useFilters";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useSelection } from "../../hooks/useSelection";
import { each } from "../../lib/bulk";
import { errorMessage } from "../../lib/client";
import { useClient } from "../../shell/session";
import type { Automation, EventDefinition } from "../../types";
import { automationTabs } from "../tabs";
import { EventInput } from "./Steps";
import { StopAutomation, isEnabled } from "./Stop";

export const automationCsv: Array<CsvColumn<Automation>> = [
  { header: "id", value: (row) => row.id },
  { header: "name", value: (row) => row.name },
  { header: "status", value: (row) => isEnabled(row) ? "enabled" : "disabled" },
  { header: "trigger", value: (row) => row.trigger },
  { header: "runs", value: (row) => row.run_count },
  { header: "created_at", value: (row) => row.created_at },
];

/** `/automations`: the list, with status filter, create, duplicate, start and stop, and delete. */
export function Automations() {
  const client = useClient();
  const navigate = useNavigate();
  const filters = useFilters(["status"]);
  const list = useList<Automation>("/automations", filters);
  const selection = useSelection(list.rows.map((row) => row.id));
  const [creating, setCreating] = useState(false);
  const [stopping, setStopping] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState<Automation[] | null>(null);
  const deleteSelected = () => setDeleting(list.rows.filter((row) => selection.has(row.id)));
  useBulkKeys(selection, list.rows.length, deleteSelected);

  const start = useMutation((row: Automation) => client.patch<Automation>(`/automations/${row.id}`, { status: "enabled" }), {
    success: "Automation started.",
    onSuccess: () => list.reload(),
  });
  const duplicate = useMutation((row: Automation) => client.post<Automation>(`/automations/${row.id}/duplicate`), {
    success: "Automation duplicated.",
    onSuccess: (copy) => navigate(`/automations/${copy.id}/editor`),
  });

  return (
    <ListPage
      title="Automations"
      tabs={automationTabs}
      actions={
        <button type="button" onClick={() => setCreating(true)}>
          Create automation
        </button>
      }
      filters={[{ param: "status", label: "Status", options: ["enabled", "disabled"], all: "All statuses" }]}
      filterExtra={<CsvExport rows={list.rows} columns={automationCsv} name="automations" />}
      list={list}
      noun="automations"
      rowHref={(row) => `/automations/${row.id}/editor`}
      selection={selection}
      bulkActions={[
        { label: "Delete", hint: "⌫", danger: true, onClick: deleteSelected },
      ]}
      empty={
        filters.status ? (
          <Empty title="No automations" body={`No automations are ${filters.status}.`} />
        ) : (
          <Empty title="No automations" body="An automation runs steps when your app sends an event. Create one to get started." />
        )
      }
      columns={[
        {
          header: "Name",
          cell: (row) => (
            <span className="cellMain">
              <Tile tone={isEnabled(row) ? "success" : "neutral"}>
                <GitBranch size={14} />
              </Tile>
              {row.name}
            </span>
          ),
        },
        { header: "Trigger", cell: (row) => <span className="mono">{row.trigger ?? ""}</span> },
        { header: "Status", cell: (row) => <Badge value={isEnabled(row) ? "enabled" : "disabled"} /> },
        { header: "Runs", cell: (row) => (row.run_count ?? 0).toLocaleString() },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          items={[
            { label: "Open builder", read: true, onSelect: () => navigate(`/automations/${row.id}/editor`) },
            { label: "View runs", read: true, onSelect: () => navigate(`/automations/${row.id}/editor?tab=runs`) },
            { label: "Duplicate", onSelect: () => void duplicate.mutate(row) },
            isEnabled(row)
              ? { label: "Stop", onSelect: () => setStopping(row) }
              : { label: "Start", onSelect: () => void start.mutate(row) },
            "divider",
            { label: "Delete", danger: true, onSelect: () => setDeleting([row]) },
          ]}
        />
      )}
    >
      {creating ? <CreateAutomation onClose={() => setCreating(false)} /> : null}
      {stopping ? <StopAutomation automation={stopping} onClose={() => setStopping(null)} onDone={() => void list.reload()} /> : null}
      {deleting ? (
        <ConfirmPhrase
          title={deleting.length === 1 ? "Delete automation" : `Delete ${deleting.length} automations`}
          body={
            deleting.length === 1
              ? `${deleting[0]!.name} and its runs in progress stop for good.`
              : "These automations and their runs in progress stop for good."
          }
          phrase={deleting.length === 1 ? deleting[0]!.name : `DELETE ${deleting.length} AUTOMATIONS`}
          action={deleting.length === 1 ? "Delete automation" : "Delete automations"}
          onConfirm={async () => {
            // One already deleted on an earlier try counts as done.
            const failed = await each(deleting, (row) => client.delete(`/automations/${row.id}`), { gone: true });
            if (failed.length) throw new Error(`${failed.length} of ${deleting.length} could not be deleted: ${errorMessage(failed[0])}`);
          }}
          onClose={() => setDeleting(null)}
          onDone={() => {
            toast.success(deleting.length === 1 ? "Automation deleted." : "Automations deleted.");
            selection.clear();
            void list.reload();
          }}
        />
      ) : null}
    </ListPage>
  );
}

/** Creates a disabled automation with only its trigger, then opens the builder. */
function CreateAutomation({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const navigate = useNavigate();
  const events = useList<EventDefinition>("/events", {}, { all: true });
  const [name, setName] = useState("");
  const [event, setEvent] = useState("");
  const create = useMutation(
    () =>
      client.post<Automation>("/automations", {
        name: name.trim(),
        steps: [{ key: "trigger", type: "trigger", config: { event_name: event.trim() } }],
        connections: [],
      }),
    {
      success: "Automation created.",
      onSuccess: (row) => {
        onClose();
        navigate(`/automations/${row.id}/editor`);
      },
    },
  );

  return (
    <Modal
      isOpen
      title="Create automation"
      onClose={onClose}
      onSubmit={() => void create.mutate()}
      submitLabel="Create"
      submitDisabled={!name.trim() || !event.trim()}
      submitting={create.isLoading}
    >
      <div className="form">
        <Field label="Name" value={name} onChange={setName} placeholder="Welcome series" required autoFocus />
        <EventInput
          label="Trigger event"
          value={event}
          onChange={setEvent}
          events={events.rows.map((row) => row.name)}
          hint="The automation runs each time your app sends this event."
        />
        <p className="fieldHint">New automations start disabled. Add steps in the builder, then start it.</p>
      </div>
    </Modal>
  );
}
