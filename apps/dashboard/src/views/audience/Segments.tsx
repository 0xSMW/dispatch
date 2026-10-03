import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Users, X } from "lucide-react";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { copyText } from "../../components/Copy";
import { Drawer } from "../../components/Drawer";
import { Empty } from "../../components/Empty";
import { Field } from "../../components/Field";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Table } from "../../components/Table";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { emptyBody, fullName } from "../../lib/utils";
import { useCan, useClient } from "../../shell/session";
import type { Segment, SegmentContact } from "../../types";
import { audienceTabs } from "../tabs";
import "../../styles/audience.css";

export const segmentCsv: Array<CsvColumn<Segment>> = [
  { header: "id", value: (row) => row.id },
  { header: "name", value: (row) => row.name },
  { header: "contacts", value: (row) => row.contacts },
  { header: "created_at", value: (row) => row.created_at },
];

/** Segments: static lists of contacts. A row opens its members. */
export function Segments() {
  const client = useClient();
  const list = useList<Segment>("/segments");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Segment | null>(null);
  const [deleting, setDeleting] = useState<Segment | null>(null);
  const [open, setOpen] = useState<Segment | null>(null);

  return (
    <ListPage
      title="Audience"
      description="Static lists"
      tabs={audienceTabs}
      actions={
        <button type="button" onClick={() => setCreating(true)}>
          Create segment
        </button>
      }
      filterExtra={<CsvExport rows={list.rows} columns={segmentCsv} name="segments" />}
      list={list}
      noun="segments"
      onRowClick={setOpen}
      empty={<Empty title="No segments" body="Create a segment to group contacts and target broadcasts." />}
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
        { header: "Contacts", cell: (row) => (row.contacts ?? 0).toLocaleString() },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          items={[
            { label: "View contacts", read: true, onSelect: () => setOpen(row) },
            { label: "Rename", onSelect: () => setRenaming(row) },
            { label: "Copy ID", read: true, onSelect: () => void copyText(row.id).then((ok) => ok && toast.success("ID copied.")) },
            "divider",
            { label: "Delete", danger: true, onSelect: () => setDeleting(row) },
          ]}
        />
      )}
    >
      {creating ? <CreateSegment onClose={() => setCreating(false)} onDone={list.reload} /> : null}
      {renaming ? <RenameSegment segment={renaming} onClose={() => setRenaming(null)} onDone={list.reload} /> : null}
      {open ? <SegmentContacts segment={open} onClose={() => setOpen(null)} onChange={list.reload} /> : null}
      {deleting ? (
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
  const [form, setForm] = useState({ name: "", description: "" });
  const { mutate, isLoading } = useMutation(() => client.post("/segments", emptyBody(form)), {
    success: "Segment created.",
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Modal isOpen title="Create segment" onClose={onClose} onSubmit={() => void mutate()} submitLabel="Create" submitDisabled={!form.name.trim()} submitting={isLoading}>
      <div className="form">
        <Field label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} required autoFocus />
        <Field label="Description" value={form.description} onChange={(description) => setForm({ ...form, description })} />
      </div>
    </Modal>
  );
}

function RenameSegment({ segment, onClose, onDone }: { segment: Segment; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [name, setName] = useState(segment.name);
  const { mutate, isLoading } = useMutation(() => client.patch(`/segments/${segment.id}`, { name: name.trim() }), {
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
      submitDisabled={!name.trim() || name.trim() === segment.name}
      submitting={isLoading}
    >
      <div className="form">
        <Field label="Name" value={name} onChange={setName} required autoFocus />
      </div>
    </Modal>
  );
}

function SegmentContacts({ segment, onClose, onChange }: { segment: Segment; onClose: () => void; onChange: () => void }) {
  const client = useClient();
  const can = useCan();
  const members = useList<SegmentContact>(`/segments/${segment.id}/contacts`, {}, { limit: 20 });
  const [email, setEmail] = useState("");
  const changed = () => {
    void members.reload();
    onChange();
  };
  const add = useMutation(() => client.post(`/segments/${segment.id}/contacts`, { email: email.trim() }), {
    success: "Contact added to segment.",
    onSuccess: () => {
      setEmail("");
      changed();
    },
  });
  const remove = useMutation((row: SegmentContact) => client.delete(`/segments/${segment.id}/contacts/${row.contact_id}`), {
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
        {can ? (
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
          empty={<p className="muted">No contacts in this segment.</p>}
          page={members.page}
          hasMore={members.hasMore}
          onNext={members.next}
          onPrevious={members.previous}
          columns={[
            { header: "Email", cell: (row) => <Link to={`/audience/contacts/${row.contact_id}`}>{row.email}</Link> },
            { header: "Name", cell: (row) => fullName(row) },
            { header: "Added", cell: (row) => <Time value={row.created_at} /> },
            {
              header: "",
              key: "remove",
              cell: (row) =>
                can ? (
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
