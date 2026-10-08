// Pieces shared by the template and broadcast editors and their detail pages.
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode, type Ref } from "react";
import { Link, useBlocker } from "react-router-dom";
import { Monitor, Smartphone } from "lucide-react";
import { EmailFrame } from "../../components/EmailFrame";
import { Field, TextArea } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Tabs } from "../../components/Tabs";
import { useMutation } from "../../hooks/useMutation";
import { errorMessage } from "../../lib/client";
import { addresses } from "../../lib/utils";
import { useClient } from "../../shell/session";
import { blocked } from "./guard";
import { coverOf, excerpt } from "./cover";
import type { VisualHandle, VisualProps } from "./Visual";
import "../../styles/editor.css";
import "../../styles/visual.css";

export type Width = "desktop" | "phone";

/** EmailFrame with a desktop and phone width toggle. */
export function Preview({ html, actions }: { html: string; actions?: ReactNode }) {
  const [width, setWidth] = useState<Width>("desktop");
  return (
    <div className="preview">
      <div className="previewBar">
        <div className="segmented" role="group" aria-label="Preview width">
          <button type="button" className={width === "desktop" ? "active" : undefined} aria-pressed={width === "desktop"} onClick={() => setWidth("desktop")}>
            <Monitor size={14} aria-hidden /> Desktop
          </button>
          <button type="button" className={width === "phone" ? "active" : undefined} aria-pressed={width === "phone"} onClick={() => setWidth("phone")}>
            <Smartphone size={14} aria-hidden /> Phone
          </button>
        </div>
        {actions}
      </div>
      <EmailFrame html={html} width={width} />
    </div>
  );
}

/** A compact email cover using safe text extracted from the full document. */
export function Thumb({ html }: { html: string | null | undefined }) {
  const cover = useMemo(() => coverOf(html), [html]);
  return <div className="thumb" aria-hidden>{cover ? (
    <div className="thumbCover">
      {cover.brand ? <span className="thumbBrand">{excerpt(cover.brand, 32)}</span> : null}
      <div className="thumbCopy">
        <p className="thumbHeading">{excerpt(cover.heading, 62)}</p>
        {cover.lead ? <p className="thumbLead">{excerpt(cover.lead, 106)}</p> : null}
      </div>
      {cover.code ? <span className="thumbCode">{excerpt(cover.code, 16)}</span>
        : cover.details.length ? <div className="thumbDetails">{cover.details.map((row, index) => (
          <div key={index}><span>{excerpt(row.label, 20)}</span><span>{excerpt(row.value, 28)}</span></div>
        ))}</div>
        : cover.action ? <span className="thumbAction">{excerpt(cover.action, 32)}</span> : null}
    </div>
  ) : html === undefined ? <div className="thumbLoading"><span /><span /><span /></div>
    : <span className="thumbEmpty">No content</span>}</div>;
}

export type SaveState = { saving: boolean; dirty: boolean; error: string | null; savedAt: number | null };

export function saveLabel({ saving, dirty, error, savedAt }: SaveState) {
  if (saving) return "Saving…";
  if (error) return `Not saved: ${error}`;
  if (dirty) return "Unsaved changes";
  return savedAt ? "Saved" : "All changes saved";
}

/** The full-screen editor frame: breadcrumb, status chip, save state, actions, then the body. */
export function EditorScreen({
  crumb,
  title,
  status,
  save,
  actions,
  children,
}: {
  crumb: { to: string; label: string };
  title: string;
  status?: ReactNode;
  save?: SaveState;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="editorScreen">
      <header className="editorBar">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to={crumb.to}>{crumb.label}</Link>
          <span aria-hidden>/</span>
          <span className="crumbTitle">{title}</span>
        </nav>
        {status}
        {save ? (
          <span className={save.error ? "saveState error" : "saveState"} role="status">
            {saveLabel(save)}
          </span>
        ) : null}
        <div className="toolbar editorActions">{actions}</div>
      </header>
      <div className="editorBody">{children}</div>
    </div>
  );
}

type VisualEditor = ComponentType<VisualProps>;
let visualEditor: Promise<VisualEditor> | null = null;

