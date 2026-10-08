import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Users, X } from "lucide-react";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { copyText } from "../../components/Copy";
import { Drawer } from "../../components/Drawer";
import { Empty } from "../../components/Empty";
import { Field, Select } from "../../components/Field";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Table } from "../../components/Table";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { errorMessage } from "../../lib/client";
import { listAll } from "../../lib/pages";
import { emptyBody, fullName } from "../../lib/utils";
import { useCan, useClient } from "../../shell/session";
import type { Segment, SegmentContact } from "../../types";
import { audienceTabs } from "../tabs";
import { blankRule, type Rule } from "../automations/graph";
import { SegmentFilter } from "./SegmentFilter";
import "../../styles/audience.css";

export const segmentCsv: Array<CsvColumn<Segment>> = [
  { header: "id", value: (row) => row.id },
  { header: "name", value: (row) => row.name },
  { header: "type", value: (row) => row.type },
  { header: "contacts", value: (row) => row.contacts },
  { header: "created_at", value: (row) => row.created_at },
];

/** Static lists and live filters. A row opens its current contacts and count. */
export function Segments() {
  const client = useClient();
  const can = useCan();
  const list = useList<Segment>("/segments");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Segment | null>(null);
  const [deleting, setDeleting] = useState<Segment | null>(null);
  const [open, setOpen] = useState<Segment | null>(null);
  const [editing, setEditing] = useState<Segment | null>(null);

  return (
    <ListPage
      title="Audience"
      tabs={audienceTabs}
      actions={
        can ? <button type="button" onClick={() => setCreating(true)}>
          Create segment
        </button> : null
      }
      filterExtra={<CsvExport rows={list.rows} columns={segmentCsv} name="segments" />}
      list={list}
      noun="segments"
      onRowClick={setOpen}
      empty={<Empty title="No segments yet" body="Group your contacts into a segment, then send broadcasts to it." />}
      columns={[
        {
          header: "Name",
          cell: (row) => (
            <span className="cellMain">
              <Tile>
                <Users size={14} />
              </Tile>
              {row.name}
            </span>
          ),
        },
        { header: "Type", cell: (row) => row.type === "dynamic" ? "Filter" : "Static list" },
        { header: "Contacts", cell: (row) => row.type === "dynamic" ? <button type="button" className="ghost small" onClick={(event) => { event.stopPropagation(); setOpen(row); }}>View count</button> : (row.contacts ?? 0).toLocaleString() },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          items={[
            { label: "View contacts", read: true, onSelect: () => setOpen(row) },
            { label: can ? "Edit" : row.type === "dynamic" ? "View filter" : "View segment", read: !can, onSelect: () => setEditing(row) },
            { label: "Rename", onSelect: () => setRenaming(row) },
            { label: "Copy ID", read: true, onSelect: () => void copyText(row.id).then((ok) => ok && toast.success("ID copied.")) },
            "divider",
            { label: "Delete", danger: true, onSelect: () => setDeleting(row) },
          ]}
        />
      )}
    >
      {creating ? <CreateSegment onClose={() => setCreating(false)} onDone={list.reload} /> : null}
      {editing ? <EditSegment segment={editing} onClose={() => setEditing(null)} onDone={list.reload} /> : null}
      {renaming ? <RenameSegment segment={renaming} onClose={() => setRenaming(null)} onDone={list.reload} /> : null}
      {open ? <SegmentContacts segment={open} onClose={() => setOpen(null)} onChange={list.reload} /> : null}
      {deleting && can ? (
        <ConfirmPhrase
          title="Delete segment"
          body="Its contacts stay in your audience. Broadcasts aimed at this segment can no longer send."
          phrase={deleting.name}
          action="Delete segment"
          onConfirm={() => client.delete(`/segments/${deleting.id}`)}
          onClose={() => setDeleting(null)}
          onDone={() => {
            toast.success("Segment deleted.");
            void list.reload();
          }}
        />
      ) : null}
    </ListPage>
  );
}

