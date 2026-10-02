import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Copy } from "../../components/Copy";
import { Failed } from "../../components/Empty";
import { Field, Select } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { toast } from "../../components/Toast";
import { useHotkey } from "../../hooks/useHotkey";
import { shortcuts } from "../../lib/shortcuts";
import { useMutation } from "../../hooks/useMutation";
import { useAll, useResource } from "../../hooks/useResource";
import { addresses } from "../../lib/utils";
import { usable, useWhen, whenHint } from "../../lib/when";
import { useCan, useClient } from "../../shell/session";
import type { BroadcastAudience, BroadcastDetail, ContactProperty, LinkCheck, List, Rendered, Segment, Template, Topic } from "../../types";
import { EditorScreen, LeaveGuard, Preview, Source, TestSend, useDraft, type Flush } from "../templates/editor";
import { contactField, contactKeys, fill, hasUnsubscribe, links, noFallback, sampleContact } from "../templates/render";
import { useBrand } from "../templates/Versions";
import "../../styles/editor.css";

export type BroadcastForm = {
  name: string;
  from: string;
  reply_to: string;
  subject: string;
  preview_text: string;
  segment_id: string;
  topic_id: string;
  html: string;
  text: string;
};

export function toForm(broadcast: BroadcastDetail): BroadcastForm {
  return {
    name: broadcast.name,
    from: broadcast.from ?? "",
    reply_to: (broadcast.reply_to ?? []).join(", "),
    subject: broadcast.subject ?? "",
    preview_text: broadcast.preview_text ?? "",
    segment_id: broadcast.segment_id ?? "",
    topic_id: broadcast.topic_id ?? "",
    html: broadcast.html ?? "",
    text: broadcast.text ?? "",
  };
}

/** Turns changed form fields into a `PATCH /broadcasts/:id` body. Throws on values the API rejects. */
export function patchBody(changed: Partial<BroadcastForm>) {
  const body: Record<string, unknown> = {};
  const required = { name: "Name", from: "From", subject: "Subject", segment_id: "Segment" } as const;
  for (const [key, label] of Object.entries(required) as Array<[keyof typeof required, string]>) {
    if (!(key in changed)) continue;
    const value = changed[key]!.trim();
    if (!value) throw new Error(`${label} cannot be empty`);
    body[key] = value;
  }
  if ("reply_to" in changed) {
    const list = addresses(changed.reply_to ?? "");
    body.reply_to = list.length ? list : null;
  }
  for (const key of ["preview_text", "topic_id", "html", "text"] as const) {
    if (key in changed) body[key] = changed[key]?.trim() ? changed[key] : null;
  }
  return body;
}

/** Personalization placeholders the worker fills per recipient. */
export const personalization = [
  { label: "First name", snippet: "{{{contact.first_name|there}}}" },
  { label: "Last name", snippet: "{{{contact.last_name}}}" },
  { label: "Email", snippet: "{{{contact.email}}}" },
  { label: "Unsubscribe link", snippet: '<a href="{{{DISPATCH_UNSUBSCRIBE_URL}}}">Unsubscribe</a>' },
];

export const confirmPhrase = "SEND";

