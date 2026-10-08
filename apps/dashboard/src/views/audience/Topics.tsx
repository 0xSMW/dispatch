import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Tag } from "lucide-react";
import { Badge } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { copyText } from "../../components/Copy";
import { Dropdown } from "../../components/Dropdown";
import { Drawer } from "../../components/Drawer";
import { Empty } from "../../components/Empty";
import { Field, Select, TextArea } from "../../components/Field";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { PageHeader, Tile } from "../../components/PageHeader";
import { Table } from "../../components/Table";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { emptyBody } from "../../lib/utils";
import { useCan, useClient } from "../../shell/session";
import type { BrandSettings, Topic, TopicSubscription } from "../../types";
import { PreferenceCard, previewBrand } from "../public/Preferences";
import { audienceTabs } from "../tabs";
import "../../styles/audience.css";

const defaultLabel = (value: Topic["default_subscription"] | "pending") => (value === "pending" ? "Pending confirmation" : value === "opt_in" ? "Subscribed" : "Not subscribed");

/** Topics, with a live preview of the preference page beside the table. */
export function Topics() {
  const client = useClient();
  const can = useCan();
  const list = useList<Topic>("/topics");
  const brand = useResource<BrandSettings>("/brand");
  const empty = !list.loading && !list.error && list.page === 1 && list.rows.length === 0;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Topic | null>(null);
  const [deleting, setDeleting] = useState<Topic | null>(null);
  const [open, setOpen] = useState<Topic | null>(null);

  // A private topic shows only to contacts already opted in, so the preview shows public topics.
  const visible = list.rows
    .filter((topic) => topic.visibility === "public")
    .map((topic) => ({ id: topic.id, name: topic.name, description: topic.description, subscription: topic.default_subscription }));

  return (
    <div className="page">
      <PageHeader
        title="Audience"
        actions={
          can && !empty ? (
            <button type="button" onClick={() => setCreating(true)}>
              Create topic
            </button>
          ) : null
        }
      />
      <Tabs tabs={audienceTabs} />
      <div className={empty ? "emptyPage" : "splitLayout"}>
        <Table
          rows={list.rows}
          loading={list.loading}
          error={list.error}
          onRetry={() => void list.reload()}
          onRowClick={setOpen}
          page={list.page}
          hasMore={list.hasMore}
          onNext={list.next}
          onPrevious={list.previous}
          noun="topics"
          empty={<Empty title="No topics yet" body="Topics let contacts choose which emails they get. Create your first one."
            action={can ? <button type="button" onClick={() => setCreating(true)}>Create topic</button> : null} />}
          columns={[
            {
              header: "Name",
              cell: (row) => (
                <span className="cellMain">
                  <Tile>
                    <Tag size={14} />
                  </Tile>
                  {row.name}
                </span>
              ),
            },
            { header: <span title="Applies when a contact has not chosen a preference for this topic.">Subscription default</span>, key: "default", cell: (row) => <Badge value={row.default_subscription} variant="neutral" className="subscriptionDefault" label={defaultLabel(row.default_subscription)} /> },
            { header: "Visibility", cell: (row) => <Badge value={row.visibility} variant={row.visibility === "public" ? "info" : "neutral"} /> },
            { header: "Created", cell: (row) => <Time value={row.created_at} /> },
          ]}
          menu={(row) => (
            <Menu
              items={[
                { label: "View subscribers", read: true, onSelect: () => setOpen(row) },
                { label: "Edit", onSelect: () => setEditing(row) },
                { label: "Copy ID", read: true, onSelect: () => void copyText(row.id).then((ok) => ok && toast.success("ID copied.")) },
                "divider",
                { label: "Delete", danger: true, onSelect: () => setDeleting(row) },
              ]}
            />
          )}
        />
        {!empty ? <aside className="previewPane" aria-label="Preference page preview">
          <span className="previewLabel">Preference page preview</span>
          <PreferenceCard
            brand={previewBrand(brand.data)}
            email="contact@example.com"
            topics={visible}
            checked={Object.fromEntries(visible.map((topic) => [topic.id, topic.subscription === "opt_in"]))}
            preview
          />
          <p className="searchNote">
            Shows public topics with their defaults. Logo and color come from <Link to="/settings/brand">brand settings</Link>.
          </p>
        </aside> : null}
      </div>

      {creating ? <CreateTopic onClose={() => setCreating(false)} onDone={list.reload} /> : null}
      {editing ? <EditTopic topic={editing} onClose={() => setEditing(null)} onDone={list.reload} /> : null}
      {open ? <Subscriptions topic={open} onClose={() => setOpen(null)} /> : null}
      {deleting ? (
        <ConfirmPhrase
          title="Delete topic"
          body="Contacts lose their choice for this topic, and it leaves the preference page. Broadcasts sent to it stop filtering by it."
          phrase={deleting.name}
          action="Delete topic"
          onConfirm={() => client.delete(`/topics/${deleting.id}`)}
          onClose={() => setDeleting(null)}
          onDone={() => {
            toast.success("Topic deleted.");
            void list.reload();
          }}
        />
      ) : null}
    </div>
  );
}

const blank = { name: "", key: "", description: "", default_subscription: "opt_in", visibility: "private" };

