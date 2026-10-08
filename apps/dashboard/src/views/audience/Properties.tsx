import { useState } from "react";
import { Braces } from "lucide-react";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { copyText } from "../../components/Copy";
import { Empty } from "../../components/Empty";
import { Field, Select } from "../../components/Field";
import { TypedValue } from "../../components/TypedValue";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useCan, useClient } from "../../shell/session";
import type { ContactProperty, PropertyType } from "../../types";
import { propertyTypes, typedValue, valueIssue } from "../../lib/rules";
import { audienceTabs } from "../tabs";
import "../../styles/audience.css";

const keyPattern = /^[A-Za-z0-9_]{1,50}$/;

export const propertyCsv: Array<CsvColumn<ContactProperty>> = [
  { header: "id", value: (row) => row.id },
  { header: "key", value: (row) => row.key },
  { header: "type", value: (row) => row.type },
  { header: "fallback_value", value: (row) => row.fallback_value },
  { header: "created_at", value: (row) => row.created_at },
];

/** Typed values, with null for an absent fallback and unchanged ISO date strings. */
export const fallbackValue = typedValue;

function showFallback(value: ContactProperty["fallback_value"]) {
  return value === null || value === undefined || value === "" ? <span className="dim">—</span> : <span className="mono">{String(value)}</span>;
}

/** Contact properties: key, type, fallback. Only the fallback can change after creation. */
export function Properties() {
  const client = useClient();
  const can = useCan();
  const list = useList<ContactProperty>("/contact-properties");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ContactProperty | null>(null);
  const [deleting, setDeleting] = useState<ContactProperty | null>(null);

  return (
    <ListPage
      title="Audience"
      tabs={audienceTabs}
      actions={
        <button type="button" onClick={() => setCreating(true)}>
          Add property
        </button>
      }
      filterExtra={<CsvExport rows={list.rows} columns={propertyCsv} name="contact-properties" />}
      list={list}
      noun="properties"
      onRowClick={can ? setEditing : undefined}
      empty={<Empty title="No properties yet" body="Add a property to save extra details on your contacts and use them in your templates." />}
      columns={[
        {
          header: "Name",
          cell: (row) => (
            <span className="cellMain">
              <Tile>
                <Braces size={14} />
              </Tile>
              <span className="mono">{row.key}</span>
            </span>
          ),
        },
        { header: "Type", cell: (row) => row.type },
        { header: "Fallback value", cell: (row) => showFallback(row.fallback_value) },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          items={[
            { label: "Edit fallback", onSelect: () => setEditing(row) },
            { label: "Copy ID", read: true, onSelect: () => void copyText(row.id).then((ok) => ok && toast.success("ID copied.")) },
            "divider",
            { label: "Delete", danger: true, onSelect: () => setDeleting(row) },
          ]}
        />
      )}
    >
      {creating ? <CreateProperty onClose={() => setCreating(false)} onDone={list.reload} /> : null}
      {editing ? <EditFallback property={editing} onClose={() => setEditing(null)} onDone={list.reload} /> : null}
      {deleting ? (
        <ConfirmPhrase
          title="Delete property"
          body={`Templates that use ${deleting.key} fall back to an empty value. Values already stored on contacts stay.`}
          phrase={deleting.key}
          action="Delete property"
          onConfirm={() => client.delete(`/contact-properties/${deleting.id}`)}
          onClose={() => setDeleting(null)}
          onDone={() => {
            toast.success("Property deleted.");
            void list.reload();
          }}
        />
      ) : null}
    </ListPage>
  );
}

function CreateProperty({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [form, setForm] = useState<{ key: string; type: PropertyType; fallback: string }>({ key: "", type: "string", fallback: "" });
  const invalidKey = form.key !== "" && !keyPattern.test(form.key);
  const reserved = form.key === "topics" || form.key === "segments";
  const invalidFallback = valueIssue(form.type, form.fallback);
  const { mutate, isLoading } = useMutation(
    () => {
      const body: Record<string, unknown> = { key: form.key, type: form.type };
      const fallback = fallbackValue(form.type, form.fallback);
      if (fallback !== null) body.fallback_value = fallback;
      return client.post("/contact-properties", body);
    },
    {
      success: "Property added.",
      onSuccess: () => {
        onDone();
        onClose();
      },
    },
  );

  return (
    <Modal
      isOpen
      title="Add property"
      onClose={onClose}
      onSubmit={() => { if (form.key && !invalidKey && !reserved && !invalidFallback) void mutate(); }}
      submitLabel="Add"
      submitDisabled={!form.key || invalidKey || reserved || Boolean(invalidFallback)}
      submitting={isLoading}
    >
      <div className="form">
        <Field
          label="Name"
          value={form.key}
          onChange={(key) => setForm({ ...form, key })}
          placeholder="company_name"
          mono
          required
          autoFocus
          error={invalidKey ? "Letters, digits, and underscores, 50 at most." : reserved ? "Topics and segments are reserved context fields." : null}
          hint="Use it in templates as {{{company_name}}}."
        />
        <Select
          label="Type"
          value={form.type}
          onChange={(type) => setForm({ ...form, type: type as PropertyType, fallback: "" })}
          options={propertyTypes}
          hint="The type cannot change later."
        />
        <TypedValue
          key={form.type}
          label="Fallback value"
          type={form.type}
          value={form.fallback}
          onChange={(fallback) => setForm({ ...form, fallback })}
          hint="Used when a contact has no value."
          error={invalidFallback}
          nullable
        />
      </div>
    </Modal>
  );
}

function EditFallback({ property, onClose, onDone }: { property: ContactProperty; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [fallback, setFallback] = useState(property.fallback_value === null ? "" : String(property.fallback_value));
  const invalid = valueIssue(property.type, fallback);
  const { mutate, isLoading } = useMutation(
    () => client.patch(`/contact-properties/${property.id}`, { fallback_value: fallbackValue(property.type, fallback) }),
    {
      success: "Fallback saved.",
      onSuccess: () => {
        onDone();
        onClose();
      },
    },
  );

  return (
    <Modal isOpen title={property.key} onClose={onClose} onSubmit={() => { if (!invalid) void mutate(); }} submitDisabled={Boolean(invalid)} submitting={isLoading}>
      <div className="form">
        <Field label="Type" value={property.type} onChange={() => undefined} disabled hint="The name and type cannot change." />
        <TypedValue
          label="Fallback value"
          type={property.type}
          value={fallback}
          onChange={setFallback}
          autoFocus
          hint="Leave empty for no fallback."
          error={invalid}
          nullable
        />
      </div>
    </Modal>
  );
}
