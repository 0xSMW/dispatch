import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Megaphone } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { Empty } from "../../components/Empty";
import { Field, Select } from "../../components/Field";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useFilters } from "../../hooks/useFilters";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useAll } from "../../hooks/useResource";
import { useClient } from "../../shell/session";
import type { Broadcast, List, Segment, Topic } from "../../types";

export const broadcastStatuses = ["draft", "scheduled", "queued", "sent", "canceled"];

export const broadcastCsv: Array<CsvColumn<Broadcast>> = [
  { header: "id", value: (row) => row.id },
  { header: "name", value: (row) => row.name },
  { header: "status", value: (row) => row.status },
  { header: "segment_id", value: (row) => row.segment_id },
  { header: "scheduled_at", value: (row) => row.scheduled_at },
  { header: "sent_at", value: (row) => row.sent_at },
  { header: "created_at", value: (row) => row.created_at },
];

/** Draft, scheduled, and canceled broadcasts can be deleted. */
export function deletable(status: string) {
  return ["draft", "scheduled", "canceled"].includes(status);
}

/** A draft opens the editor; anything else opens its detail. */
export function broadcastHref(row: Pick<Broadcast, "id" | "status">) {
  return row.status === "draft" ? `/broadcasts/${row.id}/editor` : `/broadcasts/${row.id}`;
}

export function Broadcasts() {
  const client = useClient();
  const navigate = useNavigate();
  const filters = useFilters(["q", "status", "segment_id"]);
  const list = useList<Broadcast>("/broadcasts", filters);
  const segments = useAll<Segment>("/segments");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Broadcast | null>(null);
  const segmentName = (segmentId: string | null) => segments.data?.data.find((segment) => segment.id === segmentId)?.name ?? segmentId ?? "";

  const duplicate = useMutation((row: Broadcast) => client.post<Broadcast>(`/broadcasts/${row.id}/duplicate`), {
    success: "Broadcast duplicated.",
    onSuccess: (copy) => navigate(`/broadcasts/${copy.id}/editor`),
  });

  return (
    <ListPage
      title="Broadcasts"
      actions={
        <button type="button" onClick={() => setCreating(true)}>
          Create broadcast
        </button>
      }
      search="Search by name or subject"
      filters={[
        { param: "status", label: "Status", options: broadcastStatuses },
        {
          param: "segment_id",
          label: "Segment",
          all: "All segments",
          options: (segments.data?.data ?? []).map((segment) => ({ value: segment.id, label: segment.name })),
        },
      ]}
      filterExtra={<CsvExport rows={list.rows} columns={broadcastCsv} name="broadcasts" />}
      list={list}
      noun="broadcasts"
      rowHref={broadcastHref}
      empty={<Empty title="No broadcasts" body="Broadcasts are always Marketing. Send one email to a segment, respecting contact and topic opt-outs with an unsubscribe link and header." />}
      columns={[
        {
          header: "Name",
          cell: (row) => (
            <span className="cellMain">
              <Tile tone={statusToVariant(row.status)}>
                <Megaphone size={14} />
              </Tile>
              <Link to={broadcastHref(row)}>{row.name}</Link>
            </span>
          ),
        },
        { header: "Status", cell: (row) => <Badge value={row.status} /> },
        { header: "Kind", cell: () => <Badge value="marketing" label="Marketing" /> },
        { header: "Segment", cell: (row) => segmentName(row.segment_id) },
        {
          header: "When",
          cell: (row) =>
            row.sent_at ? <Time value={row.sent_at} /> : row.scheduled_at ? <Time value={row.scheduled_at} mode="absolute" /> : <span className="dim">—</span>,
        },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          label={`Actions for ${row.name}`}
          items={[
            { label: "Edit", hidden: row.status !== "draft", onSelect: () => navigate(`/broadcasts/${row.id}/editor`) },
            { label: "View details", read: true, onSelect: () => navigate(`/broadcasts/${row.id}`) },
            { label: "Duplicate", disabled: duplicate.isLoading, onSelect: () => void duplicate.mutate(row) },
            "divider",
            { label: "Delete", danger: true, hidden: !deletable(row.status), onSelect: () => setDeleting(row) },
          ]}
        />
      )}
    >
      {creating ? <CreateBroadcast segments={segments.data?.data ?? []} onClose={() => setCreating(false)} /> : null}
      {deleting ? (
        <ConfirmPhrase
          title="Delete broadcast"
          body={deleting.status === "scheduled" ? `${deleting.name} is scheduled. Deleting it cancels the send.` : `${deleting.name} will be deleted.`}
          phrase={deleting.name}
          action="Delete broadcast"
          onConfirm={() => client.delete(`/broadcasts/${deleting.id}`)}
          onClose={() => setDeleting(null)}
          onDone={() => {
            toast.success("Broadcast deleted.");
            void list.reload();
          }}
        />
      ) : null}
    </ListPage>
  );
}

const blank = { name: "", from: "", segment_id: "", topic_id: "", subject: "" };

/** Body for `POST /broadcasts`. Empty fields are left out. */
export function createBody(form: typeof blank) {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) if (value.trim()) body[key] = value.trim();
  return body;
}

function CreateBroadcast({ segments, onClose }: { segments: Segment[]; onClose: () => void }) {
  const client = useClient();
  const navigate = useNavigate();
  const topics = useAll<Topic>("/topics");
  const [form, setForm] = useState(blank);
  const set = (key: keyof typeof blank) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const create = useMutation(() => client.post<Broadcast>("/broadcasts", createBody(form)), {
    success: "Draft created.",
    onSuccess: (broadcast) => navigate(`/broadcasts/${broadcast.id}/editor`),
  });

  return (
    <Modal
      isOpen
      title="Create broadcast"
      onClose={onClose}
      onSubmit={() => void create.mutate()}
      submitLabel="Create draft"
      submitting={create.isLoading}
      submitDisabled={!form.from.trim() || !form.segment_id || !form.subject.trim()}
    >
      <div className="form">
        <p className="fieldHint">Broadcasts are always Marketing: they respect contact and topic opt-outs and add an unsubscribe header.</p>
        <Field label="Name" value={form.name} onChange={set("name")} placeholder="October update" autoFocus hint="Defaults to the subject." />
        <Field label="From" value={form.from} onChange={set("from")} placeholder="Acme <news@acme.com>" required />
        <Select
          label="Segment"
          value={form.segment_id}
          onChange={set("segment_id")}
          placeholder="Choose a segment"
          options={segments.map((segment) => ({ value: segment.id, label: segment.name }))}
          required
        />
        <Select
          label="Topic"
          value={form.topic_id}
          onChange={set("topic_id")}
          placeholder="No topic"
          options={(topics.data?.data ?? []).map((topic) => ({ value: topic.id, label: topic.name }))}
        />
        <Field label="Subject" value={form.subject} onChange={set("subject")} required />
      </div>
    </Modal>
  );
}
