import { Dropdown } from "../../components/Dropdown";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Badge } from "../../components/Badge";
import { Drawer } from "../../components/Drawer";
import { Empty, Failed } from "../../components/Empty";
import { Select, Switch } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Time } from "../../components/Time";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useAll, useResource } from "../../hooks/useResource";
import { errorMessage } from "../../lib/client";
import { useCan, useClient } from "../../shell/session";
import type { Automation, ContactImport, ContactProperty, List, Segment, Settings, Topic } from "../../types";
import { automationTrigger } from "../automations/graph";
import { isEnabled } from "../automations/Stop";
import { columnMap, countRows, guessMapping, readHead, type FieldName, type Mapping, type PropertyType } from "./csv";
import "../../styles/audience.css";

type Step = "upload" | "map" | "audience" | "review";
const steps: Array<{ id: Step; label: string }> = [
  { id: "upload", label: "Upload" },
  { id: "map", label: "Map columns" },
  { id: "audience", label: "Segments and topics" },
  { id: "review", label: "Review" },
];

const fields: Array<{ id: FieldName; label: string }> = [
  { id: "email", label: "Email" },
  { id: "first_name", label: "First name" },
  { id: "last_name", label: "Last name" },
  { id: "unsubscribed", label: "Unsubscribed" },
];

export const maxImportBytes = 200 * 1024 * 1024;

/** The first header that appears twice, ignoring case. The worker refuses such a file. */
export function duplicateHeader(headers: string[]): string | null {
  const seen = new Set<string>();
  for (const header of headers) {
    const key = header.toLowerCase();
    if (key && seen.has(key)) return header;
    seen.add(key);
  }
  return null;
}

/** Property keys that more than one included column maps to. Only one of them would be imported. */
export function keyCollisions(mapping: Mapping): string[] {
  const counts = new Map<string, number>();
  for (const item of mapping.properties) if (item.include && item.key) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([key]) => key);
}

