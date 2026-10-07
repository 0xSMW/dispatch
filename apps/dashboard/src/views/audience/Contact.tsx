import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { User, X } from "lucide-react";
import { Badge } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { copyText } from "../../components/Copy";
import { Failed } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { Field, Switch } from "../../components/Field";
import { TypedValue } from "../../components/TypedValue";
import { typedValue, valueIssue } from "../../lib/rules";
import { metaKey } from "../../components/Kbd";
import { Menu } from "../../components/Menu";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useHotkey } from "../../hooks/useHotkey";
import { shortcuts } from "../../lib/shortcuts";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useAll, useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type {
  Contact as ContactRow,
  ContactActivity,
  ContactProperty,
  ContactSegment,
  ContactTopic,
  List,
  Segment,
  Topic,
  PropertyType,
} from "../../types";
import "../../styles/audience.css";

/** Contact detail: facts, editable properties, subscription, segments, topics, activity. */
export function Contact() {
  const { id = "" } = useParams<{ id: string }>();
  const client = useClient();
  const can = useCan();
  const navigate = useNavigate();
  const contact = useResource<ContactRow>(`/contacts/${encodeURIComponent(id)}`);
  const [deleting, setDeleting] = useState(false);

  const subscription = useMutation(
    (unsubscribed: boolean) => client.patch<ContactRow>(`/contacts/${encodeURIComponent(id)}`, { unsubscribed }),
    {
      success: (row) => (row.unsubscribed ? "Contact unsubscribed." : "Contact resubscribed."),
      onSuccess: (row) => contact.setData(row),
    },
  );

  if (contact.error) return <Failed message={contact.error} onRetry={contact.reload} />;
  const row = contact.data;

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/audience", label: "Audience" }}
        icon={<User size={20} />}
        tone={row ? (row.unsubscribed ? "danger" : "success") : "neutral"}
        label="Contact"
        title={row ? row.email : <Skeleton width="medium" />}
        actions={
          row ? (
            <>
              {can ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={subscription.isLoading}
                  onClick={() => void subscription.mutate(!row.unsubscribed)}
                >
                  {row.unsubscribed ? "Resubscribe" : "Unsubscribe"}
                </button>
              ) : null}
              <Menu
                items={[
                  { label: "Copy ID", onSelect: () => void copyText(row.id).then((ok) => ok && toast.success("ID copied.")) },
                  { label: "Delete contact", danger: true, hidden: !can, onSelect: () => setDeleting(true) },
                ]}
              />
            </>
          ) : null
        }
      />

      {row ? (
        <Facts
          items={[
            { label: "Email", value: row.email, copy: true },
            { label: "Status", value: <Badge value={row.unsubscribed ? "unsubscribed" : "subscribed"} /> },
            { label: "Created", value: <Time value={row.created_at} mode="absolute" /> },
            { label: "ID", value: row.id, copy: true },
          ]}
        />
      ) : (
        <Skeleton lines={2} />
      )}

      {row ? (
        <div className="columns">
          <Properties contact={row} onSaved={contact.setData} />
          <div className="stack">
            <Segments contactId={row.id} />
            <Topics contactId={row.id} />
          </div>
        </div>
      ) : null}

      {row ? <Activity contactId={row.id} /> : null}

      {deleting && row ? (
        <ConfirmPhrase
          title="Delete contact"
          body="The contact leaves every segment and topic. Their sent emails stay in the logs."
          phrase={row.email}
          action="Delete contact"
          onConfirm={() => client.delete(`/contacts/${row.id}`)}
          onClose={() => setDeleting(false)}
          onDone={() => {
            toast.success("Contact deleted.");
            navigate("/audience");
          }}
        />
      ) : null}
    </div>
  );
}

type Values = Record<string, string>;

function initial(contact: ContactRow): Values {
  const values: Values = { first_name: contact.first_name ?? "", last_name: contact.last_name ?? "" };
  for (const [key, entry] of Object.entries(contact.properties ?? {})) {
    values[`property:${key}`] = entry.value === null || entry.value === undefined ? "" : String(entry.value);
  }
  return values;
}

/** The `PATCH /contacts/:id` body: changed properties only. A cleared property is sent as null, which deletes it. */
export function propertyPatch(values: Values, types: Record<string, string>, before: Values = {}) {
  const properties: Record<string, string | number | boolean | null> = {};
  for (const [key, type] of Object.entries(types)) {
    const raw = (values[`property:${key}`] ?? "").trim();
    if (raw === (before[`property:${key}`] ?? "").trim()) continue;
    properties[key] = typedValue(type as PropertyType, raw);
  }
  return {
    first_name: values.first_name.trim() || null,
    last_name: values.last_name.trim() || null,
    properties,
  };
}