function CreateSegment({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const can = useCan();
  const [form, setForm] = useState({ name: "", description: "" });
  const [type, setType] = useState("static");
  const [rule, setRule] = useState<Rule>(blankRule);
  const [valid, setValid] = useState(false);
  const { mutate, isLoading } = useMutation(() => {
    if (!can || !form.name.trim() || (type === "dynamic" && !valid)) throw new Error("Complete the segment before saving.");
    return client.post("/segments", { ...emptyBody(form), ...(type === "dynamic" ? { rule } : {}) });
  }, {
    success: "Segment created.",
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Modal isOpen size={type === "dynamic" ? "large" : undefined} title="Create segment" onClose={onClose} onSubmit={() => void mutate()} submitLabel="Create" submitDisabled={!can || !form.name.trim() || (type === "dynamic" && !valid)} submitting={isLoading}>
      <div className="form">
        <Field label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} required autoFocus disabled={!can || isLoading} />
        <Field label="Description" value={form.description} onChange={(description) => setForm({ ...form, description })} disabled={!can || isLoading} />
        <Select label="Type" value={type} onChange={setType} options={[{ value: "static", label: "Static list" }, { value: "dynamic", label: "Filter" }]} disabled={!can || isLoading} />
        {type === "dynamic" ? <SegmentFilter rule={rule} onChange={setRule} onValidityChange={setValid} disabled={!can || isLoading} /> : null}
      </div>
    </Modal>
  );
}

function RenameSegment({ segment, onClose, onDone }: { segment: Segment; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const can = useCan();
  const [name, setName] = useState(segment.name);
  const { mutate, isLoading } = useMutation(() => {
    if (!can) throw new Error("Read-only access.");
    return client.patch(`/segments/${segment.id}`, { name: name.trim() });
  }, {
    success: "Segment renamed.",
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Modal
      isOpen
      size="small"
      title="Rename segment"
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitDisabled={!can || !name.trim() || name.trim() === segment.name}
      submitting={isLoading}
    >
      <div className="form">
        <Field label="Name" value={name} onChange={setName} required autoFocus disabled={!can || isLoading} />
      </div>
    </Modal>
  );
}

function useSegmentDetail(id: string) {
  const client = useClient();
  const [state, setState] = useState<{ data?: Segment; error?: string }>({});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setState({});
    client.get<Segment>(`/segments/${id}`).then(
      (data) => { if (current) setState({ data }); },
      (error) => { if (current) setState({ error: errorMessage(error) }); },
    );
    return () => { current = false; };
  }, [client, id, revision]);
  return { ...state, reload: () => setRevision((value) => value + 1) };
}

function EditSegment({ segment, onClose, onDone }: { segment: Segment; onClose: () => void; onDone: () => void }) {
  const detail = useSegmentDetail(segment.id);
  if (detail.data) return <SegmentDraft key={detail.data.id} segment={detail.data} onClose={onClose} onDone={onDone} />;
  return <Modal isOpen title="Segment" onClose={onClose}>
    {detail.error ? <><p role="alert">{detail.error}</p><button type="button" onClick={detail.reload}>Retry</button></> : <p role="status">Loading segment…</p>}
  </Modal>;
}

function SegmentDraft({ segment, onClose, onDone }: { segment: Segment; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const can = useCan();
  const [name, setName] = useState(segment.name);
  const [description, setDescription] = useState(segment.description ?? "");
  const [type, setType] = useState(segment.type);
  const [rule, setRule] = useState<Rule>(() => segment.rule ?? blankRule());
  const [valid, setValid] = useState(false);
  const [confirmation, setConfirmation] = useState<Segment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const converting = type !== segment.type;
  const ready = can && Boolean(name.trim()) && (type === "static" || valid);
  const body = () => ({
    name: name.trim(), description: description.trim(),
    // Omit rule on ordinary static edits; explicit null is a conversion.
    ...(type === "dynamic" ? { rule } : converting ? { rule: null } : {}),
  });
  const save = useMutation(async () => {
    if (!ready) throw new Error("Complete the segment before saving.");
    if (converting) {
      const current = await client.get<Segment>(`/segments/${segment.id}`);
      if (current.type !== segment.type) throw new Error("Segment type changed. Close and reopen before editing.");
      setConfirmation(current);
      return false;
    }
    await client.patch(`/segments/${segment.id}`, body());
    return true;
  }, { onSuccess: (saved) => { if (saved) { toast.success("Segment saved."); onDone(); onClose(); } }, onError: (failure) => setError(failure.message) });

  async function convert() {
    if (!ready || !confirmation || !can) throw new Error("Conversion is not available.");
    const current = await client.get<Segment>(`/segments/${segment.id}`);
    if (current.type !== confirmation.type || current.contacts !== confirmation.contacts) throw new Error("Membership changed. Cancel and review the conversion again.");
    if (current.type === "static" && (current.contacts ?? 0) > 0) {
      // Existing member-delete API only. No invented bulk-clear endpoint or silent save deletion.
      const members = await listAll<SegmentContact>(client, `/segments/${segment.id}/contacts`, Infinity);
      if (members.has_more || members.data.length !== current.contacts) throw new Error("Membership changed. Cancel and review the conversion again.");
      for (const member of members.data) {
        if (!can) throw new Error("Read-only access.");
        await client.delete(`/segments/${segment.id}/contacts/${member.contact_id}`);
      }
      const empty = await client.get<Segment>(`/segments/${segment.id}`);
      if (empty.contacts !== 0) throw new Error("The list must be empty before converting. Review its remaining members.");
    }
    await client.patch(`/segments/${segment.id}`, body());
  }

  return <>
    <Modal isOpen size="large" title={can ? "Edit segment" : "View segment"} onClose={onClose} onSubmit={can ? () => { setError(null); void save.mutate(); } : undefined} submitDisabled={!ready} submitting={save.isLoading}>
      <div className="stack">
        <p>{segment.type === "dynamic" ? "Filter" : "Static list"} · {(segment.contacts ?? 0).toLocaleString()} contacts</p>
        <p className="muted">Detail counts may be up to 30 seconds old. Filter previews are uncached.</p>
        <Field label="Name" value={name} onChange={setName} disabled={!can || save.isLoading || Boolean(confirmation)} required />
        <Field label="Description" value={description} onChange={setDescription} disabled={!can || save.isLoading || Boolean(confirmation)} />
        <Select label="Type" value={type} onChange={(next) => setType(next as Segment["type"])} options={[{ value: "static", label: "Static list" }, { value: "dynamic", label: "Filter" }]} disabled={!can || save.isLoading || Boolean(confirmation)} />
        {type === "dynamic" ? <SegmentFilter rule={rule} onChange={setRule} disabled={!can || save.isLoading || Boolean(confirmation)} onValidityChange={setValid} /> : null}
        {converting ? <p className="muted">Saving requires explicit conversion confirmation{segment.type === "static" ? " and removal of existing list members first" : "; the new static list starts empty"}.</p> : null}
        {error ? <p role="alert" className="fieldError">{error}</p> : null}
      </div>
    </Modal>
    {confirmation && can ? <ConfirmPhrase
      title="Convert segment"
      body={confirmation.type === "static"
        ? `Remove all ${(confirmation.contacts ?? 0).toLocaleString()} existing list members before converting to a filter. Contacts stay in your audience. Removal is not undone if conversion fails.`
        : `Convert this filter with ${(confirmation.contacts ?? 0).toLocaleString()} matching contacts to an empty static list. Matching contacts are not copied.`}
      phrase={confirmation.type === "static" ? `Remove ${(confirmation.contacts ?? 0).toLocaleString()} contacts` : `Convert ${confirmation.name}`}
      action="Confirm conversion"
      onConfirm={convert}
      onClose={() => { setConfirmation(null); onDone(); }}
      onDone={() => { toast.success("Segment converted."); onDone(); onClose(); }}
    /> : null}
  </>;
}

function SegmentContacts({ segment, onClose, onChange }: { segment: Segment; onClose: () => void; onChange: () => void }) {
  const client = useClient();
  const can = useCan();
  const detail = useSegmentDetail(segment.id);
  const manual = can && detail.data?.type === "static";
  const members = useList<SegmentContact>(`/segments/${segment.id}/contacts`, {}, { limit: 20 });
  const [email, setEmail] = useState("");
  const changed = () => {
    void members.reload();
    detail.reload();
    onChange();
  };
  const add = useMutation(() => {
    if (!manual) throw new Error("Manual membership is only available for static lists.");
    return client.post(`/segments/${segment.id}/contacts`, { email: email.trim() });
  }, {
    success: "Contact added to segment.",
    onSuccess: () => {
      setEmail("");
      changed();
    },
  });
  const remove = useMutation((row: SegmentContact) => {
    if (!manual) throw new Error("Manual membership is only available for static lists.");
    return client.delete(`/segments/${segment.id}/contacts/${row.contact_id}`);
  }, {
    success: "Contact removed from segment.",
    onSuccess: changed,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    void add.mutate();
  }

  return (
    <Drawer isOpen title={segment.name} label="Segment" onClose={onClose}>
      <div className="stack">
        {detail.data ? <><p>{detail.data.type === "dynamic" ? "Filter" : "Static list"} · {(detail.data.contacts ?? 0).toLocaleString()} contacts</p>
          {detail.data.type === "dynamic" ? <p className="muted">Count may be up to 30 seconds old. Filter membership updates automatically.</p> : null}</> : detail.error ? <><p role="alert">{detail.error}</p><button type="button" onClick={detail.reload}>Retry count</button></> : <p role="status">Loading count…</p>}
        {manual ? (
          <form className="inlineForm" onSubmit={submit}>
            <input type="email" aria-label="Email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            <button type="submit" disabled={add.isLoading}>
              Add contact
            </button>
          </form>
        ) : null}
        <Table
          compact
          rows={members.rows}
          loading={members.loading}
          error={members.error}
          onRetry={() => void members.reload()}
          empty={<p className="muted">No contacts in this segment yet.</p>}
          page={members.page}
          hasMore={members.hasMore}
          onNext={members.next}
          onPrevious={members.previous}
          columns={[
            { header: "Email", cell: (row) => <Link to={`/audience/contacts/${row.contact_id}`}>{row.email}</Link> },
            { header: "Name", cell: (row) => fullName(row) },
            { header: (detail.data?.type ?? segment.type) === "dynamic" ? "Created" : "Added", cell: (row) => <Time value={row.created_at} /> },
            {
              header: "",
              key: "remove",
              cell: (row) =>
                manual ? (
                  <button
                    type="button"
                    className="ghost icon small"
                    aria-label={`Remove ${row.email}`}
                    disabled={remove.isLoading}
                    onClick={() => void remove.mutate(row)}
                  >
                    <X size={14} />
                  </button>
                ) : null,
            },
          ]}
        />
      </div>
    </Drawer>
  );
}