// The editor package is large, so it loads on the first switch to Visual and is kept after that.
// A failed load is not kept, so the next switch tries again.
function loadVisual() {
  visualEditor ??= import("./Visual").then((module) => module.default);
  visualEditor.catch(() => {
    visualEditor = null;
  });
  return visualEditor;
}

/**
 * HTML and plain-text source tabs. The HTML tab has a Code mode (a monospace textarea, the default)
 * and a Visual mode. Both read and write the same `html`.
 *
 * Visual mode opens an empty template or HTML it wrote itself. For other HTML it explains why not,
 * and where only formatting is at stake it offers a conversion the user has to confirm.
 * `flushRef` gets a function that writes a visual edit still waiting, for the page to call before it saves.
 */
export type Flush = (() => Promise<void>) & {
  /** True while a visual edit has not reached the draft yet, so the draft does not read as dirty. */
  waiting: () => boolean;
};

export type SourceCheck = { id: "source.visual"; tone: "warn"; text: string };

export function Source({
  html,
  text,
  onHtml,
  onText,
  disabled,
  textareaRef,
  flushRef,
  placeholders,
  onCheck,
}: {
  html: string;
  text: string;
  onHtml: (value: string) => void;
  onText: (value: string) => void;
  disabled?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  flushRef?: { current: Flush | null };
  placeholders?: VisualProps["placeholders"];
  onCheck?: (check: SourceCheck | null) => void;
}) {
  const [tab, setTab] = useState<"html" | "text">("html");
  const [mode, setMode] = useState<"code" | "visual">("code");
  const [Visual, setVisual] = useState<VisualEditor | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Set when the refusal is about formatting only, so a conversion can be offered.
  const [offer, setOffer] = useState(false);
  const [asking, setAsking] = useState(false);
  const [convert, setConvert] = useState(false);
  const handle = useRef<VisualHandle | null>(null);
  useEffect(() => {
    onCheck?.(note ? { id: "source.visual", tone: "warn", text: note } : null);
  }, [note, onCheck]);

  const flush = useMemo<Flush>(
    () => Object.assign(() => handle.current?.flush() ?? Promise.resolve(), { waiting: () => handle.current?.waiting() ?? false }),
    [],
  );
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flush;
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, flush]);

  // A broadcast that has left draft is read only. Visual mode is for editing, so it is not offered.
  const visual = mode === "visual" && !disabled;

  function open(converting: boolean) {
    setNote(null);
    setOffer(false);
    setConvert(converting);
    setMode("visual");
    loadVisual()
      .then((component) => setVisual(() => component))
      .catch(() => {
        setMode("code");
        setNote("The visual editor did not load. Try again.");
      });
  }

  function toVisual() {
    // Checks that need no editor run first, so a template that cannot switch never loads the package.
    const reason = blocked(html);
    setNote(reason);
    setOffer(false);
    if (!reason) open(false);
  }

  // An edit made in the last quarter second is written before the textarea takes over, so what is
  // typed in Code next cannot be overwritten by it.
  async function toCode() {
    await flush();
    setConvert(false);
    setMode("code");
  }

  return (
    <div className="source">
      <div className="sourceBar">
        <Tabs
          label="Source"
          value={tab}
          onChange={(next) => void flush().then(() => setTab(next))}
          tabs={[
            { id: "html", label: "HTML" },
            { id: "text", label: "Plain text" },
          ]}
        />
        {tab === "html" && !disabled ? (
          <div className="segmented" role="group" aria-label="Editor mode">
            <button type="button" className={!visual ? "active" : undefined} aria-pressed={!visual} onClick={() => void toCode()}>
              Code
            </button>
            <button type="button" className={visual ? "active" : undefined} aria-pressed={visual} onClick={toVisual}>
              Visual
            </button>
          </div>
        ) : null}
      </div>
      <div className="sourceBody">
        {tab === "html" && note ? (
          <p className="sourceNote" role="status">
            {note}{" "}
            {offer ? (
              <button type="button" className="ghost small" onClick={() => setAsking(true)}>
                Convert to visual
              </button>
            ) : null}
          </p>
        ) : null}
        {tab === "html" && visual ? (
          Visual ? (
            <Visual
              html={html}
              convert={convert}
              handle={handle}
              placeholders={placeholders}
              onHtml={onHtml}
              onReject={(reason, convertible) => {
                setMode("code");
                setConvert(false);
                setNote(reason);
                setOffer(convertible);
              }}
            />
          ) : (
            <p className="visualCheck" role="status">
              Loading the visual editor…
            </p>
          )
        ) : tab === "html" ? (
          <textarea
            ref={textareaRef}
            className="sourceArea mono"
            aria-label="HTML"
            spellCheck={false}
            value={html}
            disabled={disabled}
            onChange={(event) => onHtml(event.target.value)}
            placeholder="<p>Hi {{{FIRST_NAME|there}}},</p>"
          />
        ) : (
          <textarea
            className="sourceArea mono"
            aria-label="Plain text"
            spellCheck={false}
            value={text}
            disabled={disabled}
            onChange={(event) => onText(event.target.value)}
            placeholder="Leave empty to send HTML only."
          />
        )}
      </div>
      {asking ? (
        <Modal
          isOpen
          size="small"
          title="Convert to visual mode"
          onClose={() => setAsking(false)}
          onSubmit={() => {
            setAsking(false);
            open(true);
          }}
          submitLabel="Convert"
        >
          <div className="stack">
            <p>
              Visual mode rebuilds the HTML in its own layout on your first edit. Every placeholder, link, and image is kept. Formatting it cannot
              show is lost: text colors, cell widths and backgrounds, custom fonts, and code for old Outlook.
            </p>
            <p className="muted">Nothing changes until you edit. The version history keeps the HTML as it is now.</p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function changes<T extends Record<string, unknown>>(base: T, next: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (!same(base[key], next[key])) out[key] = next[key];
  }
  return out;
}

export type Draft<T> = {
  form: T | null;
  set: <K extends keyof T>(key: K, value: T[K]) => void;
  update: (change: (form: T) => T) => void;
  load: (value: T) => void;
  save: () => Promise<boolean>;
  state: SaveState;
};

/**
 * Form state with autosave: saves the changed fields after `delay` ms of quiet.
 * `persist` gets only the fields that differ from the last save. A failed save waits for the next
 * edit: the form that failed is remembered, and the timer does not start again for it.
 * `save()` called while a save is running waits for it, then saves whatever changed since.
 * `before` runs ahead of each save, for an editor that holds an edit it has not handed over yet.
 */
export function useDraft<T extends Record<string, unknown>>(
  persist: (changed: Partial<T>, next: T) => Promise<void>,
  { delay = 1500, enabled = true, before }: { delay?: number; enabled?: boolean; before?: () => Promise<void> } = {},
): Draft<T> {
  const [form, setForm] = useState<T | null>(null);
  const [saved, setSaved] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const formRef = useRef(form);
  const savedRef = useRef(saved);
  const persistRef = useRef(persist);
  // Runs before every save. The visual editor uses it to hand over an edit it has not written yet.
  const beforeRef = useRef(before);
  beforeRef.current = before;
  const running = useRef<Promise<boolean> | null>(null);
  const failed = useRef<T | null>(null);
  formRef.current = form;
  savedRef.current = saved;
  persistRef.current = persist;

  const load = useCallback((value: T) => {
    formRef.current = value;
    savedRef.current = value;
    failed.current = null;
    setForm(value);
    setSaved(value);
    setError(null);
  }, []);

  // The ref is written at once, not on the next render, so a save that follows an edit in the
  // same tick sends it.
  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    const current = formRef.current;
    if (!current) return;
    const next = { ...current, [key]: value };
    formRef.current = next;
    setForm(next);
  }, []);

  const update = useCallback((change: (form: T) => T) => {
    const current = formRef.current;
    if (!current) return;
    const next = change(current);
    formRef.current = next;
    setForm(next);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    // Publish and Test email call this while an autosave may be in flight. They wait for it
    // instead of failing, then save anything typed since.
    while (running.current) await running.current;
    await beforeRef.current?.();
    const next = formRef.current;
    const base = savedRef.current;
    if (!next || !base) return false;
    const changed = changes(base, next);
    if (Object.keys(changed).length === 0) return true;
    setSaving(true);
    const run = (async () => {
      try {
        await persistRef.current(changed, next);
        savedRef.current = next;
        failed.current = null;
        setSaved(next);
        setSavedAt(Date.now());
        setError(null);
        return true;
      } catch (err) {
        failed.current = next;
        setError(errorMessage(err));
        return false;
      }
    })();
    running.current = run;
    try {
      return await run;
    } finally {
      running.current = null;
      setSaving(false);
    }
  }, []);

  const dirty = Boolean(form && saved && !same(form, saved));

  useEffect(() => {
    if (!enabled || !dirty || saving) return;
    // The API refused this exact form. Sending it again every `delay` ms changes nothing, so
    // autosave waits until the user edits it. Save and Publish still try on request.
    if (failed.current === form) return;
    const timer = setTimeout(() => void save(), delay);
    return () => clearTimeout(timer);
  }, [enabled, dirty, saving, form, delay, save]);

  return { form, set, update, load, save, state: { saving, dirty, error, savedAt } };
}

