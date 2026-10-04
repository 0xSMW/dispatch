import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Drawer } from "../../components/Drawer";
import { Failed } from "../../components/Empty";
import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { toast } from "../../components/Toast";
import { useHotkey } from "../../hooks/useHotkey";
import { shortcuts } from "../../lib/shortcuts";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { addresses } from "../../lib/utils";
import { templateKind, kindLabels } from "../../lib/emailKind";
import { useCan, useClient } from "../../shell/session";
import type { Rendered, Template } from "../../types";
import { EditorScreen, LeaveGuard, Preview, Source, TestSend, useDraft, type Flush } from "./editor";
import { blockProblem, builtIn, declarable, fill, normalizeVariables, sampleContact, scan, type Found, type Variable, type VariableType } from "./render";
import { samples, sourceNotice, useBrand, Versions } from "./Versions";
import { VariableTable } from "./Variables";

export type TemplateForm = {
  subject: string;
  from: string;
  reply_to: string;
  html: string;
  text: string;
  variables: Variable[];
};

export function toForm(template: Template): TemplateForm {
  return {
    subject: template.subject ?? "",
    from: template.from ?? "",
    reply_to: template.reply_to.join(", "),
    html: template.html ?? "",
    text: template.text ?? "",
    variables: normalizeVariables(template.variables),
  };
}

/**
 * The variables a save declares: every non-reserved key the content uses, with its settings,
 * plus unused ones the user configured. Unused keys left at the defaults drop out.
 */
export function declare(variables: Variable[], found: Found[], configured: ReadonlySet<string> = new Set()): Variable[] {
  const out: Variable[] = [];
  for (const item of found) {
    // A name the API refuses, such as `first-name`, is not declared: the save would fail on it.
    // The editor warns about it instead.
    if (builtIn(item.key) || !declarable(item.key) || out.some((entry) => entry.key === item.key)) continue;
    out.push(variables.find((entry) => entry.key === item.key) ?? { key: item.key, type: item.type, fallback_value: null });
  }
  for (const item of variables) {
    if (out.some((entry) => entry.key === item.key)) continue;
    if (configured.has(item.key) || item.type !== "string" || item.fallback_value !== null) out.push(item);
  }
  return out;
}

/** A number variable's fallback goes to the API as a number when it parses as one. */
function typed(item: Variable): Variable {
  const value = item.fallback_value;
  if (item.type === "number" && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return { ...item, fallback_value: Number(value) };
  }
  return item;
}

function foundIn(form: Pick<TemplateForm, "subject" | "html" | "text">) {
  return scan(form.subject, form.html, form.text);
}

/** Placeholder names the API does not accept as variables, such as `first-name`. */
export function invalidNames(found: Found[]) {
  return found.filter((item) => !builtIn(item.key) && !declarable(item.key)).map((item) => item.key);
}

/**
 * Values for a test send, typed the way the API checks them. A variable with a fallback is left
 * out, so the test uses the fallback as a real send would. One without gets the sample from the
 * Sample column, or a stand-in: `[KEY]` for a string, 1 for a number, an empty list for a list.
 */
