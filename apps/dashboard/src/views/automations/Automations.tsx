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
import { learnLinks } from "../../lib/docs";
import { useCan, useClient } from "../../shell/session";
import type { Automation, ContactProperty, EventDefinition, Segment, Topic } from "../../types";
import { Presets } from "./Presets";
import { automationTrigger, triggerIssues, triggerLabels, triggerSummary, triggerWarning, type TriggerConfig } from "./graph";
import { ReentryContext, TriggerForm, triggerLoading, triggerSources, type Reentry } from "./Trigger";
import { StopAutomation, isEnabled } from "./Stop";
import { Enroll, canEnroll } from "./Enroll";

export const automationCsv: Array<CsvColumn<Automation>> = [
  { header: "id", value: (row) => row.id },
  { header: "name", value: (row) => row.name },
  { header: "status", value: (row) => row.status ?? (row.enabled ? "enabled" : "disabled") },
  { header: "trigger", value: (row) => {
    const config = automationTrigger(row);
    return config.type === "event" ? config.event_name : `${triggerLabels[config.type]}: ${triggerSummary(config)}`;
  } },
  { header: "runs", value: (row) => row.run_count },
  { header: "created_at", value: (row) => row.created_at },
];

/** `/automations`: the list, with status filter and automation controls. */
export function Automations() {
  const client = useClient();
  const can = useCan();
  const navigate = useNavigate();
  const filters = useFilters(["status"]);
  const list = useList<Automation>("/automations", filters);
  const topics = useList<Topic>("/topics", {}, { all: true });
  const segments = useList<Segment>("/segments", {}, { all: true });
  const sources = {
    topics: !topics.loading && !topics.error ? topics.rows.map((row) => ({ value: row.id, label: row.name })) : undefined,
    segments: !segments.loading && !segments.error ? segments.rows.map((row) => ({ value: row.id, label: row.name })) : undefined,
    staticSegments: !segments.loading && !segments.error ? segments.rows.filter((row) => row.type !== "dynamic").map((row) => ({ value: row.id, label: row.name })) : undefined,
  };
  const cannotStart = (row: Automation) => {
    const config = automationTrigger(row);
    return Boolean(triggerWarning(config, sources))
      || (config.type === "topic_subscribed" && !sources.topics)
      || (config.type === "segment_added" && !sources.segments);
  };
  const selection = useSelection(list.rows.map((row) => row.id));
  const [creating, setCreating] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [stopping, setStopping] = useState<Automation | null>(null);
  const [enrolling, setEnrolling] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState<Automation[] | null>(null);
  const deleteSelected = () => setDeleting(list.rows.filter((row) => selection.has(row.id)));
  useBulkKeys(selection, list.rows.length, deleteSelected);

  const start = useMutation((row: Automation) => client.patch<Automation>(`/automations/${row.id}`, { status: "enabled" }), {
    onSuccess: (_result, row) => {
      toast.success(row.status === "paused" ? "Automation resumed." : "Automation started.");
      void list.reload();
    },
  });
  const pause = useMutation((row: Automation) => client.patch<Automation>(`/automations/${row.id}`, { status: "paused" }), {
    success: "Automation paused.",
    onSuccess: () => list.reload(),
  });
  const duplicate = useMutation((row: Automation) => client.post<Automation>(`/automations/${row.id}/duplicate`), {
    success: "Automation duplicated.",
    onSuccess: (copy) => navigate(`/automations/${copy.id}/editor`),
  });

  return (
    <ListPage
      title="Automations"
      learn={learnLinks("automations")}
      actions={
        <button type="button" onClick={() => setChoosing(true)}>
          Create automation
        </button>
      }
      filters={[{ param: "status", label: "Status", options: ["enabled", "paused", "disabled"], all: "All statuses" }]}
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
          <Empty title="No automations" body="Start with a lifecycle stage or build your own automation."
            action={can ? <button type="button" onClick={() => setChoosing(true)}>Choose a starting point</button> : null} />
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
        { header: "Trigger", cell: (row) => {
          const config = automationTrigger(row);
          const warning = triggerWarning(config, sources);
          return <span title={warning ?? undefined}>{config.type === "event" ? config.event_name : `${triggerLabels[config.type]}: ${triggerSummary(config, sources)}`}{warning ? <span className="fieldError"> · {warning}</span> : null}</span>;
        } },
        { header: "Status", cell: (row) => <Badge value={row.status ?? (row.enabled ? "enabled" : "disabled")} /> },
        { header: "Runs", cell: (row) => (row.run_count ?? 0).toLocaleString() },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          items={[
            { label: "Open builder", read: true, onSelect: () => navigate(`/automations/${row.id}/editor`) },
            { label: "View runs", read: true, onSelect: () => navigate(`/automations/${row.id}/editor?tab=runs`) },
            { label: "Duplicate", onSelect: () => void duplicate.mutate(row) },
            ...(can && canEnroll(row) ? [{ label: "Enroll contacts", onSelect: () => setEnrolling(row) }] : []),
            ...(isEnabled(row)
              ? [
                { label: "Pause", disabled: pause.isLoading || start.isLoading, onSelect: () => void pause.mutate(row) },
                { label: "Stop and cancel runs", onSelect: () => setStopping(row) },
              ]
              : row.status === "paused"
                ? [
                  { label: "Resume", disabled: cannotStart(row) || start.isLoading || pause.isLoading, onSelect: () => void start.mutate(row) },
                  { label: "Stop and cancel runs", onSelect: () => setStopping(row) },
                ]
                : [{ label: "Start", disabled: cannotStart(row) || start.isLoading, onSelect: () => void start.mutate(row) }]),
            "divider",
            { label: "Delete", danger: true, onSelect: () => setDeleting([row]) },
          ]}
        />
      )}
    >
      <Presets onBlank={() => setCreating(true)} />
      {choosing ? <Modal isOpen title="Choose a starting point" onClose={() => setChoosing(false)}>
        <Presets onBlank={() => { setChoosing(false); setCreating(true); }} />
      </Modal> : null}
      {creating && can ? <CreateAutomation onClose={() => setCreating(false)} /> : null}
      {enrolling ? <Enroll automation={enrolling} onClose={() => setEnrolling(null)} /> : null}
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
  const topics = useList<Topic>("/topics", {}, { all: true });
  const segments = useList<Segment>("/segments", {}, { all: true });
  const properties = useList<ContactProperty>("/contact-properties", {}, { all: true });
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<TriggerConfig>({ type: "event", event_name: "" });
  const [reentryChoice, setReentryChoice] = useState<Reentry | null>(null);
  const reentry = reentryChoice ?? (trigger.type === "event" ? "every_time" : "once");
  const options = {
    templates: [],
    events: events.rows.map((row) => row.name),
    topics: topics.rows.map((row) => ({ value: row.id, label: row.name })),
    segments: segments.rows.map((row) => ({ value: row.id, label: row.name })),
    staticSegments: segments.rows.filter((row) => row.type !== "dynamic").map((row) => ({ value: row.id, label: row.name })),
    contactProperties: properties.rows,
    topicsReady: !topics.loading && !topics.error,
    segmentsReady: !segments.loading && !segments.error,
    propertiesReady: !properties.loading && !properties.error,
    topicsError: topics.error,
    segmentsError: segments.error,
    propertiesError: properties.error,
  };
  const issues = triggerIssues(trigger, triggerSources(options));
  const valid = name.trim() && !Object.keys(issues).length && !triggerLoading(trigger, options);
  const create = useMutation(
    () =>
      client.post<Automation>("/automations", {
        name: name.trim(),
        reentry,
        steps: [{ key: "trigger", type: "trigger", config: trigger.type === "event" ? { ...trigger, event_name: trigger.event_name.trim() } : trigger }],
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
      onSubmit={() => { if (valid) void create.mutate(); }}
      submitLabel="Create"
      submitDisabled={!valid}
      submitting={create.isLoading}
    >
      <div className="form">
        <Field label="Name" value={name} onChange={setName} placeholder="Welcome series" required autoFocus />
        <ReentryContext.Provider value={{ value: reentry, onChange: setReentryChoice }}>
        <TriggerForm
          config={trigger}
          onChange={setTrigger}
          eventLabel="Trigger event"
          options={options}
        />
        </ReentryContext.Provider>
        <p className="fieldHint">New automations start disabled. Add steps in the builder, then start it.</p>
      </div>
    </Modal>
  );
}
