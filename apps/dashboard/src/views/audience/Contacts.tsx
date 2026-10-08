import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import { Badge } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { copyText } from "../../components/Copy";
import { Empty } from "../../components/Empty";
import { Field } from "../../components/Field";
import { BulkBar } from "../../components/BulkBar";
import { FilterBar } from "../../components/FilterBar";
import { PageHeader } from "../../components/PageHeader";
import { Table, type Column } from "../../components/Table";
import { Tabs } from "../../components/Tabs";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Skeleton } from "../../components/Skeleton";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useFilters } from "../../hooks/useFilters";
import { useBulkKeys } from "../../hooks/useBulkKeys";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useAll, useResource } from "../../hooks/useResource";
import { useSelection } from "../../hooks/useSelection";
import { each } from "../../lib/bulk";
import { errorMessage } from "../../lib/client";
import { learnLinks } from "../../lib/docs";
import { fullName } from "../../lib/utils";
import { useCan, useClient } from "../../shell/session";
import type { Contact, ContactProperty, ContactStats, List, Segment, Topic } from "../../types";
import { audienceTabs } from "../tabs";
import { download, toCsv } from "./csv";
import { ImportContacts, Imports } from "./Import";
import "../../styles/audience.css";

export const subscriptionOptions = [
  { value: "true", label: "Subscribed" },
  { value: "false", label: "Unsubscribed" },
];

type Dialog = "add" | "import" | "imports" | "segment" | "delete" | null;