export function testValues(variables: Variable[], sampleValues: Record<string, string> = {}, found: Found[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // A broadcast fills contact fields and the unsubscribe link for each recipient. A test send has
  // no recipient record, so the ones the template uses get sample values.
  for (const item of found) {
    const root = item.key.split(".")[0]!;
    if (Object.prototype.hasOwnProperty.call(sampleContact, root)) out[root] = sampleContact[root];
  }
  for (const item of variables) {
    const sample = sampleValues[item.key]?.trim() ?? "";
    if (item.type === "list") {
      let list: unknown = [];
      try {
        if (sample) list = JSON.parse(sample);
      } catch {
        list = [];
      }
      out[item.key] = Array.isArray(list) ? list : [];
    } else if (item.type === "number") {
      if (sample !== "" && Number.isFinite(Number(sample))) out[item.key] = Number(sample);
      else if (item.fallback_value === null || item.fallback_value === "") out[item.key] = 1;
    } else if (sample) {
      out[item.key] = sample;
    } else if (item.fallback_value === null || item.fallback_value === "") {
      out[item.key] = `[${item.key}]`;
    }
  }
  return out;
}

/** Turns changed form fields into a `PATCH /templates/:id` body. An emptied field is sent as null, which clears it. */
export function patchBody(changed: Partial<TemplateForm>, next: TemplateForm, sent: Variable[], configured?: ReadonlySet<string>) {
  const body: Record<string, unknown> = {};
  if ("subject" in changed) body.subject = next.subject.trim() ? next.subject : null;
  if ("from" in changed) body.from = next.from.trim() ? next.from.trim() : null;
  if ("reply_to" in changed) {
    const list = addresses(next.reply_to);
    body.reply_to = list.length ? list : null;
  }
  if ("html" in changed) body.html = next.html.trim() ? next.html : null;
  if ("text" in changed) body.text = next.text.trim() ? next.text : null;
  const declared = declare(next.variables, foundIn(next), configured).map(typed);
  if (JSON.stringify(declared) !== JSON.stringify(sent)) body.variables = declared;
  return body;
}

/** Problems to show before publishing. */
export function publishWarnings(form: TemplateForm) {
  const warnings: string[] = [];
  const found = foundIn(form);
  const problem = blockProblem(form.subject, form.html, form.text);
  if (problem) warnings.push(`${problem}. The API refuses to publish until the blocks pair up.`);
  const invalid = invalidNames(found);
  if (invalid.length) {
    warnings.push(`${invalid.join(", ")} ${invalid.length === 1 ? "is not a valid variable name" : "are not valid variable names"}. Use letters, digits, and underscores.`);
  }
  const required = declare(form.variables, found).filter(
    (item) => item.fallback_value === null && !found.some((entry) => entry.key === item.key && entry.inline),
  );
  if (required.length) {
    warnings.push(`${required.map((item) => item.key).join(", ")} ${required.length === 1 ? "has" : "have"} no fallback. Sends that leave ${required.length === 1 ? "it" : "them"} out fail.`);
  }
  if (!form.subject.trim()) warnings.push("No subject. Every send must pass one.");
  if (!form.from.trim()) warnings.push("No From address. Every send must pass one.");
  if (!form.html.trim() && !form.text.trim()) warnings.push("No content. Add HTML or plain text.");
  return warnings;
}

/** Template editor: code or visual editing with a live preview. */
export function TemplateEditor() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  // A viewer gets the editor read-only: no autosave, no test send, no publish.
  const can = useCan();
  const template = useResource<Template>(`/templates/${id}`);
  const brand = useBrand();
  const [sampleValues, setSampleValues] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [history, setHistory] = useState(false);
  const fallbacks = useRef(new Map<string, string | number>());
  const configured = useRef(new Set<string>());

  // Set by `Source`: hands over a visual edit that has not been written yet. Every save runs it first.
  const flushVisual = useRef<Flush | null>(null);
  const draft = useDraft<TemplateForm>(
    async (changed, next) => {
      const sent = normalizeVariables(template.data?.variables);
      const body = patchBody(changed, next, sent, configured.current);
      if (Object.keys(body).length === 0) return;
      template.setData(await client.patch<Template>(`/templates/${id}`, body));
    },
    { enabled: can, before: () => flushVisual.current?.() ?? Promise.resolve() },
  );
  const { form } = draft;

  useEffect(() => {
    if (template.data && !form) {
      const next = toForm(template.data);
      const used = new Set(foundIn(next).map((item) => item.key));
      configured.current = new Set(next.variables.filter((item) => !used.has(item.key)).map((item) => item.key));
      draft.load(next);
    }
  }, [template.data, form, draft.load]);

  const found = useMemo(() => (form ? foundIn(form) : []), [form]);
  const variables = useMemo(() => (form ? declare(form.variables, found, configured.current) : []), [form, found]);
  const values = useMemo(() => {
    const out: Record<string, unknown> = { ...brand, ...samples(variables) };
    for (const [key, value] of Object.entries(sampleValues)) {
      if (!value.trim()) continue;
      const type = variables.find((item) => item.key === key)?.type;
      if (type === "list") {
        try {
          out[key] = JSON.parse(value);
        } catch {
          // keep the stand-in until the JSON parses
        }
      } else out[key] = value;
    }
    return out;
  }, [brand, variables, sampleValues]);
  const preview = useMemo(() => (form ? fill(form, values, variables) : null), [form, values, variables]);

  async function saveNow() {
    const ok = await draft.save();
    if (ok) toast.success("Template saved.");
    return ok;
  }
  useHotkey(shortcuts.save.combo, () => void saveNow(), { enabled: can && Boolean(form) });

  const publish = useMutation(
    async () => {
      if (!(await draft.save())) throw new Error(draft.state.error ?? "Save the template before publishing.");
      return client.post<Template>(`/templates/${id}/publish`, {});
    },
    {
      success: "Template published.",
      onSuccess: (next) => {
        template.setData(next);
        setPublishing(false);
      },
    },
  );

  function setVariable(key: string, change: Partial<Variable>) {
    configured.current.add(key);
    draft.update((current) => {
      const base = declare(current.variables, foundIn(current), configured.current);
      const existing = base.find((item) => item.key === key) ?? { key, type: "string" as VariableType, fallback_value: null };
      const next = { ...existing, ...change };
      return { ...current, variables: base.some((item) => item.key === key) ? base.map((item) => item.key === key ? next : item) : [...base, next] };
    });
  }

  if (template.error) return <Failed message={template.error} onRetry={template.reload} />;
  const row = template.data;
  const notice = sourceNotice(row?.source);

  const kind = templateKind(form ? { ...form, source: row?.source } : row ?? {});
  return (
    <EditorScreen
      crumb={{ to: row ? `/templates/${row.id}` : "/templates", label: "Templates" }}
      title={row?.name ?? "Loading"}
      status={row ? <><Badge value={row.status} /><Badge value={kind} label={kindLabels[kind]} /></> : null}
      save={can ? draft.state : undefined}
      actions={
        <>
          <button
            type="button"
            className="ghost"
            disabled={!row}
            onClick={async () => {
              // Publishing or restoring a version reloads the form, so unsaved edits are saved first.
              if (draft.state.dirty && !(await draft.save())) {
                toast.error("Save your changes before opening the history.");
                return;
              }
              setHistory(true);
            }}
          >
            History
          </button>
          {can ? (
            <>
              <button type="button" className="secondary" disabled={!form} onClick={() => setTesting(true)}>
                Test email
              </button>
              <button type="button" disabled={!form} onClick={() => setPublishing(true)}>
                Publish
              </button>
            </>
          ) : null}
        </>
      }
    >
      {notice ? (
        <div className="notice" role="note">
          <Info size={16} aria-hidden />
          <span>{notice}</span>
        </div>
      ) : null}

      {!form || !preview ? (
        <Skeleton lines={8} />
      ) : (
        <>
          <div className="editorHead">
            <Field label="Template kind" value={kindLabels[kind]} onChange={() => undefined} disabled className="wide"
              hint="Library kind and HTML or plain text determine this value. Marketing templates cannot send as Transactional." />
            <Field label="Subject" value={form.subject} onChange={(value) => draft.set("subject", value)} placeholder="Welcome to {{{PRODUCT_NAME}}}" className="wide" disabled={!can} />
            <Field label="From" value={form.from} onChange={(value) => draft.set("from", value)} placeholder="Acme <hello@acme.com>" disabled={!can} />
            <Field label="Reply-To" value={form.reply_to} onChange={(value) => draft.set("reply_to", value)} placeholder="support@acme.com" disabled={!can} />
          </div>
          <div className="editorPanes">
            <div className="editorPane">
              <Source
                html={form.html}
                text={form.text}
                onHtml={(value) => draft.set("html", value)}
                onText={(value) => draft.set("text", value)}
                disabled={!can}
                flushRef={flushVisual}
                placeholders={{ variables, onChange: setVariable, fallbacks }}
              />
              <Panel title="Variables">
                <VariableTable
                  variables={variables}
                  found={found}
                  samples={sampleValues}
                  onSample={(key, value) => setSampleValues((current) => ({ ...current, [key]: value }))}
                  onChange={setVariable}
                  disabled={!can}
                  fallbacks={fallbacks}
                />
              </Panel>
            </div>
            <div className="editorPane">
              <p className="muted">
                <span className="dim">Subject</span> {preview.subject || "No subject"}
              </p>
              <Preview html={preview.html} />
              {preview.problem ? (
                <p className="warnMark">
                  <AlertTriangle size={13} aria-hidden /> {preview.problem}.
                </p>
              ) : null}
              {invalidNames(found).length ? (
                <p className="warnMark">
                  <AlertTriangle size={13} aria-hidden /> {invalidNames(found).join(", ")} cannot be a variable name. Use letters, digits, and underscores.
                </p>
              ) : null}
              {preview.missing.length ? (
                <p className="warnMark">
                  <AlertTriangle size={13} aria-hidden /> No value for {preview.missing.join(", ")}.
                </p>
              ) : null}
            </div>
          </div>
        </>
      )}

      <LeaveGuard when={can && (draft.state.dirty || draft.state.saving)} pending={() => flushVisual.current?.waiting() ?? false} onSave={draft.save} />

      {testing && form ? (
        <TestSend
          from={form.from}
          variables={testValues(variables.map(typed), sampleValues, found)}
          render={async (input) => {
            // Render on the server from the saved draft, so the test matches a real send exactly.
            if (!(await draft.save())) throw new Error(draft.state.error ?? "Save the template before sending a test.");
            const { rendered } = await client.post<{ rendered: Rendered }>(`/templates/${id}/render`, { variables: input, draft: true });
            return { subject: rendered.subject ?? "", html: rendered.html ?? "", text: rendered.text ?? "" };
          }}
          onClose={() => setTesting(false)}
        />
      ) : null}

      {publishing && form ? (
        <Modal
          isOpen
          title="Publish template"
          onClose={() => setPublishing(false)}
          onSubmit={() => void publish.mutate()}
          submitLabel="Publish"
          submitting={publish.isLoading}
          submitDisabled={draft.state.saving}
        >
          <PublishChecks warnings={publishWarnings(form)} />
          <p className="muted">Sends that use this template switch to this version right away.</p>
        </Modal>
      ) : null}

      {history && row ? (
        <Drawer isOpen width="wide" label="Template" title="Version history" onClose={() => setHistory(false)}>
          <Versions
            key={`${row.current_version_id}-${row.published_at}`}
            template={row}
            onChange={(next) => {
              template.setData(next);
              fallbacks.current.clear();
              const form = toForm(next);
              const used = new Set(foundIn(form).map((item) => item.key));
              configured.current = new Set(form.variables.filter((item) => !used.has(item.key)).map((item) => item.key));
              draft.load(form);
            }}
          />
        </Drawer>
      ) : null}
    </EditorScreen>
  );
}

export function PublishChecks({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) {
    return (
      <ul className="checklist">
        <li className="ok">
          <CheckCircle2 size={15} aria-hidden /> No problems found.
        </li>
      </ul>
    );
  }
  return (
    <ul className="checklist" aria-label="Warnings">
      {warnings.map((warning) => (
        <li key={warning} className="warn">
          <AlertTriangle size={15} aria-hidden /> {warning}
        </li>
      ))}
    </ul>
  );
}