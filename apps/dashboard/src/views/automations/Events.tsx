import { useState } from "react";
import { Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { Code } from "../../components/Code";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Drawer } from "../../components/Drawer";
import { Empty } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { Field, Select, TextArea } from "../../components/Field";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Table } from "../../components/Table";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { shortJson } from "../../lib/utils";
import { useCan, useClient } from "../../shell/session";
import type { EventDefinition, FiredEvent } from "../../types";
import { automationTabs } from "../tabs";
import { EventInput } from "./Steps";

export const fieldTypes = ["string", "number", "boolean", "date"] as const;
type FieldType = (typeof fieldTypes)[number];
type Row = { name: string; type: FieldType };

const typeLabels: Record<FieldType, string> = { string: "String", number: "Number", boolean: "Boolean", date: "Date" };

function payloadOf(event: FiredEvent) {
  return event.payload ?? event.data ?? {};
}

/** A payload that passes the event's schema, to start the test event from. */
export function samplePayload(schema: EventDefinition["schema"]): Record<string, unknown> {
  const samples: Record<FieldType, unknown> = { string: "text", number: 1, boolean: true, date: new Date().toISOString() };
  return Object.fromEntries(Object.entries(schema).map(([name, type]) => [name, samples[type] ?? ""]));
}

/** `/automations/events`: event definitions (`/events`), fired events (`/fired-events`), and test sends. */
export function Events() {
  const client = useClient();
  const can = useCan();
  const definitions = useList<EventDefinition>("/events");
  const fired = useList<FiredEvent>("/fired-events", {}, { limit: 20 });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<EventDefinition | null>(null);
  const [deleting, setDeleting] = useState<EventDefinition | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [viewing, setViewing] = useState<FiredEvent | null>(null);

  return (
    <ListPage
      title="Automations"
      tabs={automationTabs}
      actions={
        <>
          <button type="button" className="secondary" onClick={() => setSending("")}>
            Send test event
          </button>
          <button type="button" onClick={() => setCreating(true)}>
            Add event
          </button>
        </>
      }
      list={definitions}
      noun="events"
      onRowClick={can ? setEditing : undefined}
      empty={
        <Empty
          title="No events defined"
          body="Define an event's fields so payloads are checked when they arrive. Automations also run on events with no definition."
        />
      }
      columns={[
        {
          header: "Event",
          cell: (row) => (
            <span className="cellMain">
              <Tile tone="accent">
                <Zap size={14} />
              </Tile>
              <span className="mono">{row.name}</span>
            </span>
          ),
        },
        {
          header: "Fields",
          cell: (row) =>
            Object.keys(row.schema ?? {}).length ? (
              <span className="schemaChips">
                {Object.entries(row.schema).map(([name, type]) => (
                  <span key={name} className="schemaChip mono">
                    {name}
                    <span className="dim">: {type}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="dim">Any payload</span>
            ),
        },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          items={[
            { label: "Edit fields", onSelect: () => setEditing(row) },
            { label: "Send test event", onSelect: () => setSending(row.name) },
            "divider",
            { label: "Delete", danger: true, onSelect: () => setDeleting(row) },
          ]}
        />
      )}
    >
      <Panel
        title="Fired events"
        actions={
          <button type="button" className="secondary small" onClick={() => void fired.reload()} disabled={fired.loading}>
            <RefreshCw size={14} />
            Refresh
          </button>
        }
      >
        <Table
          compact
          rows={fired.rows}
          loading={fired.loading}
          error={fired.error}
          onRetry={() => void fired.reload()}
          onRowClick={setViewing}
          page={fired.page}
          hasMore={fired.hasMore}
          onNext={fired.next}
          onPrevious={fired.previous}
          noun="events"
          empty={<Empty title="No events fired" body="Events sent with POST /events/send or Send test event show here." />}
          columns={[
            { header: "Event", cell: (row) => <span className="mono">{row.name}</span> },
            { header: "Contact", cell: (row) => row.email ?? <span className="dim">No contact</span> },
            { header: "Payload", cell: (row) => <span className="mono dim truncate">{shortJson(payloadOf(row))}</span> },
            { header: "Sent", cell: (row) => <Time value={row.created_at} /> },
          ]}
        />
      </Panel>

      {creating ? <DefinitionForm onClose={() => setCreating(false)} onDone={() => void definitions.reload()} /> : null}
      {editing ? <DefinitionForm definition={editing} onClose={() => setEditing(null)} onDone={() => void definitions.reload()} /> : null}
      {sending !== null ? (
        <SendEvent
          initial={sending}
          definitions={definitions.rows}
          onClose={() => setSending(null)}
          onDone={() => void fired.reload()}
        />
      ) : null}
      {viewing ? (
        <Drawer isOpen title={viewing.name} label="Fired event" onClose={() => setViewing(null)}>
          <div className="stack">
            <Facts
              columns={2}
              items={[
                { label: "Contact", value: viewing.email ?? null },
                { label: "Sent", value: <Time value={viewing.created_at} mode="absolute" /> },
                { label: "ID", value: viewing.id, copy: true },
                { label: "Request", value: viewing.request_id ?? null, copy: true, hidden: !viewing.request_id },
              ]}
            />
            <Code value={payloadOf(viewing)} />
          </div>
        </Drawer>
      ) : null}
      {deleting ? (
        <ConfirmPhrase
          title="Delete event"
          body="Payloads for this event are no longer checked. Automations that use it keep running."
          phrase={deleting.name}
          action="Delete event"
          onConfirm={() => client.delete(`/events/${deleting.id}`)}
          onClose={() => setDeleting(null)}
          onDone={() => {
            toast.success("Event deleted.");
            void definitions.reload();
          }}
        />
      ) : null}
    </ListPage>
  );
}

/** Field rows to the API's `schema` map. Blank rows are dropped. */
export function toSchema(rows: Row[]) {
  return Object.fromEntries(rows.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.type]));
}

export function schemaIssue(rows: Row[]) {
  const names = rows.map((row) => row.name.trim()).filter(Boolean);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) return `${duplicate} is listed twice.`;
  if (names.some((name) => name.length > 100)) return "Field names are 100 characters at most.";
  return null;
}