/** Broadcast editor: the content editor, then the review and schedule step. */
export function BroadcastEditor() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const navigate = useNavigate();
  const broadcast = useResource<BroadcastDetail>(`/broadcasts/${id}`);
  const segments = useAll<Segment>("/segments");
  const topics = useAll<Topic>("/topics");
  const templates = useAll<Template>("/templates");
  const brand = useBrand();
  const html = useRef<HTMLTextAreaElement>(null);
  const [testing, setTesting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [template, setTemplate] = useState("");
  const can = useCan();
  const editable = can && broadcast.data?.status === "draft";

  // Set by `Source`: hands over a visual edit that has not been written yet. Every save runs it first.
  const flushVisual = useRef<Flush | null>(null);
  const draft = useDraft<BroadcastForm>(
    async (changed) => {
      const body = patchBody(changed);
      if (Object.keys(body).length === 0) return;
      broadcast.setData(await client.patch<BroadcastDetail>(`/broadcasts/${id}`, body));
    },
    { enabled: editable, before: () => flushVisual.current?.() ?? Promise.resolve() },
  );
  const { form } = draft;

  useEffect(() => {
    if (broadcast.data && !form) draft.load(toForm(broadcast.data));
  }, [broadcast.data, form, draft.load]);

  // A contact field the sample contact lacks prints as a blank, as it does for a real recipient.
  const preview = useMemo(() => (form ? fill(form, { ...brand, ...sampleContact }, [], { blank: contactField }) : null), [form, brand]);

  async function saveNow() {
    const ok = await draft.save();
    if (ok) toast.success("Broadcast saved.");
    return ok;
  }
  useHotkey(shortcuts.save.combo, () => void saveNow(), { enabled: Boolean(form) && editable });

  const applyTemplate = useMutation(
    async () => {
      if (!(await draft.save())) throw new Error(draft.state.error ?? "Save the broadcast first.");
      return client.patch<BroadcastDetail>(`/broadcasts/${id}`, { template });
    },
    {
      success: "Template content added.",
      onSuccess: (next) => {
        broadcast.setData(next);
        draft.load(toForm(next));
        setTemplate("");
      },
    },
  );

  async function insert(snippet: string) {
    // In visual mode there is no textarea, so the snippet goes at the end. The edit the visual
    // editor is still holding is written first, or the reload that follows would drop it.
    await flushVisual.current?.();
    const element = html.current;
    draft.update((current) => {
      if (!element) return { ...current, html: current.html + snippet };
      const start = element.selectionStart ?? current.html.length;
      const end = element.selectionEnd ?? start;
      return { ...current, html: current.html.slice(0, start) + snippet + current.html.slice(end) };
    });
    element?.focus();
  }

  if (broadcast.error) return <Failed message={broadcast.error} onRetry={broadcast.reload} />;
  const row = broadcast.data;
  const set = (key: keyof BroadcastForm) => (value: string) => draft.set(key, value);
  const published = (templates.data?.data ?? []).filter((item) => item.status === "published");

  return (
    <EditorScreen
      crumb={{ to: "/broadcasts", label: "Broadcasts" }}
      title={row?.name ?? "Loading"}
      status={row ? <Badge value={row.status} /> : null}
      save={editable ? draft.state : undefined}
      actions={
        <>
          {row && !editable ? (
            <Link className="button secondary" to={`/broadcasts/${row.id}`}>
              View broadcast
            </Link>
          ) : null}
          {can ? (
            <button type="button" className="secondary" disabled={!form} onClick={() => setTesting(true)}>
              Test email
            </button>
          ) : null}
          <button type="button" disabled={!form || !editable} onClick={() => setReviewing(true)}>
            Review
          </button>
        </>
      }
    >
      {row && !editable ? (
        <div className="notice warning" role="note">
          <AlertTriangle size={16} aria-hidden />
          <span>
            {can
              ? `This broadcast is ${row.status}. Only drafts can be edited. Duplicate it to send a changed copy.`
              : "You have read access. An admin can change this broadcast."}
          </span>
        </div>
      ) : null}

      {!form || !preview ? (
        <Skeleton lines={8} />
      ) : (
        <>
          <div className="editorHead">
            <Field label="Name" value={form.name} onChange={set("name")} disabled={!editable} />
            <Field label="From" value={form.from} onChange={set("from")} placeholder="Acme <news@acme.com>" disabled={!editable} />
            <Field label="Reply-To" value={form.reply_to} onChange={set("reply_to")} placeholder="support@acme.com" disabled={!editable} />
            <Select
              label="To"
              value={form.segment_id}
              onChange={set("segment_id")}
              placeholder="Choose a segment"
              options={(segments.data?.data ?? []).map((segment) => ({ value: segment.id, label: segment.name }))}
              disabled={!editable}
            />
            <Field label="Subject" value={form.subject} onChange={set("subject")} className="wide" disabled={!editable} />
            <Field label="Preview text" value={form.preview_text} onChange={set("preview_text")} placeholder="Shown after the subject in the inbox" disabled={!editable} />
            <Select
              label="Topic"
              value={form.topic_id}
              onChange={set("topic_id")}
              placeholder="No topic"
              options={(topics.data?.data ?? []).map((topic) => ({ value: topic.id, label: topic.name }))}
              disabled={!editable}
            />
          </div>
          <div className="editorPanes">
            <div className="editorPane">
              <Source html={form.html} text={form.text} onHtml={set("html")} onText={set("text")} disabled={!editable} textareaRef={html} flushRef={flushVisual} />
              {editable ? (
                <Panel title="Personalize">
                  <div className="insertList">
                    {personalization.map((item) => (
                      <button key={item.label} type="button" className="secondary small" onClick={() => void insert(item.snippet)}>
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <p className="dim">
                    Inserts at the cursor. Contact fields take a fallback after a bar, as in <span className="mono">{"{{{contact.first_name|there}}}"}</span>.
                  </p>
                  <div className="toolbar">
                    <Select
                      label="Start from a template"
                      value={template}
                      onChange={setTemplate}
                      placeholder={published.length ? "Choose a published template" : "No published templates"}
                      options={published.map((item) => ({ value: item.id, label: item.name }))}
                    />
                    <button type="button" className="secondary" disabled={!template || applyTemplate.isLoading} onClick={() => void applyTemplate.mutate()}>
                      Use template
                    </button>
                  </div>
                  <p className="dim">Replaces the subject and content with the template's published version.</p>
                </Panel>
              ) : null}
            </div>
            <div className="editorPane">
              <p className="muted">
                <span className="dim">Subject</span> {preview.subject || "No subject"}
              </p>
              <Preview html={preview.html} />
              <p className="dim">Shown for a sample contact, Ada Lovelace.</p>
            </div>
          </div>
        </>
      )}

      <LeaveGuard
        when={editable && (draft.state.dirty || draft.state.saving)}
        pending={() => editable && (flushVisual.current?.waiting() ?? false)}
        onSave={draft.save}
      />

      {testing && form ? (
        <TestSend
          from={form.from}
          variables={sampleContact}
          render={async (values) => {
            // Rendered by the API from the saved draft, with the worker's own renderer, so the
            // test email is what a recipient gets.
            if (!(await draft.save())) throw new Error(draft.state.error ?? "Save the broadcast before sending a test.");
            const { rendered } = await client.post<{ rendered: Rendered }>(`/broadcasts/${id}/render`, { variables: values });
            return { subject: rendered.subject ?? "", html: rendered.html ?? "", text: rendered.text ?? "" };
          }}
          onClose={() => setTesting(false)}
        />
      ) : null}

      {reviewing && form && row ? (
        <Review
          id={row.id}
          form={form}
          segment={segments.data?.data.find((segment) => segment.id === form.segment_id) ?? null}
          topic={topics.data?.data.find((topic) => topic.id === form.topic_id) ?? null}
          save={draft.save}
          saveError={draft.state.error}
          onClose={() => setReviewing(false)}
          onSent={() => navigate(`/broadcasts/${row.id}`)}
        />
      ) : null}
    </EditorScreen>
  );
}

type Check = { tone: "ok" | "warn" | "fail"; text: string; detail?: string };

export type AudienceState = BroadcastAudience | "loading" | "failed";

/** "3 unsubscribed, 1 suppressed, 0 opted out of the topic." */
export function skipped(audience: BroadcastAudience, topic: boolean) {
  const parts = [`${audience.unsubscribed} unsubscribed`, `${audience.suppressed} suppressed`];
  if (topic) parts.push(`${audience.opted_out} opted out of the topic`);
  return `Skipped: ${parts.join(", ")}.`;
}

/** A warning for each name the content prints with no fallback while some recipients lack it. It never blocks the send. */
export function blankNames(form: BroadcastForm, audience: BroadcastAudience): Check[] {
  const names = [
    { label: "first name", count: audience.no_first_name, keys: ["contact.first_name", "FIRST_NAME"], fix: "Add a fallback, such as {{{contact.first_name|there}}}." },
    { label: "last name", count: audience.no_last_name, keys: ["contact.last_name", "LAST_NAME"], fix: "Add a fallback, or wrap it in {{{#if contact.last_name}}}…{{{/if}}}." },
  ];
  return names
    .filter((name) => name.count > 0 && noFallback(name.keys, form.subject, form.html, form.text))
    .map((name): Check => ({
      tone: "warn",
      text: `${name.count} of ${audience.recipients} recipients ${name.count === 1 ? "has" : "have"} no ${name.label}. They will see a blank where it goes.`,
      detail: name.fix,
    }));
}

/**
 * A `contact.*` field that is neither a built-in field nor a defined property is blank for every
 * recipient, which is almost always a typo. `properties` is null until the list loads.
 */
export function unknownFields(form: BroadcastForm, properties: string[] | null): Check[] {
  if (!properties) return [];
  const unknown = contactKeys(form.subject, form.html, form.text).filter((key) => !["email", "first_name", "last_name"].includes(key) && !properties.includes(key));
  if (!unknown.length) return [];
  const names = unknown.map((key) => `contact.${key}`).join(", ");
  return [
    {
      tone: "warn",
      text: `${names} ${unknown.length === 1 ? "is not a contact field" : "are not contact fields"}, so every recipient will see a blank there.`,
      detail: "Check the spelling, or add the property under Audience, Properties.",
    },
  ];
}

/** The review checklist. `fail` blocks the send; `warn` does not. */
export function reviewChecks(
  form: BroadcastForm,
  segment: Segment | null,
  topic: Topic | null,
  audience: AudienceState,
  linkResults: LinkCheck[] | "failed" | null,
  linkCount: number,
  properties: string[] | null = null,
): Check[] {
  const checks: Check[] = [];
  if (!segment) checks.push({ tone: "fail", text: "Choose a segment to send to." });
  else if (audience === "loading") checks.push({ tone: "ok", text: `Counting the contacts in ${segment.name}…` });
  else if (audience === "failed") checks.push({ tone: "warn", text: `Could not count the contacts in ${segment.name}.` });
  else {
    const count = audience.recipients;
    checks.push({
      tone: count === 0 ? "warn" : "ok",
      text: `Sending to ${count} ${count === 1 ? "contact" : "contacts"} in ${segment.name}.`,
      detail: skipped(audience, Boolean(form.topic_id)),
    });
    checks.push(...blankNames(form, audience));
  }
  checks.push(...unknownFields(form, properties));
  if (!form.subject.trim()) checks.push({ tone: "fail", text: "Add a subject." });
  if (!form.html.trim() && !form.text.trim()) checks.push({ tone: "fail", text: "Add HTML or plain text content." });
  if (!form.from.trim()) checks.push({ tone: "fail", text: "Add a From address." });
  checks.push(
    hasUnsubscribe(form.html) || hasUnsubscribe(form.text)
      ? { tone: "ok", text: "Includes an unsubscribe link." }
      : { tone: "warn", text: "No unsubscribe link.", detail: "Add {{{DISPATCH_UNSUBSCRIBE_URL}}} so contacts can opt out." },
  );
  checks.push(
    topic
      ? { tone: "ok", text: `Topic: ${topic.name}.` }
      : { tone: "warn", text: "No topic selected.", detail: "Contacts cannot opt out of just this kind of email." },
  );
  if (linkCount === 0) checks.push({ tone: "ok", text: "No links to check." });
  else if (!linkResults) checks.push({ tone: "ok", text: `Checking ${linkCount} ${linkCount === 1 ? "link" : "links"}…` });
  else if (linkResults === "failed") {
    checks.push({ tone: "warn", text: `Could not check the ${linkCount === 1 ? "link" : `${linkCount} links`}.`, detail: "Open them yourself before sending." });
  } else {
    const broken = linkResults.filter((item) => !item.ok);
    if (broken.length === 0) checks.push({ tone: "ok", text: `All ${linkResults.length} links work.` });
    for (const item of broken) checks.push({ tone: "warn", text: `Link ${item.message}.`, detail: item.url });
  }
  return checks;
}

function Review({
  id,
  form,
  segment,
  topic,
  save,
  saveError,
  onClose,
  onSent,
}: {
  id: string;
  form: BroadcastForm;
  segment: Segment | null;
  topic: Topic | null;
  save: () => Promise<boolean>;
  saveError: string | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const client = useClient();
  const urls = useMemo(() => links(form.html), [form.html]);
  const [linkResults, setLinkResults] = useState<LinkCheck[] | "failed" | null>(null);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [typed, setTyped] = useState("");
  // The time is read here, in the browser's zone, and shown before the user confirms.
  const schedule = useWhen(at);

  const check = useMutation((list: string[]) => client.post<List<LinkCheck>>("/links/check", { urls: list }), {
    onSuccess: (result) => setLinkResults(result.data),
    onError: () => setLinkResults("failed"),
  });
  const checkLinks = check.mutate;
  useEffect(() => {
    if (urls.length) void checkLinks(urls);
  }, [urls, checkLinks]);

  // The count reads the saved segment and topic, so save first.
  const [audience, setAudience] = useState<AudienceState>("loading");
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (!(await save())) throw new Error("not saved");
        const result = await client.get<BroadcastAudience>(`/broadcasts/${id}/audience`);
        if (live) setAudience(result);
      } catch {
        if (live) setAudience("failed");
      }
    })();
    return () => {
      live = false;
    };
    // Count once when the review opens; the form cannot change while it is open.
  }, [client, id]);

  const properties = useAll<ContactProperty>("/contact-properties");
  const checks = reviewChecks(form, segment, topic, audience, linkResults, urls.length, properties.data?.data.map((property) => property.key) ?? null);
  if (saveError) checks.unshift({ tone: "fail", text: `Not saved: ${saveError}` });
  const blocked = checks.some((item) => item.tone === "fail") || (when === "later" && !usable(schedule));

  const send = useMutation(
    async () => {
      if (!(await save())) throw new Error("Save the broadcast before sending.");
      if (when === "later" && !usable(schedule)) throw new Error("Enter a time to send at.");
      const body = when === "later" && schedule.when ? { scheduled_at: schedule.when.date.toISOString() } : {};
      return client.post<{ id: string }>(`/broadcasts/${id}/send`, body);
    },
    {
      success: when === "later" ? "Broadcast scheduled." : "Broadcast sending.",
      onSuccess: onSent,
    },
  );

  return (
    <Modal
      isOpen
      title="Review broadcast"
      size="large"
      onClose={onClose}
      onSubmit={() => void send.mutate()}
      submitLabel={when === "later" ? "Schedule" : "Send now"}
      submitting={send.isLoading}
      submitDisabled={blocked || typed !== confirmPhrase}
    >
      <div className="stack">
        <ul className="checklist" aria-label="Checks">
          {checks.map((item, index) => (
            <li key={`${item.text}-${index}`} className={item.tone}>
              {item.tone === "ok" ? <CheckCircle2 size={15} aria-hidden /> : item.tone === "warn" ? <AlertTriangle size={15} aria-hidden /> : <XCircle size={15} aria-hidden />}
              <span>
                {item.text}
                {item.detail ? <span className="detail">{item.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>

        <div className="form">
          <Select
            label="When"
            value={when}
            onChange={(value) => setWhen(value as "now" | "later")}
            options={[
              { value: "now", label: "Send now" },
              { value: "later", label: "Schedule for later" },
            ]}
          />
          {when === "later" ? (
            <Field
              label="Send at"
              value={at}
              onChange={setAt}
              placeholder="2026-10-05 09:00, or tomorrow at 9am"
              hint={whenHint(at, schedule)}
            />
          ) : null}
          <div className="phraseRow">
            <label htmlFor="send-phrase" className="confirmHint">
              Type <Copy value={confirmPhrase} chip /> to confirm.
            </label>
            <input id="send-phrase" aria-label="Confirmation phrase" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          </div>
          <p className="dim">
            <Info size={13} aria-hidden /> Once sending starts it cannot be undone. A scheduled broadcast can be canceled until it starts.
          </p>
        </div>
      </div>
    </Modal>
  );
}