/**
 * Blocks in-app navigation and tab close while there are unsaved changes. `pending` is asked at
 * the moment of leaving, for an edit the draft has not heard about yet: a visual edit is written
 * a quarter second after the last keystroke.
 */
export function LeaveGuard({ when, pending, onSave }: { when: boolean; pending?: () => boolean; onSave?: () => Promise<boolean> }) {
  const unsaved = useRef(() => when);
  unsaved.current = () => when || Boolean(pending?.());
  const blocker = useBlocker(({ currentLocation, nextLocation }) => unsaved.current() && currentLocation.pathname !== nextLocation.pathname);
  const watched = when || Boolean(pending);

  useEffect(() => {
    if (!watched) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (unsaved.current()) event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [watched]);

  if (blocker.state !== "blocked") return null;
  return (
    <Modal
      isOpen
      title="Leave without saving?"
      onClose={() => blocker.reset()}
      actions={
        <>
          <button type="button" className="secondary" onClick={() => blocker.reset()}>
            Stay <kbd>Esc</kbd>
          </button>
          <button type="button" className="danger" onClick={() => blocker.proceed()}>
            Discard changes
          </button>
          {onSave ? (
            <button
              type="button"
              onClick={async () => {
                if (await onSave()) blocker.proceed();
                else blocker.reset();
              }}
            >
              Save and leave
            </button>
          ) : null}
        </>
      }
    >
      <p>Your latest changes have not been saved.</p>
    </Modal>
  );
}

type Rendering = { subject: string; html: string; text: string };

/**
 * Test send: addresses and a JSON object of variables, prefilled. The subject gets a `[TEST]` prefix.
 * `render` turns the variables into the subject, HTML, and text to send.
 */
export function TestSend({
  from: initialFrom,
  variables: initialVariables,
  render,
  onClose,
}: {
  from: string;
  variables: Record<string, unknown>;
  render: (values: Record<string, unknown>) => Rendering | Promise<Rendering>;
  onClose: () => void;
}) {
  const client = useClient();
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState("");
  const [json, setJson] = useState(JSON.stringify(initialVariables, null, 2));
  const [problem, setProblem] = useState<string | null>(null);
  const send = useMutation(
    async () => {
      let values: Record<string, unknown>;
      try {
        values = json.trim() ? (JSON.parse(json) as Record<string, unknown>) : {};
      } catch {
        throw new Error("Variables must be valid JSON.");
      }
      const out = await render(values);
      const body: Record<string, unknown> = { from, to: addresses(to), subject: `[TEST] ${out.subject}`.trim() };
      if (out.html) body.html = out.html;
      if (out.text) body.text = out.text;
      return client.post("/emails", body);
    },
    {
      success: "Test email sent.",
      onSuccess: onClose,
      onError: (error) => setProblem(error.message),
    },
  );

  return (
    <Modal
      isOpen
      title="Send test email"
      onClose={onClose}
      onSubmit={() => void send.mutate()}
      submitLabel="Send test"
      submitting={send.isLoading}
      submitDisabled={!from.trim() || addresses(to).length === 0}
      size="large"
    >
      <div className="form">
        <Field label="From" value={from} onChange={setFrom} placeholder="hello@yourdomain.com" required />
        <TextArea label="To" value={to} onChange={setTo} rows={2} placeholder="you@example.com" hint="Separate addresses with commas or line breaks." autoFocus />
        <TextArea label="Variables" value={json} onChange={setJson} rows={8} mono hint="Prefilled with sample values. A variable left out uses its fallback." />
        {problem ? (
          <p className="alert" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