function CreateTopic({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [form, setForm] = useState(blank);
  const set = (key: keyof typeof blank) => (value: string) => setForm({ ...form, [key]: value });
  const { mutate, isLoading } = useMutation(() => client.post("/topics", emptyBody(form)), {
    success: "Topic created.",
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Modal
      isOpen
      title="Create topic"
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitLabel="Create"
      submitDisabled={!form.name.trim() || form.name.length > 50 || form.description.length > 200}
      submitting={isLoading}
    >
      <div className="form">
        <p className="muted">Topics control which emails contacts receive. Segments group contacts for targeting.</p>
        <Field label="Name" value={form.name} onChange={set("name")} placeholder="Product updates" required autoFocus hint="50 characters at most." />
        <TextArea label="Description" value={form.description} onChange={set("description")} rows={2} hint={`${form.description.length} of 200 characters. Shown on the preference page.`} />
        <Field label="Key" value={form.key} onChange={set("key")} placeholder="product-updates" mono hint="Defaults to the name in lowercase with dashes." />
        <Select
          label="Subscription default"
          value={form.default_subscription}
          onChange={set("default_subscription")}
          options={[
            { value: "opt_in", label: "Subscribed" },
            { value: "opt_out", label: "Not subscribed" },
          ]}
          hint="Applies when a contact has not chosen a preference. This cannot change later."
        />
        <Select
          label="Visibility"
          value={form.visibility}
          onChange={set("visibility")}
          options={[
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ]}
          hint="A private topic shows on the preference page only to contacts already opted in."
        />
      </div>
    </Modal>
  );
}

function EditTopic({ topic, onClose, onDone }: { topic: Topic; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [form, setForm] = useState({ name: topic.name, description: topic.description ?? "", visibility: topic.visibility });
  const { mutate, isLoading } = useMutation(
    () =>
      client.patch(`/topics/${topic.id}`, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        visibility: form.visibility,
      }),
    {
      success: "Topic saved.",
      onSuccess: () => {
        onDone();
        onClose();
      },
    },
  );

  return (
    <Modal
      isOpen
      title="Edit topic"
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitDisabled={!form.name.trim() || form.name.length > 50 || form.description.length > 200}
      submitting={isLoading}
    >
      <div className="form">
        <Field label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} required autoFocus />
        <TextArea label="Description" value={form.description} onChange={(description) => setForm({ ...form, description })} rows={2} />
        <Select
          label="Visibility"
          value={form.visibility}
          onChange={(visibility) => setForm({ ...form, visibility: visibility as Topic["visibility"] })}
          options={[
            { value: "private", label: "Private" },
            { value: "public", label: "Public" },
          ]}
        />
        <Field label="Subscription default" value={defaultLabel(topic.default_subscription)} onChange={() => undefined} disabled hint="Applies when a contact has not chosen a preference. Set at creation and fixed." />
      </div>
    </Modal>
  );
}

function Subscriptions({ topic, onClose }: { topic: Topic; onClose: () => void }) {
  const client = useClient();
  const can = useCan();
  const subscriptions = useList<TopicSubscription>(`/topics/${topic.id}/subscriptions`, {}, { limit: 20 });
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"opt_in" | "opt_out">("opt_in");
  const save = useMutation(
    (input: { email: string; status: "opt_in" | "opt_out" }) => client.post(`/topics/${topic.id}/subscriptions`, input),
    {
      success: "Subscription saved.",
      onSuccess: () => {
        setEmail("");
        void subscriptions.reload();
      },
    },
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    void save.mutate({ email: email.trim(), status });
  }

  return (
    <Drawer isOpen title={topic.name} label="Topic" onClose={onClose}>
      <div className="stack">
        {topic.description ? <p className="muted">{topic.description}</p> : null}
        {can ? (
          <form className="inlineForm" onSubmit={submit}>
            <input type="email" aria-label="Email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            <Dropdown aria-label="Subscription" value={status} onChange={(event) => setStatus(event.target.value as "opt_in" | "opt_out")}>
              <option value="opt_in">Subscribed</option>
              <option value="opt_out">Not subscribed</option>
            </Dropdown>
            <button type="submit" disabled={save.isLoading}>
              Save
            </button>
          </form>
        ) : null}
        <Table
          compact
          rows={subscriptions.rows}
          loading={subscriptions.loading}
          error={subscriptions.error}
          onRetry={() => void subscriptions.reload()}
          empty={<p className="muted">Nobody has chosen yet, so everyone gets the default: {defaultLabel(topic.default_subscription).toLowerCase()}.</p>}
          page={subscriptions.page}
          hasMore={subscriptions.hasMore}
          onNext={subscriptions.next}
          onPrevious={subscriptions.previous}
          columns={[
            { header: "Email", cell: (row) => <Link to={`/audience/contacts/${row.contact_id}`}>{row.email}</Link> },
            { header: "Status", cell: (row) => <Badge value={row.subscription} label={defaultLabel(row.subscription)} /> },
            {
              header: "",
              key: "toggle",
              cell: (row) => (
                can ? (
                  <button
                    type="button"
                    className="ghost small"
                    disabled={save.isLoading}
                    onClick={() => void save.mutate({ email: row.email, status: row.subscription === "opt_in" ? "opt_out" : "opt_in" })}
                  >
                    {row.subscription === "opt_in" ? "Opt out" : "Opt in"}
                  </button>
                ) : null
              ),
            },
            { header: "Since", cell: (row) => <Time value={row.updated_at ?? row.created_at} /> },
          ]}
        />
      </div>
    </Drawer>
  );
}