/** Contacts list: stats, search, segment filter, bulk actions, add, import, and export. */
export function Contacts() {
  const client = useClient();
  const can = useCan();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const filters = useFilters(["q", "subscribed", "segment_id"]);
  const list = useList<Contact>("/contacts", filters);
  const segments = useAll<Segment>("/segments");
  const stats = useResource<ContactStats>("/contacts/stats");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deleting, setDeleting] = useState<Contact | null>(null);
  const close = () => setDialog(null);
  const filtered = Boolean(filters.q || filters.subscribed || filters.segment_id);
  const emptyAccount = !list.loading && !list.error && list.page === 1 && list.rows.length === 0
    && !filtered && !stats.loading && !stats.error && stats.data?.all === 0;

  const selection = useSelection(list.rows.map((row) => row.id));

  const refresh = () => {
    void list.reload();
    void stats.reload();
  };

  useBulkKeys(selection, list.rows.length, () => setDialog("delete"));

  function exportPage() {
    const keys = [...new Set(list.rows.flatMap((row) => Object.keys(row.properties ?? {})))].sort();
    const rows = [
      ["id", "email", "first_name", "last_name", "unsubscribed", "created_at", ...keys],
      ...list.rows.map((row) => [
        row.id,
        row.email,
        row.first_name,
        row.last_name,
        row.unsubscribed,
        row.created_at,
        ...keys.map((key) => row.properties?.[key]?.value),
      ]),
    ];
    download(`contacts-page-${list.page}.csv`, toCsv(rows));
  }

  const count = selection.count;
  const phrase = `DELETE ${count} CONTACT${count === 1 ? "" : "S"}`;

  const columns: Array<Column<Contact>> = [
    {
      header: "Email",
      cell: (row) => (
        <span className="cellMain">
          <span className="avatar small" aria-hidden>
            {row.email.slice(0, 1).toUpperCase()}
          </span>
          <Link to={`/audience/contacts/${row.id}`}>{row.email}</Link>
        </span>
      ),
    },
    { header: "Name", cell: (row) => fullName(row) || <span className="dim">—</span> },
    {
      header: "Segments",
      cell: (row) =>
        row.segments?.length ? (
          <span className="chips">
            {row.segments.slice(0, 3).map((segment) => (
              <Badge key={segment.id} value={segment.name} variant="neutral" />
            ))}
            {row.segments.length > 3 ? <span className="dim">+{row.segments.length - 3}</span> : null}
          </span>
        ) : (
          <span className="dim">—</span>
        ),
    },
    { header: "Status", cell: (row) => <Badge value={row.unsubscribed ? "unsubscribed" : "subscribed"} /> },
    { header: "Added", cell: (row) => <Time value={row.created_at} /> },
  ];

  // ListPage, laid out by hand so the stats strip sits between the tabs and the filters.
  return (
    <div className="page">
      <PageHeader
        title="Audience"
        learn={emptyAccount ? undefined : learnLinks("audience")}
        actions={
          <>
            <button type="button" className="secondary" onClick={() => setDialog("imports")}>
              Imports
            </button>
            {can && !emptyAccount ? (
              <>
                <button type="button" className="secondary" onClick={() => setDialog("import")}>
                  Import CSV
                </button>
                <button type="button" onClick={() => setDialog("add")}>
                  Add contact
                </button>
              </>
            ) : null}
          </>
        }
      />
      <Tabs tabs={audienceTabs} />
      {!emptyAccount ? <StatStrip stats={stats.data} /> : null}
      {!emptyAccount ? <FilterBar
        search="Search by email or name"
        filters={[
          {
            param: "segment_id",
            label: "Segments",
            options: (segments.data?.data ?? []).map((segment) => ({ value: segment.id, label: segment.name })),
          },
          { param: "subscribed", label: "Subscription", all: "Any subscription", options: subscriptionOptions },
        ]}
      >
        <button
          type="button"
          className="secondary icon"
          aria-label="Export this page as CSV"
          title="Export this page as CSV"
          disabled={!list.rows.length}
          onClick={exportPage}
        >
          <Download size={16} />
        </button>
      </FilterBar> : null}
      <Table
        columns={columns}
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => void list.reload()}
        onRowClick={(row) => navigate(`/audience/contacts/${row.id}`)}
        selection={selection}
        menu={(row) => (
          <Menu
            items={[
              { label: "Edit", onSelect: () => navigate(`/audience/contacts/${row.id}`) },
              { label: "Copy ID", read: true, onSelect: () => void copyText(row.id).then((ok) => ok && toast.success("ID copied.")) },
              "divider",
              { label: "Delete", danger: true, onSelect: () => setDeleting(row) },
            ]}
          />
        )}
        page={list.page}
        hasMore={list.hasMore}
        onNext={list.next}
        onPrevious={list.previous}
        noun="contacts"
        empty={
          filtered ? (
            <Empty title="No contacts match" body="Try different filters, or clear them to see everyone."
              action={<button type="button" className="secondary" onClick={() => setParams((current) => {
                const next = new URLSearchParams(current);
                for (const key of ["q", "subscribed", "segment_id"]) next.delete(key);
                return next;
              })}>Clear filters</button>} />
          ) : (
            <Empty title="No contacts yet" body="Add them one by one, import a CSV, or send them in through the API."
              action={can ? <>
                <button type="button" onClick={() => setDialog("add")}>Add your first contact</button>
                <button type="button" className="secondary" onClick={() => setDialog("import")}>Import CSV</button>
              </> : null} />
          )
        }
      />
      <BulkBar
        count={selection.count}
        onClear={selection.clear}
        actions={[
          { label: "Add to segments", onClick: () => setDialog("segment") },
          { label: "Delete", hint: "⌫", danger: true, onClick: () => setDialog("delete") },
        ]}
      />

      {dialog === "add" ? <AddContact onClose={close} onDone={refresh} /> : null}
      {dialog === "import" ? <ImportContacts onClose={close} onDone={refresh} /> : null}
      {dialog === "imports" ? <Imports onClose={close} onImport={can ? () => setDialog("import") : undefined} /> : null}
      {dialog === "segment" ? (
        <AddToSegment
          ids={selection.ids}
          segments={(segments.data?.data ?? []).filter((segment) => segment.type !== "dynamic")}
          onClose={close}
          onDone={() => {
            selection.clear();
            void segments.reload();
          }}
        />
      ) : null}
      {dialog === "delete" && count ? (
        <ConfirmPhrase
          title={`Delete ${count} contact${count === 1 ? "" : "s"}`}
          body="They leave every segment and topic. Their sent emails stay in the logs."
          phrase={phrase}
          action="Delete"
          onConfirm={() => removeAll(client, selection.ids)}
          onClose={close}
          onDone={() => {
            toast.success(count === 1 ? "Contact deleted." : `${count} contacts deleted.`);
            selection.clear();
            refresh();
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmPhrase
          title="Delete contact"
          body="The contact leaves every segment and topic. Their sent emails stay in the logs."
          phrase={deleting.email}
          action="Delete contact"
          onConfirm={() => client.delete(`/contacts/${deleting.id}`)}
          onClose={() => setDeleting(null)}
          onDone={() => {
            toast.success("Contact deleted.");
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Deletes each contact. There is no batch route, so this is one request per contact, sent one at
 * a time. A contact that is already gone counts as deleted, so trying again after a partial
 * failure finishes the job.
 */
export async function removeAll(client: ReturnType<typeof useClient>, ids: string[]) {
  const failed = await each(ids, (id) => client.delete(`/contacts/${id}`), { gone: true });
  if (failed.length) {
    throw new Error(`${failed.length} of ${ids.length} contacts could not be deleted: ${errorMessage(failed[0])}. Confirm again to retry them.`);
  }
}

function StatStrip({ stats }: { stats: ContactStats | null }) {
  const items = [
    { label: "All contacts", value: stats?.all },
    { label: "Subscribers", value: stats?.subscribed },
    { label: "Unsubscribers", value: stats?.unsubscribed },
  ];
  return (
    <dl className="statStrip" aria-label="Contact counts">
      {items.map((item) => (
        <div key={item.label} className="stat">
          <dt>{item.label}</dt>
          <dd>{item.value === undefined ? <Skeleton width="short" /> : item.value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

type Draft = { email: string; first_name: string; last_name: string };

function AddContact({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const properties = useAll<ContactProperty>("/contact-properties");
  const segments = useAll<Segment>("/segments");
  const topics = useAll<Topic>("/topics");
  const [form, setForm] = useState<Draft>({ email: "", first_name: "", last_name: "" });
  const [values, setValues] = useState<Record<string, string>>({});
  const [segmentIds, setSegmentIds] = useState<string[]>([]);
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const set = (key: keyof Draft) => (value: string) => setForm({ ...form, [key]: value });

  const { mutate, isLoading } = useMutation(
    () => client.post("/contacts", contactBody(form, values, properties.data?.data ?? [], segmentIds, topicIds)),
    {
      success: "Contact added.",
      onSuccess: () => {
        onDone();
        onClose();
      },
    },
  );

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

  return (
    <Modal isOpen size="large" title="Add contact" onClose={onClose} onSubmit={() => void mutate()} submitLabel="Add" submitting={isLoading}>
      <div className="stack">
        <div className="form two">
          <Field label="Email" type="email" value={form.email} onChange={set("email")} required autoFocus wide />
          <Field label="First name" value={form.first_name} onChange={set("first_name")} />
          <Field label="Last name" value={form.last_name} onChange={set("last_name")} />
          {(properties.data?.data ?? []).map((property) => (
            <Field
              key={property.id}
              label={property.key}
              mono
              type={property.type === "number" ? "number" : "text"}
              value={values[property.key] ?? ""}
              onChange={(value) => setValues({ ...values, [property.key]: value })}
              placeholder={property.fallback_value === null ? undefined : String(property.fallback_value)}
            />
          ))}
        </div>
        <div className="form two">
          <fieldset className="checkList">
            <legend>Segments</legend>
            {(segments.data?.data ?? []).filter((segment) => segment.type !== "dynamic").map((segment) => (
              <label key={segment.id} className="check">
                <input type="checkbox" checked={segmentIds.includes(segment.id)} onChange={() => setSegmentIds(toggle(segmentIds, segment.id))} />
                {segment.name}
              </label>
            ))}
            {segments.data?.data.length === 0 ? <p className="muted">No segments yet.</p> : null}
          </fieldset>
          <fieldset className="checkList">
            <legend>Topics</legend>
            {(topics.data?.data ?? []).map((topic) => (
              <label key={topic.id} className="check">
                <input type="checkbox" checked={topicIds.includes(topic.id)} onChange={() => setTopicIds(toggle(topicIds, topic.id))} />
                {topic.name}
              </label>
            ))}
            {topics.data?.data.length === 0 ? <p className="muted">No topics yet.</p> : null}
          </fieldset>
        </div>
      </div>
    </Modal>
  );
}

/** The `POST /contacts` body: empty fields left out, numbers typed, checked topics opted in. */
export function contactBody(
  form: Draft,
  values: Record<string, string>,
  definitions: Array<Pick<ContactProperty, "key" | "type">>,
  segmentIds: string[],
  topicIds: string[],
) {
  const body: Record<string, unknown> = { email: form.email.trim() };
  if (form.first_name.trim()) body.first_name = form.first_name.trim();
  if (form.last_name.trim()) body.last_name = form.last_name.trim();
  const properties: Record<string, string | number> = {};
  for (const definition of definitions) {
    const raw = values[definition.key]?.trim();
    if (!raw) continue;
    properties[definition.key] = definition.type === "number" ? Number(raw) : raw;
  }
  if (Object.keys(properties).length) body.properties = properties;
  if (segmentIds.length) body.segments = segmentIds.map((id) => ({ id }));
  if (topicIds.length) body.topics = topicIds.map((id) => ({ id, subscription: "opt_in" }));
  return body;
}

function AddToSegment({
  ids,
  segments,
  onClose,
  onDone,
}: {
  ids: string[];
  segments: Segment[];
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useClient();
  const [chosen, setChosen] = useState<string[]>([]);
  const toggle = (id: string) => setChosen((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  const { mutate, isLoading } = useMutation(() => addToSegments(client, ids, chosen), {
    success: `${ids.length === 1 ? "Contact" : `${ids.length} contacts`} added to ${chosen.length === 1 ? "segment" : `${chosen.length} segments`}.`,
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Modal
      isOpen
      size="small"
      title={`Add ${ids.length} contact${ids.length === 1 ? "" : "s"} to segments`}
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitLabel="Add"
      submitDisabled={chosen.length === 0}
      submitting={isLoading}
    >
      <fieldset className="checkList">
        <legend>Segments</legend>
        {segments.map((segment) => (
          <label key={segment.id} className="check">
            <input type="checkbox" checked={chosen.includes(segment.id)} onChange={() => toggle(segment.id)} />
            {segment.name}
          </label>
        ))}
        {segments.length === 0 ? <p className="muted">No segments yet.</p> : null}
      </fieldset>
    </Modal>
  );
}

/** Adds each contact to each segment. There is no batch route, so this is one request per pair. */
export async function addToSegments(client: ReturnType<typeof useClient>, ids: string[], segmentIds: string[]) {
  const pairs = ids.flatMap((id) => segmentIds.map((segmentId) => [id, segmentId] as const));
  // One at a time. Adding a contact that is already in the segment is not an error, so the whole
  // action can be run again after a failure.
  const failed = await each(pairs, ([id, segmentId]) => client.post(`/contacts/${id}/segments/${segmentId}`));
  if (failed.length) throw new Error(`${failed.length} of ${pairs.length} additions failed: ${errorMessage(failed[0])}. Add again to retry them.`);
}
