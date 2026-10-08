import { useState } from "react";
import { Badge } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { copyText } from "../../components/Copy";
import { Empty } from "../../components/Empty";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { ApiError } from "../../lib/client";
import { useCan, useClient, useSession } from "../../shell/session";
import type { ContactProperty, Domain, Form, Topic } from "../../types";
import { audienceTabs } from "../tabs";
import { FormFields, type FormChoice, type FormDraft } from "./FormFields";
import { formSnippets } from "./snippets";

export function formDraft(form?: Form): FormDraft {
  return {
    name: form?.name ?? "",
    topic_ids: [...(form?.topic_ids ?? [])],
    properties: [...(form?.properties ?? [])],
    double_opt_in: form?.double_opt_in ?? true,
    from_email: form?.from_email ?? "",
    allowed_origins: [...(form?.allowed_origins ?? [""])],
    redirect_url: form?.redirect_url ?? "",
  };
}

export function formBody(draft: FormDraft) {
  return {
    ...draft,
    name: draft.name.trim(),
    from_email: draft.from_email.trim(),
    topic_ids: [...draft.topic_ids],
    properties: [...draft.properties],
    allowed_origins: draft.allowed_origins.map((origin) => origin.trim()),
    redirect_url: draft.redirect_url.trim() || null,
  };
}

/** Domains are not sender addresses. Offer a clear default address and retain a valid current one. */
export function formSenders(domains: readonly Domain[], current = ""): FormChoice[] {
  const verified = domains.filter((domain) => domain.status === "verified" && domain.capabilities.sending === "enabled");
  const choices = [...new Set(verified.map((domain) => `no-reply@${domain.name}`))]
    .map((value) => ({ value, label: value }));
  const address = current.trim();
  const parts = address.split("@");
  const validCurrent = parts.length === 2 && /^[^\s<>@]+$/.test(parts[0]!)
    && verified.some((domain) => domain.name.toLowerCase() === parts[1]!.toLowerCase());
  if (validCurrent && !choices.some((choice) => choice.value === address)) {
    choices.push({ value: address, label: `${address} (current sender)` });
  }
  return choices;
}

type FieldErrors = Partial<Record<keyof FormDraft, string>>;

function inputErrors(draft: FormDraft, senders: readonly FormChoice[]): FieldErrors {
  const errors: FieldErrors = {};
  if (!draft.name.trim() || draft.name.trim().length > 120) errors.name = "Use a name of 1–120 characters.";
  if (!draft.topic_ids.length || draft.topic_ids.length > 100) errors.topic_ids = "Choose 1–100 topics.";
  if (draft.properties.length > 100) errors.properties = "Choose at most 100 properties.";
  if (!senders.some((sender) => sender.value === draft.from_email.trim())) errors.from_email = "Choose a sender on a verified, sending-enabled domain.";
  if (!draft.allowed_origins.length || draft.allowed_origins.length > 50 || draft.allowed_origins.some((value) => {
    try {
      const url = new URL(value.trim());
      return !["http:", "https:"].includes(url.protocol) || url.origin !== value.trim() || Boolean(url.username || url.password);
    } catch { return true; }
  })) errors.allowed_origins = "Use 1–50 exact HTTP or HTTPS origins, without paths.";
  if (draft.redirect_url.trim()) {
    try {
      const url = new URL(draft.redirect_url.trim());
      if (url.protocol !== "https:" || url.username || url.password) errors.redirect_url = "Use an HTTPS URL without credentials.";
    } catch { errors.redirect_url = "Use an HTTPS URL without credentials."; }
  }
  return errors;
}