function Properties({ contact, onSaved }: { contact: ContactRow; onSaved: (row: ContactRow) => void }) {
  const client = useClient();
  const can = useCan();
  const definitions = useAll<ContactProperty>("/contact-properties");
  const [values, setValues] = useState<Values>(() => initial(contact));
  // Reset for another contact, and after this panel's own save. A change made elsewhere on the
  // page, such as Unsubscribe in the header, must not discard what is typed here.
  useEffect(() => setValues(initial(contact)), [contact.id]);

  // Defined properties first, then keys the contact carries that have no definition.
  const types: Record<string, string> = {};
  for (const definition of definitions.data?.data ?? []) types[definition.key] = definition.type;
  for (const [key, entry] of Object.entries(contact.properties ?? {})) types[key] ??= entry.type;
  const fallbacks = new Map((definitions.data?.data ?? []).map((definition) => [definition.key, definition.fallback_value]));
  const before = initial(contact);
  const issues = Object.fromEntries(Object.entries(types).map(([key, type]) => [
    key, values[`property:${key}`] === before[`property:${key}`] ? null : valueIssue(type as PropertyType, values[`property:${key}`] ?? ""),
  ]));
  const invalid = Object.values(issues).some(Boolean);

  const save = useMutation(
    () => client.patch<ContactRow>(`/contacts/${contact.id}`, propertyPatch(values, types, before)),
    {
      success: "Contact saved.",
      onSuccess: (row) => {
        setValues(initial(row));
        onSaved(row);
      },
    },
  );
  const dirty = JSON.stringify(values) !== JSON.stringify(before);
  useHotkey(shortcuts.save.combo, () => void save.mutate(), { enabled: can && dirty && !invalid && !save.isLoading });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (can && !invalid) void save.mutate();
  }

  const set = (key: string) => (value: string) => setValues((current) => ({ ...current, [key]: value }));

  return (
    <Panel
      title="Properties"
      actions={
        <Link className="button ghost small" to="/audience/properties">
          Manage
        </Link>
      }
    >
      <form className="stack" onSubmit={submit}>
        <div className="form two">
          <Field label="First name" value={values.first_name ?? ""} onChange={set("first_name")} disabled={!can} />
          <Field label="Last name" value={values.last_name ?? ""} onChange={set("last_name")} disabled={!can} />
          {Object.entries(types).map(([key, type]) => {
            const fallback = fallbacks.get(key);
            return (
              <TypedValue
                key={`${key}:${type}`}
                label={key}
                type={type as PropertyType}
                value={values[`property:${key}`] ?? ""}
                onChange={set(`property:${key}`)}
                placeholder={fallback === null || fallback === undefined ? undefined : String(fallback)}
                hint={fallbacks.has(key) ? fallback === null || fallback === undefined ? undefined : `Fallback: ${String(fallback)}` : "Not a defined property."}
                disabled={!can}
                error={issues[key]}
                nullable
              />
            );
          })}
        </div>
        {definitions.loading ? <Skeleton lines={1} width="medium" /> : null}
        {can ? (
          <div className="toolbar">
            <button type="submit" disabled={!dirty || invalid || save.isLoading} aria-busy={save.isLoading}>
              {save.isLoading ? <span className="spinner" aria-hidden /> : null}
              Save <kbd>{metaKey}S</kbd>
            </button>
            {dirty ? (
              <button type="button" className="ghost" onClick={() => setValues(initial(contact))}>
                Discard
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
    </Panel>
  );
}

function Segments({ contactId }: { contactId: string }) {
  const client = useClient();
  const can = useCan();
  const member = useAll<ContactSegment>(`/contacts/${contactId}/segments`);
  const all = useAll<Segment>("/segments");
  const [choice, setChoice] = useState("");
  const current = member.data?.data ?? [];
  const available = (all.data?.data ?? []).filter((segment) => segment.type !== "dynamic" && !current.some((item) => item.id === segment.id));

  const add = useMutation((segmentId: string) => client.post(`/contacts/${contactId}/segments/${segmentId}`), {
    success: "Added to segment.",
    onSuccess: () => {
      setChoice("");
      void member.reload();
    },
  });
  const remove = useMutation((segmentId: string) => client.delete(`/contacts/${contactId}/segments/${segmentId}`), {
    success: "Removed from segment.",
    onSuccess: () => void member.reload(),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (choice) void add.mutate(choice);
  }

  return (
    <Panel title="Segments">
      <div className="stack">
        {member.error ? <Failed message={member.error} onRetry={member.reload} /> : null}
        {member.loading && !member.data ? <Skeleton lines={1} /> : null}
        {member.data ? (
          current.length ? (
            <div className="chipList">
              {current.map((segment) => (
                <span key={segment.id} className="tagChip">
                  {segment.name}
                  {can && segment.type !== "dynamic" ? (
                    <button
                      type="button"
                      className="ghost icon small"
                      aria-label={`Remove from ${segment.name}`}
                      disabled={remove.isLoading}
                      onClick={() => void remove.mutate(segment.id)}
                    >
                      <X size={12} />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">Not in any segment.</p>
          )
        ) : null}
        {can && available.length ? (
          <form className="inlineForm" onSubmit={submit}>
            <select aria-label="Segment" value={choice} onChange={(event) => setChoice(event.target.value)}>
              <option value="">Choose a segment</option>
              {available.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name}
                </option>
              ))}
            </select>
            <button type="submit" className="secondary" disabled={!choice || add.isLoading}>
              Add
            </button>
          </form>
        ) : null}
      </div>
    </Panel>
  );
}

function Topics({ contactId }: { contactId: string }) {
  const client = useClient();
  const can = useCan();
  const mine = useResource<List<ContactTopic>>(`/contacts/${contactId}/topics`);
  const all = useAll<Topic>("/topics");
  // The API lists every topic with its effective state, and marks the ones the contact chose.
  const explicit = new Map((mine.data?.data ?? []).filter((topic) => topic.explicit !== false).map((topic) => [topic.id, topic.subscription]));

  const update = useMutation(
    (input: { id: string; subscription: "opt_in" | "opt_out" }) =>
      client.patch<List<ContactTopic>>(`/contacts/${contactId}/topics`, { topics: [input] }),
    {
      success: "Subscription updated.",
      onSuccess: (data) => mine.setData(data),
    },
  );

  const topics = all.data?.data ?? [];
  return (
    <Panel title="Topics">
      {all.error || mine.error ? <Failed message={(all.error ?? mine.error)!} onRetry={() => void Promise.all([all.reload(), mine.reload()])} /> : null}
      {!all.data || !mine.data ? (
        all.error || mine.error ? null : <Skeleton lines={2} />
      ) : topics.length ? (
        <div>
          {topics.map((topic) => {
            const set = explicit.get(topic.id);
            const subscribed = (set ?? topic.default_subscription) === "opt_in";
            return (
              <div key={topic.id} className="topicRow">
                <div>
                  {topic.name}
                  <small>{set ? (set === "opt_in" ? "Opted in" : "Opted out") : `Default: ${topic.default_subscription === "opt_in" ? "opt in" : "opt out"}`}</small>
                </div>
                <Switch
                  label={subscribed ? "Subscribed" : "Not subscribed"}
                  checked={subscribed}
                  disabled={!can || update.isLoading}
                  onChange={(checked) => void update.mutate({ id: topic.id, subscription: checked ? "opt_in" : "opt_out" })}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted">
          No topics yet. <Link to="/audience/topics">Create a topic</Link>.
        </p>
      )}
    </Panel>
  );
}

const activityLabels: Record<string, string> = {
  "contact.created": "Contact created",
  "segment.added": "Added to segment",
  "topic.opted_in": "Opted in",
  "topic.opted_out": "Opted out",
  "event.fired": "Event received",
  "automation.run.started": "Automation run started",
  "automation.run.completed": "Automation run ended",
};

const activityTone = (type: string) =>
  type === "topic.opted_in" ? ("success" as const) : type === "topic.opted_out" ? ("danger" as const) : undefined;

const exitReasons = {
  completed: "Reached the end",
  exit: "Exit step",
  filter: "Filter did not match",
  stopped: "Automation stopped",
  stranded: "Waiting step removed or changed",
};

function Activity({ contactId }: { contactId: string }) {
  const list = useList<ContactActivity>(`/contacts/${contactId}/activity`, {}, { limit: 20 });
  return (
    <Panel title="Activity">
      <Table
        compact
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => void list.reload()}
        empty={<p className="muted">No activity yet.</p>}
        page={list.page}
        hasMore={list.hasMore}
        onNext={list.next}
        onPrevious={list.previous}
        columns={[
          {
            header: "Event",
            cell: (row) => (
              <Badge value={row.type} variant={activityTone(row.type)} label={activityLabels[row.type] ?? row.type.replace("email.", "Email ")} />
            ),
          },
          {
            header: "Detail",
            cell: (row) =>
              row.email_id ? (
                <Link to={`/emails/${row.email_id}`}>{row.label || row.email_id}</Link>
              ) : row.automation_id && row.run_id ? (
                <>
                  <Link to={`/automations/${encodeURIComponent(row.automation_id)}/editor?tab=runs&run=${encodeURIComponent(row.run_id)}`}>{row.label || row.run_id}</Link>
                  {row.type === "automation.run.completed" && row.exit_reason && exitReasons[row.exit_reason] && (
                    <span className="muted"> · {exitReasons[row.exit_reason]}</span>
                  )}
                </>
              ) : row.type.startsWith("segment.") ? (
                <Link to="/audience/segments">{row.label}</Link>
              ) : row.type.startsWith("topic.") ? (
                <Link to="/audience/topics">{row.label}</Link>
              ) : (
                <span className="truncate">{row.label ?? ""}</span>
              ),
          },
          { header: "When", cell: (row) => <Time value={row.created_at} mode="absolute" /> },
        ]}
      />
    </Panel>
  );
}