export function nameIssue(name: string) {
  if (/^(resend|dispatch):/i.test(name.trim())) return "Names cannot start with resend: or dispatch:.";
  return null;
}

/** Create (`POST /events`) or edit (`PATCH /events/:id`) a definition: a name and typed fields. */
function DefinitionForm({ definition, onClose, onDone }: { definition?: EventDefinition; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [name, setName] = useState(definition?.name ?? "");
  const [rows, setRows] = useState<Row[]>(() => {
    const entries = Object.entries(definition?.schema ?? {}).map(([field, type]) => ({ name: field, type }));
    return entries.length ? entries : [{ name: "", type: "string" }];
  });
  const issue = schemaIssue(rows);
  const badName = nameIssue(name);
  const save = useMutation(
    () =>
      definition
        ? client.patch<EventDefinition>(`/events/${definition.id}`, { schema: toSchema(rows) })
        : client.post<EventDefinition>("/events", { name: name.trim(), schema: toSchema(rows) }),
    {
      success: definition ? "Event updated." : "Event added.",
      onSuccess: () => {
        onDone();
        onClose();
      },
    },
  );
  const setRow = (index: number, change: Partial<Row>) => setRows(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));

  return (
    <Modal
      isOpen
      title={definition ? "Edit event" : "Add event"}
      onClose={onClose}
      onSubmit={() => void save.mutate()}
      submitLabel={definition ? "Save" : "Add"}
      submitDisabled={!name.trim() || Boolean(issue) || Boolean(badName)}
      submitting={save.isLoading}
    >
      <div className="form">
        <Field
          label="Name"
          value={name}
          onChange={setName}
          placeholder="user.created"
          mono
          required
          autoFocus={!definition}
          disabled={Boolean(definition)}
          error={badName}
          hint={definition ? "Names cannot change." : undefined}
        />
        <fieldset className="schemaRows">
          <legend>Fields</legend>
          {rows.map((row, index) => (
            <div key={index} className="schemaRow">
              <Field label="Property" value={row.name} onChange={(value) => setRow(index, { name: value })} placeholder="plan" mono />
              <Select
                label="Type"
                value={row.type}
                onChange={(value) => setRow(index, { type: value as FieldType })}
                options={fieldTypes.map((type) => ({ value: type, label: typeLabels[type] }))}
              />
              <button
                type="button"
                className="ghost icon small"
                aria-label="Remove field"
                disabled={rows.length === 1 && !row.name}
                onClick={() => setRows(rows.length === 1 ? [{ name: "", type: "string" }] : rows.filter((_, at) => at !== index))}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {issue ? (
            <span className="fieldError" role="alert">
              {issue}
            </span>
          ) : (
            <span className="fieldHint">Payload values must match these types. Fields not listed are accepted as is.</span>
          )}
          <div>
            <button type="button" className="secondary small" onClick={() => setRows([...rows, { name: "", type: "string" }])}>
              <Plus size={14} />
              Add field
            </button>
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

/** `POST /events/send`: fire an event for a contact, with a payload prefilled from its definition. */
function SendEvent({
  initial,
  definitions,
  onClose,
  onDone,
}: {
  initial: string;
  definitions: EventDefinition[];
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useClient();
  const sample = (name: string) => {
    const definition = definitions.find((item) => item.name === name);
    return definition && Object.keys(definition.schema ?? {}).length ? JSON.stringify(samplePayload(definition.schema), null, 2) : "";
  };
  const [event, setEvent] = useState(initial);
  const [by, setBy] = useState<"email" | "contact_id">("email");
  const [recipient, setRecipient] = useState("");
  const [payload, setPayload] = useState(() => sample(initial));
  const [touched, setTouched] = useState(false);

  let parsed: Record<string, unknown> | null = {};
  let payloadIssue: string | null = null;
  if (payload.trim()) {
    try {
      const value: unknown = JSON.parse(payload);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
      else {
        parsed = null;
        payloadIssue = "The payload must be a JSON object.";
      }
    } catch {
      parsed = null;
      payloadIssue = "Not valid JSON.";
    }
  }

  const send = useMutation(
    () =>
      client.post("/events/send", {
        event: event.trim(),
        ...(recipient.trim() ? { [by]: recipient.trim() } : {}),
        payload: parsed ?? {},
      }),
    {
      success: "Event sent.",
      onSuccess: () => {
        onDone();
        onClose();
      },
    },
  );

  return (
    <Modal
      isOpen
      title="Send test event"
      onClose={onClose}
      onSubmit={() => void send.mutate()}
      submitLabel="Send"
      submitDisabled={!event.trim() || parsed === null}
      submitting={send.isLoading}
    >
      <div className="form">
        <EventInput
          label="Event"
          value={event}
          onChange={(value) => {
            setEvent(value);
            if (!touched) setPayload(sample(value));
          }}
          events={definitions.map((item) => item.name)}
          hint="Enabled automations with this trigger start a run."
        />
        <div className="form two">
          <Select
            label="Contact by"
            value={by}
            onChange={(value) => setBy(value as "email" | "contact_id")}
            options={[
              { value: "email", label: "Email" },
              { value: "contact_id", label: "Contact ID" },
            ]}
          />
          <Field
            label={by === "email" ? "Email" : "Contact ID"}
            type={by === "email" ? "email" : "text"}
            value={recipient}
            onChange={setRecipient}
            placeholder={by === "email" ? "ada@example.com" : "contact_..."}
            mono={by === "contact_id"}
          />
        </div>
        <TextArea
          label="Payload"
          value={payload}
          onChange={(value) => {
            setTouched(true);
            setPayload(value);
          }}
          placeholder={'{"plan": "pro"}'}
          error={payloadIssue}
          hint="JSON. Steps read it as event.<field>."
          mono
          rows={6}
        />
      </div>
    </Modal>
  );
}