/** Authenticated management only; snippet submissions use the deployment's public endpoint. */
export function Forms() {
  const client = useClient();
  const can = useCan();
  const { session } = useSession();
  const list = useList<Form>("/forms");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Form | null>(null);
  const [deleting, setDeleting] = useState<Form | null>(null);
  const [open, setOpen] = useState<Form | null>(null);

  return (
    <ListPage
      title="Audience"
      tabs={audienceTabs}
      actions={can ? <button type="button" onClick={() => setCreating(true)}>Create form</button> : null}
      list={list}
      noun="forms"
      onRowClick={setOpen}
      empty={<Empty title="No forms yet" body="Create a form to start collecting subscribers." />}
      columns={[
        { header: "Name", cell: (form) => form.name },
        { header: "Key", cell: (form) => <span className="mono">{form.key}</span> },
        { header: "Topics", cell: (form) => form.topic_ids.length },
        { header: "Confirmation", cell: (form) => <Badge value={form.double_opt_in ? "enabled" : "disabled"} label={form.double_opt_in ? "Double opt-in" : "Single opt-in"} /> },
        { header: "Created", cell: (form) => <Time value={form.created_at} /> },
      ]}
      menu={(form) => <Menu items={[
        { label: "View snippets", read: true, onSelect: () => setOpen(form) },
        ...(can ? [
          { label: "Edit", onSelect: () => setEditing(form) },
          { label: "Delete", danger: true, onSelect: () => setDeleting(form) },
        ] : []),
      ]} />}
    >
      {can && creating ? <FormEditor onClose={() => setCreating(false)} onDone={(form) => {
        setCreating(false);
        setOpen(form);
        void list.reload();
      }} /> : null}
      {can && editing ? <EditForm form={editing} onClose={() => setEditing(null)} onDone={(form) => {
        setEditing(null);
        setOpen(form);
        void list.reload();
      }} /> : null}
      {open && session ? <Snippets form={open} publicUrl={session.apiUrl} onClose={() => setOpen(null)} /> : null}
      {can && deleting ? <ConfirmPhrase
        title="Delete form"
        body="This form will stop accepting submissions. Existing contacts and their topic subscriptions are kept."
        phrase={deleting.name}
        action="Delete form"
        onConfirm={() => {
          if (!can) return Promise.reject(new Error("Full permissions are required."));
          return client.delete(`/forms/${encodeURIComponent(deleting.id)}`);
        }}
        onClose={() => setDeleting(null)}
        onDone={() => {
          if (open?.id === deleting.id) setOpen(null);
          toast.success("Form deleted.");
          void list.reload();
        }}
      /> : null}
    </ListPage>
  );
}

function EditForm({ form, onClose, onDone }: { form: Form; onClose: () => void; onDone: (form: Form) => void }) {
  const resource = useResource<Form>(`/forms/${encodeURIComponent(form.id)}`);
  if (!resource.data) return <Modal isOpen title="Edit form" onClose={onClose}>
    {resource.error ? <div className="stack"><p role="alert">{resource.error}</p><button type="button" onClick={() => void resource.reload()}>Retry</button></div> : <p role="status">Loading form…</p>}
  </Modal>;
  return <FormEditor key={resource.data.updated_at} form={resource.data} onClose={onClose} onDone={onDone} />;
}

