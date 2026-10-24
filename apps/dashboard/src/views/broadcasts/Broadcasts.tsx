import { broadcastStates } from "../../../../../packages/core/src/broadcasts";
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
import { useAll, useResource, type ResourceState } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { Broadcast, BroadcastSummary, List, Segment, Template, TemplateVersion, Topic } from "../../types";

export const broadcastStatuses = Object.keys(broadcastStates);

export const broadcastCsv: Array<CsvColumn<BroadcastSummary>> = [
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
export function broadcastHref(row: Pick<BroadcastSummary, "id" | "status">) {
  return row.status === "draft" ? `/broadcasts/${row.id}/editor` : `/broadcasts/${row.id}`;
}

export function Broadcasts() {
  const client = useClient();
  const can = useCan();
  const navigate = useNavigate();
  const filters = useFilters(["q", "status", "segment_id"]);
  const list = useList<BroadcastSummary>("/broadcasts", filters);
  const segments = useAll<Segment>("/segments");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<BroadcastSummary | null>(null);
  const segmentName = (segmentId: string | null) => segments.data?.data.find((segment) => segment.id === segmentId)?.name ?? segmentId ?? "";

  const duplicate = useMutation((row: BroadcastSummary) => client.post<Broadcast>(`/broadcasts/${row.id}/duplicate`), {
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
      empty={<Empty title="No broadcasts yet" body="Send a marketing email to any segment of your contacts."
        action={can ? <button type="button" onClick={() => setCreating(true)}>Create your first broadcast</button> : null} />}
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
      {creating ? <CreateBroadcast segments={segments} onClose={() => setCreating(false)} /> : null}
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

const blank = { template: "", name: "", from: "", segment_id: "", topic_id: "", subject: "" };

/**
 * Body for `POST /broadcasts`. Empty fields are left out. With `template`, the API copies the
 * template's published subject and content into the draft; a subject given here overrides it.
 */
export function createBody(form: typeof blank) {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) if (value.trim()) body[key] = value.trim();
  return body;
}

/** The API needs a From address, a segment, and a subject, which a template's published version can supply. */
export function canCreate(form: typeof blank, publishedSubject: string | null) {
  return Boolean(form.from.trim() && form.segment_id && (form.subject.trim() || (form.template && publishedSubject?.trim())));
}

/**
 * The subject of a template's published version, which the API copies into a new broadcast.
 * A template's own `subject` is its latest version's, which can be an unpublished draft.
 */
function usePublishedSubject(template: Template | null) {
  const publishedId = template?.published_version_id ?? null;
  const latest = Boolean(publishedId && template?.current_version_id === publishedId);
  const versions = useResource<List<TemplateVersion>>(template && publishedId && !latest ? `/templates/${template.id}/versions` : null);
  if (!template || !publishedId) return { subject: null, loading: false, error: null, reload: versions.reload };
  if (latest) return { subject: template.subject, loading: false, error: null, reload: versions.reload };
  const version = versions.data?.data.find((row) => row.id === publishedId);
  return { subject: version?.subject ?? null, loading: !version && !versions.error, error: version ? null : versions.error, reload: versions.reload };
}

function CreateBroadcast({ segments, onClose }: { segments: ResourceState<List<Segment>>; onClose: () => void }) {
  const client = useClient();
  const navigate = useNavigate();
  const topics = useAll<Topic>("/topics");
  const templates = useAll<Template>("/templates");
  const published = (templates.data?.data ?? []).filter((item) => item.status === "published");
  const [form, setForm] = useState(blank);
  const set = (key: keyof typeof blank) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const chosen = published.find((item) => item.id === form.template) ?? null;
  const publishedSubject = usePublishedSubject(chosen);
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
      submitDisabled={segments.loading || Boolean(segments.error) || !canCreate(form, publishedSubject.subject)}
    >
      <div className="form">
        <p className="fieldHint">Broadcasts are marketing email: Dispatch skips contacts who unsubscribed or opted out of the topic, and adds an unsubscribe header.</p>
        <Select
          label="Start from"
          value={form.template}
          onChange={set("template")}
          placeholder="Blank: write the content in the editor"
          options={published.map((item) => ({ value: item.id, label: item.name }))}
          hint={
            chosen
              ? "The draft starts with this template's published subject and content. You can change both in the editor."
              : templates.loading
                ? "Loading templates…"
                : templates.error
                  ? `Could not load templates: ${templates.error}`
                  : published.length
                    ? "Choose a published template to copy its subject and content into the draft."
                    : "Publish a template to start from it."
          }
        />
        <Field label="Name" value={form.name} onChange={set("name")} placeholder="October update" hint="Defaults to the subject." />
        <Field label="From" value={form.from} onChange={set("from")} placeholder="Acme <news@acme.com>" required />
        {segments.loading ? <p role="status">Loading segments…</p> : segments.error ? <p role="alert">Could not load segments: {segments.error}</p> : !segments.data?.data.length ? <p className="fieldHint">Create a segment to choose who receives this broadcast.</p> : null}
        <div className="toolbar"><a href="/audience/segments" target="_blank" rel="noreferrer">Create segment</a><button type="button" className="secondary small" disabled={segments.loading} onClick={() => void segments.reload()}>{segments.error ? "Retry segments" : "Refresh segments"}</button></div>
        <Select
          label="Segment"
          value={form.segment_id}
          onChange={set("segment_id")}
          placeholder="Choose a segment"
          options={(segments.data?.data ?? []).map((segment) => ({ value: segment.id, label: segment.name }))}
          required
        />
        {topics.error ? <p role="alert">Could not load topics. <button type="button" className="secondary small" onClick={() => void topics.reload()}>Retry topics</button></p> : null}
        <Select
          label="Topic"
          value={form.topic_id}
          onChange={set("topic_id")}
          placeholder="No topic"
          options={(topics.data?.data ?? []).map((topic) => ({ value: topic.id, label: topic.name }))}
        />
        <Field
          label="Subject"
          value={form.subject}
          onChange={set("subject")}
          required={!publishedSubject.subject}
          placeholder={publishedSubject.subject ?? undefined}
          hint={
            !chosen ? undefined : publishedSubject.loading ? (
              "Loading the template's published subject…"
            ) : publishedSubject.error ? (
              <>
                Could not load the template's published subject, so add one.{" "}
                <button type="button" className="secondary small" onClick={() => void publishedSubject.reload()}>
                  Retry
                </button>
              </>
            ) : publishedSubject.subject ? (
              "Leave empty to use the template's published subject."
            ) : (
              "This template's published version has no subject, so add one."
            )
          }
        />
      </div>
    </Modal>
  );
}