/** Upload, map columns, choose segments and topics, review, then watch the import run. */
export function ImportContacts({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const segments = useAll<Segment>("/segments");
  const topics = useAll<Topic>("/topics");
  const properties = useAll<ContactProperty>("/contact-properties");
  const settings = useResource<Settings>("/settings");
  // Null follows the tenant default until the user makes an explicit choice.
  const [triggerChoice, setTriggerChoice] = useState<boolean | null>(null);
  const triggerAutomations = triggerChoice ?? settings.data?.import_trigger_automations ?? false;
  const automations = useAll<Automation>(triggerAutomations ? "/automations" : null);
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [head, setHead] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [onConflict, setOnConflict] = useState<"upsert" | "skip">("upsert");
  const [segmentIds, setSegmentIds] = useState<string[]>([]);
  const [topicChoice, setTopicChoice] = useState<Record<string, "opt_in" | "opt_out">>({});
  const [started, setStarted] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const reading = useRef<AbortController | null>(null);
  useEffect(() => () => reading.current?.abort(), []);

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const next = event.target.files?.[0] ?? null;
    setFile(next);
    setHead(null);
    setReadError(null);
    setMapping(null);
    setRowCount(null);
    if (!next) return;
    try {
      // Checked here, so a file the API would refuse is not uploaded first.
      if (next.size > maxImportBytes) throw new Error("The file is over the 200 MB limit.");
      const parsed = await readHead(next);
      if (controller.signal.aborted) return;
      if (!parsed.headers.length) throw new Error("The file has no header row.");
      const repeated = duplicateHeader(parsed.headers);
      if (repeated) throw new Error(`The CSV has two columns named "${repeated}". Rename one and choose the file again.`);
      setHead(parsed);
      setMapping(guessMapping(parsed.headers, properties.data?.data ?? []));
      const count = await countRows(next, controller.signal);
      if (!controller.signal.aborted) setRowCount(count);
    } catch (error) {
      if (controller.signal.aborted) return;
      setReadError(errorMessage(error));
      setHead(null);
      setMapping(null);
    }
  }

  const start = useMutation(
    () => {
      const form = new FormData();
      form.append("column_map", JSON.stringify(columnMap(mapping!, properties.data?.data)));
      form.append("on_conflict", onConflict);
      form.append("trigger_automations", String(triggerAutomations));
      form.append("segments", JSON.stringify(segmentIds.map((id) => ({ id }))));
      form.append(
        "topics",
        JSON.stringify(Object.entries(topicChoice).map(([id, subscription]) => ({ id, subscription }))),
      );
      // Fields before the file: the API reads parts in order and stores the file as it streams.
      form.append("file", file!, file!.name);
      return client.upload<Pick<ContactImport, "object" | "id" | "trigger_automations">>("/contacts/imports", form);
    },
    { success: "Import started.", onSuccess: (result) => {
      reading.current?.abort();
      setStarted(result.id);
    } },
  );

  if (started) {
    return (
      <Modal
        isOpen
        title="Import contacts"
        onClose={onClose}
        actions={
          <button type="button" className="secondary" onClick={onClose}>
            Close <kbd>Esc</kbd>
          </button>
        }
      >
        <ImportProgress id={started} onFinish={onDone} />
      </Modal>
    );
  }

  const index = steps.findIndex((item) => item.id === step);
  const ready = Boolean(head && mapping);
  const collisions = mapping ? keyCollisions(mapping) : [];
  const blocked = (step === "map" && (!mapping?.email || collisions.length > 0)) || !ready
    || (step === "review" && ((triggerChoice === null && settings.loading) || (triggerAutomations && (rowCount === null || automations.loading || !!automations.error))));
  const matching = (automations.data?.data ?? []).filter((automation) => {
    if (!isEnabled(automation)) return false;
    const trigger = automationTrigger(automation);
    return trigger.type === "contact_created"
      || (trigger.type === "topic_subscribed" && topicChoice[trigger.topic_id] === "opt_in")
      || (trigger.type === "segment_added" && segmentIds.includes(trigger.segment_id));
  });

  function next() {
    if (blocked || start.isLoading) return;
    if (step === "review") void start.mutate();
    else setStep(steps[index + 1].id);
  }

  return (
    <Modal
      isOpen
      size="large"
      title="Import contacts"
      onClose={onClose}
      onSubmit={next}
      submitLabel={step === "review" ? "Start import" : "Next"}
      submitDisabled={blocked}
      submitting={start.isLoading}
      actions={
        <>
          {index > 0 ? (
            <button type="button" className="secondary" onClick={() => setStep(steps[index - 1].id)} disabled={start.isLoading}>
              Back
            </button>
          ) : (
            <button type="button" className="secondary" onClick={onClose}>
              Cancel <kbd>Esc</kbd>
            </button>
          )}
          <button type="submit" disabled={blocked || start.isLoading} aria-busy={start.isLoading}>
            {start.isLoading ? <span className="spinner" aria-hidden /> : null}
            {step === "review" ? "Start import" : "Next"}
          </button>
        </>
      }
    >
      <div className="stack">
        <ol className="importSteps" aria-label="Import steps">
          {steps.map((item, position) => (
            <li key={item.id} className={position === index ? "active" : position < index ? "done" : undefined}>
              {position + 1}. {item.label}
            </li>
          ))}
        </ol>

        {step === "upload" ? (
          <div className="stack">
            <div className="field">
              <label htmlFor="import-file">CSV file</label>
              <input id="import-file" type="file" accept=".csv,text/csv" onChange={(event) => void choose(event)} />
              <span className="fieldHint">The first row must name the columns. Up to 200 MB.</span>
            </div>
            {readError ? <p className="fieldError">{readError}</p> : null}
            {head ? (
              <Table
                compact
                rows={head.rows.map((cells, row) => ({ id: String(row), cells }))}
                empty={<p className="muted">No rows found in the first 64 KB of this file.</p>}
                columns={head.headers.map((header, column) => ({
                  header,
                  key: `${column}-${header}`,
                  cell: (row: { cells: string[] }) => <span className="truncate">{row.cells[column] ?? ""}</span>,
                }))}
              />
            ) : null}
          </div>
        ) : null}

        {step === "map" && mapping && head ? (
          <MapColumns headers={head.headers} mapping={mapping} onChange={setMapping} onConflict={onConflict} setOnConflict={setOnConflict} properties={properties.data?.data ?? []} />
        ) : null}

        {step === "audience" ? (
          <div className="form two">
            <fieldset className="checkList">
              <legend>Add to segments</legend>
              {segments.loading ? <Skeleton lines={2} /> : null}
              {(segments.data?.data ?? []).filter((segment) => segment.type !== "dynamic").map((segment) => (
                <label key={segment.id} className="check">
                  <input
                    type="checkbox"
                    checked={segmentIds.includes(segment.id)}
                    onChange={() =>
                      setSegmentIds((current) =>
                        current.includes(segment.id) ? current.filter((id) => id !== segment.id) : [...current, segment.id],
                      )
                    }
                  />
                  {segment.name}
                </label>
              ))}
              {segments.data?.data.length === 0 ? <p className="muted">No segments yet.</p> : null}
            </fieldset>
            <fieldset className="checkList">
              <legend>Subscribe to topics</legend>
              <p className="fieldHint">A contact who has opted out of a topic stays opted out. An import never opts them back in.</p>
              {topics.loading ? <Skeleton lines={2} /> : null}
              {(topics.data?.data ?? []).map((topic) => (
                <div key={topic.id} className="topicRow">
                  <span>{topic.name}</span>
                  <Dropdown
                    aria-label={`${topic.name} subscription`}
                    value={topicChoice[topic.id] ?? ""}
                    onChange={(event) =>
                      setTopicChoice((current) => {
                        const nextChoice = { ...current };
                        if (event.target.value) nextChoice[topic.id] = event.target.value as "opt_in" | "opt_out";
                        else delete nextChoice[topic.id];
                        return nextChoice;
                      })
                    }
                  >
                    <option value="">Leave as is</option>
                    <option value="opt_in">Opt in</option>
                    <option value="opt_out">Opt out</option>
                  </Dropdown>
                </div>
              ))}
              {topics.data?.data.length === 0 ? <p className="muted">No topics yet.</p> : null}
            </fieldset>
          </div>
        ) : null}

        {step === "review" && mapping ? (
          <ul className="reviewList">
            <li>
              <span>File</span>
              <span className="mono">{file?.name}</span>
            </li>
            <li>
              <span>Data rows</span>
              <span>{rowCount === null ? "Counting…" : rowCount.toLocaleString()}</span>
            </li>
            {fields.map((field) => (
              <li key={field.id}>
                <span>{field.label}</span>
                <span className="mono">{mapping[field.id] || "not mapped"}</span>
              </li>
            ))}
            <li>
              <span>Properties</span>
              <span className="mono">
                {mapping.properties.filter((item) => item.include).map((item) => item.key).join(", ") || "none"}
              </span>
            </li>
            <li>
              <span>Existing contacts</span>
              <span>{onConflict === "upsert" ? "Update" : "Skip"}</span>
            </li>
            <li>
              <span>Segments</span>
              <span>
                {(segments.data?.data ?? [])
                  .filter((segment) => segmentIds.includes(segment.id))
                  .map((segment) => segment.name)
                  .join(", ") || "none"}
              </span>
            </li>
            <li>
              <span>Topics</span>
              <span>
                {(topics.data?.data ?? [])
                  .filter((topic) => topicChoice[topic.id])
                  .map((topic) => `${topic.name} (${topicChoice[topic.id] === "opt_in" ? "opt in" : "opt out"})`)
                  .join(", ") || "none"}
              </span>
            </li>
          </ul>
        ) : null}
        {step === "audience" || step === "review" ? (
          <div className="stack">
            <Switch
              label="Start automations for these contacts"
              checked={triggerAutomations}
              onChange={setTriggerChoice}
              disabled={start.isLoading}
            />
            <p className="fieldHint">This import can override the default in Settings, General.</p>
            {settings.loading && triggerChoice === null ? <p className="fieldHint" role="status">Loading the import default…</p> : null}
            {settings.error ? <p className="fieldHint">Could not load the import default. Automations stay off unless you turn them on.</p> : null}
            {triggerAutomations ? (
              <>
                <p className="notice warning" role="status">Matching enabled automations may send emails immediately or after their configured waits. This import does not create or enable automations. Contact changes do not trigger automations during imports.</p>
                {rowCount !== null && rowCount > 10000 ? (
                  <p className="notice warning" role="status">This file has {rowCount.toLocaleString()} data rows, more than 10,000. Starting automations for a large import may send many emails.</p>
                ) : null}
                {automations.loading ? <p className="fieldHint" role="status">Loading matching automations…</p> : automations.error ? (
                  <Failed message={`Could not load matching automations: ${automations.error}`} onRetry={automations.reload} />
                ) : (
                  <div>
                    <p>{matching.length.toLocaleString()} matching enabled {matching.length === 1 ? "automation" : "automations"}</p>
                    {matching.length ? <ul>{matching.map((automation) => <li key={automation.id}>{automation.name}</li>)}</ul> : null}
                  </div>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function MapColumns({
  headers,
  mapping,
  onChange,
  onConflict,
  setOnConflict,
  properties,
}: {
  headers: string[];
  mapping: Mapping;
  onChange: (mapping: Mapping) => void;
  onConflict: "upsert" | "skip";
  setOnConflict: (value: "upsert" | "skip") => void;
  properties: ContactProperty[];
}) {
  const options = headers.map((header) => ({ value: header, label: header }));
  return (
    <div className="stack">
      <div className="form two">
        {fields.map((field) => (
          <Select
            key={field.id}
            label={field.label}
            value={mapping[field.id]}
            onChange={(value) => onChange({ ...mapping, [field.id]: value })}
            options={options}
            placeholder={field.id === "email" ? "Choose a column" : "Do not import"}
            required={field.id === "email"}
            error={field.id === "email" && !mapping.email ? "Map a column to email." : null}
          />
        ))}
        <Select
          label="Existing contacts"
          value={onConflict}
          onChange={(value) => setOnConflict(value as "upsert" | "skip")}
          options={[
            { value: "upsert", label: "Update them" },
            { value: "skip", label: "Skip them" },
          ]}
        />
      </div>
      {mapping.properties.length ? (
        <div className="mapTable" role="group" aria-label="Properties">
          <div className="mapRow head">
            <span>Column</span>
            <span>Property key</span>
            <span>Type</span>
          </div>
          {mapping.properties.map((item, position) => {
            const declared = properties.find((property) => property.key === item.key);
            const update = (patch: Partial<typeof item>) =>
              onChange({
                ...mapping,
                properties: mapping.properties.map((current, at) => (at === position ? { ...current, ...patch } : current)),
              });
            return (
              <div key={item.column} className="mapRow">
                <label className="check">
                  <input type="checkbox" checked={item.include} onChange={() => update({ include: !item.include })} />
                  <span>{item.column}</span>
                </label>
                <input
                  aria-label={`Property key for ${item.column}`}
                  className="mono"
                  value={item.key}
                  disabled={!item.include}
                  onChange={(event) => {
                    const key = event.target.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 50);
                    const property = properties.find((row) => row.key === key);
                    update({ key, ...(property ? { type: property.type } : {}) });
                  }}
                />
                <Dropdown
                  aria-label={`Type for ${item.column}`}
                  value={declared?.type ?? item.type}
                  disabled={!item.include || Boolean(declared)}
                  onChange={(event) => update({ type: event.target.value as PropertyType })}
                >
                  <option value="string">String</option>
                  <option value="number">Number</option>
                  <option value="boolean">True or false</option>
                  <option value="date">Date</option>
                </Dropdown>
              </div>
            );
          })}
        </div>
      ) : null}
      {keyCollisions(mapping).length ? (
        <p className="fieldError" role="alert">
          More than one column maps to {keyCollisions(mapping).join(", ")}. Give each column its own property key, or untick one.
        </p>
      ) : null}
    </div>
  );
}

const finished = (status: ContactImport["status"]) => status === "completed" || status === "failed" || status === "cancelled";
const importTone = (status: ContactImport["status"]) => (status === "in_progress" ? ("info" as const) : undefined);

/** Polls `GET /contacts/imports/:id` until the import finishes, then calls `onFinish` once. */
export function ImportProgress({ id, onFinish }: { id: string; onFinish?: () => void }) {
  const client = useClient();
  const can = useCan();
  const run = useResource<ContactImport>(`/contacts/imports/${id}`);
  const cancel = useMutation(() => client.delete<ContactImport>(`/contacts/imports/${id}`), { onSuccess: run.setData });
  const status = run.data?.status;

  const done = status ? finished(status) : false;
  useEffect(() => {
    if (done) onFinish?.();
    // `onFinish` fires once per finish.
  }, [done]);

  // One failed poll is not the end of the import. The last counts stay on screen and polling
  // goes on, more slowly while the API cannot be reached.
  useEffect(() => {
    if (!status || done || run.loading || cancel.isLoading) return;
    const timer = setTimeout(() => void run.reload(), run.error ? 5000 : 1500);
    return () => clearTimeout(timer);
    // `run.reload` changes only with the id.
  }, [status, done, run.loading, run.error, run.data, cancel.isLoading]);

  if (run.error && !run.data) return <Failed message={run.error} onRetry={run.reload} />;
  if (!run.data) return <Skeleton lines={3} />;
  const { counts } = run.data;
  const handled = counts.created + counts.updated + counts.skipped + counts.failed;
  const share = done && status !== "cancelled" ? 100 : counts.total ? Math.min(100, Math.round((handled / counts.total) * 100)) : 0;

  return (
    <div className="stack">
      <div className="inline">
        <Badge value={run.data.status} variant={importTone(run.data.status)} label={run.data.status.replace("_", " ")} />
        <span className="muted">
          {run.data.status === "queued"
            ? "Waiting for the worker."
            : run.data.status === "in_progress"
              ? `${handled.toLocaleString()} rows processed.`
              : run.data.completed_at
                ? "Finished."
                : ""}
        </span>
      </div>
      <p className="fieldHint">Automations for this import: {run.data.trigger_automations ? "On" : "Off"}.</p>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
        <div className="progressFill" style={{ width: `${share}%` }} />
      </div>
      <dl className="statStrip five">
        {(["total", "created", "updated", "skipped", "failed"] as const).map((key) => (
          <div key={key} className="stat">
            <dt>{key}</dt>
            <dd>{counts[key].toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      {run.data.error ? <p className="fieldError">{run.data.error}</p> : null}
      {cancel.error ? <p className="fieldError" role="alert">{cancel.error.message}</p> : null}
      {status === "cancelled" ? <p className="fieldHint">Future batches were cancelled. Contacts already created or updated are not reverted.</p> : null}
      {can && (status === "queued" || status === "in_progress") ? <>
        <p className="fieldHint">Cancellation stops future batches. Contacts already created or updated are not reverted.</p>
        <button type="button" className="secondary" disabled={run.loading || cancel.isLoading} onClick={() => { if (can && !run.loading && !cancel.isLoading) void cancel.mutate(); }}>Cancel import</button>
      </> : null}
      {run.error && !done ? <p className="fieldHint">Could not refresh the progress. The import is still running. Trying again.</p> : null}
    </div>
  );
}

/** Past imports, newest first, with the selected one's progress. */
export function Imports({ onClose, onImport }: { onClose: () => void; onImport?: () => void }) {
  const list = useList<ContactImport>("/contacts/imports", {}, { limit: 10 });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Drawer isOpen title="Imports" label="Contacts" onClose={onClose}>
      <div className="stack">
        {open ? (
          <>
            <button type="button" className="ghost small" onClick={() => setOpen(null)}>
              All imports
            </button>
            <ImportProgress id={open} onFinish={() => void list.reload()} />
          </>
        ) : (
          <Table
            compact
            rows={list.rows}
            loading={list.loading}
            error={list.error}
            onRetry={() => void list.reload()}
            onRowClick={(row) => setOpen(row.id)}
            empty={<Empty compact title="No imports yet" body="Import a CSV to add all your contacts at once." action={onImport ? <button type="button" onClick={onImport}>Import CSV</button> : null} />}
            page={list.page}
            hasMore={list.hasMore}
            onNext={list.next}
            onPrevious={list.previous}
            columns={[
              { header: "Status", cell: (row) => <Badge value={row.status} variant={importTone(row.status)} label={row.status.replace("_", " ")} /> },
              { header: "Rows", cell: (row) => row.counts.total.toLocaleString() },
              { header: "Automations", cell: (row) => row.trigger_automations ? "On" : "Off" },
              {
                header: "Result",
                cell: (row) => (
                  <span className="dim">
                    {row.counts.created} created, {row.counts.updated} updated, {row.counts.failed} failed
                  </span>
                ),
              },
              { header: "Started", cell: (row) => <Time value={row.created_at} /> },
            ]}
          />
        )}
      </div>
    </Drawer>
  );
}