function FormEditor({ form, onClose, onDone }: { form?: Form; onClose: () => void; onDone: (form: Form) => void }) {
  const client = useClient();
  const can = useCan();
  const topics = useList<Topic>("/topics", {}, { all: true });
  const properties = useList<ContactProperty>("/contact-properties", {}, { all: true });
  const domains = useList<Domain>("/domains", {}, { all: true });
  const [draft, setDraft] = useState(() => formDraft(form));
  const [errors, setErrors] = useState<FieldErrors>({});
  const senders = formSenders(domains.rows, form?.from_email);
  const resources = [topics, properties, domains];
  const loading = resources.some((resource) => resource.loading);
  const failed = resources.some((resource) => resource.error);
  const missingPrerequisites = !topics.rows.length || !senders.length;
  const save = useMutation(async () => {
    if (!can) throw new Error("Full permissions are required.");
    return form
      ? client.patch<Form>(`/forms/${encodeURIComponent(form.id)}`, formBody(draft))
      : client.post<Form>("/forms", formBody(draft));
  }, {
    success: form ? "Form saved." : "Form created.",
    onSuccess: onDone,
    onError: (error) => {
      if (error instanceof ApiError) {
        const next: FieldErrors = {};
        for (const issue of error.issues) {
          const key = issue.path.split(".")[0] as keyof FormDraft;
          if (Object.hasOwn(draft, key)) next[key] = issue.message;
        }
        setErrors(next);
      }
    },
  });
  return <Modal
    isOpen title={form ? "Edit form" : "Create form"} onClose={onClose} size="large"
    submitLabel={form ? "Save" : "Create"}
    submitDisabled={!can || loading || failed || missingPrerequisites} submitting={save.isLoading}
    onSubmit={() => {
      if (!can || loading || failed || missingPrerequisites || save.isLoading) return;
      const next = inputErrors(draft, senders);
      setErrors(next);
      if (!Object.keys(next).length) void save.mutate();
    }}
  >
    {loading ? <p role="status">Loading form choices…</p> : null}
    {resources.map((resource, index) => resource.error ? <div className="stack" key={index}>
      <p role="alert">Could not load {["topics", "properties", "domains"][index]}: {resource.error}</p>
      <button type="button" onClick={() => void resource.reload()}>Retry {["topics", "properties", "domains"][index]}</button>
    </div> : null)}
    {!loading && !failed && missingPrerequisites ? <div className="stack">
      <p className="fieldHint">A form needs a topic and a verified sending domain. Complete setup in a new tab, then refresh here to keep your draft.</p>
      <div className="toolbar">
        {!topics.rows.length ? <a href="/audience/topics" target="_blank" rel="noreferrer">Create topic</a> : null}
        {!senders.length ? <a href="/domains" target="_blank" rel="noreferrer">Verify sending domain</a> : null}
        <button type="button" className="secondary" onClick={() => { void topics.reload(); void domains.reload(); }}>Refresh setup</button>
      </div>
    </div> : null}
    {save.error ? <p role="alert">{save.error.message}</p> : null}
    <FormFields
      value={draft} onChange={(next) => { setDraft(next); setErrors({}); }}
      topics={topics.rows.map((topic) => ({ value: topic.id, label: topic.name }))}
      properties={properties.rows.map((property) => ({ value: property.key, label: property.key }))}
      senders={senders} disabled={!can || loading || failed || save.isLoading} errors={errors}
    />
  </Modal>;
}

function Snippets({ form, publicUrl, onClose }: { form: Form; publicUrl: string; onClose: () => void }) {
  const [tab, setTab] = useState<"html" | "fetch">("html");
  let snippets: ReturnType<typeof formSnippets>;
  try {
    snippets = formSnippets({ publicUrl, key: form.key, properties: form.properties });
  } catch (error) {
    return <Modal isOpen title={form.name} onClose={onClose}><p role="alert">{error instanceof Error ? error.message : "Could not generate snippets."}</p></Modal>;
  }
  return <Modal isOpen title={form.name} onClose={onClose} size="large">
    <div className="stack">
      <p className="muted">Use this on an allowed origin: {form.allowed_origins.join(", ")}. Submissions are limited to 16 KB. Never add an API key.</p>
      <p className="muted">The HTML form submits directly and displays the API's JSON response. Use fetch to show the thank-you message on your own page.</p>
      <Tabs tabs={[{ id: "html", label: "HTML" }, { id: "fetch", label: "Fetch" }]} value={tab} onChange={setTab} label="Form snippets" />
      <button type="button" className="secondary" onClick={async () => {
        if (await copyText(snippets[tab])) toast.success("Snippet copied.");
        else toast.error("Could not copy. Select the snippet and copy it manually.");
      }}>Copy {tab === "html" ? "HTML" : "fetch"} snippet</button>
      <pre><code>{snippets[tab]}</code></pre>
    </div>
  </Modal>;
}
