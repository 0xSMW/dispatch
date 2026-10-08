import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Badge } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Empty, Failed } from "../../components/Empty";
import { Field, TextArea } from "../../components/Field";
import { FilterBar } from "../../components/FilterBar";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useFilters } from "../../hooks/useFilters";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { learnLinks } from "../../lib/docs";
import { kindLabels, templateKind } from "../../lib/emailKind";
import { useCan, useClient } from "../../shell/session";
import type { Template } from "../../types";
import { Library } from "./Library";
import { Thumb } from "./editor";
import { fill, normalizeVariables } from "./render";
import { samples, useBrand } from "./Versions";

/** Template grid: cards with a thumbnail, name, alias, and status. */
export function Templates() {
  const [, setParams] = useSearchParams();
  const client = useClient();
  const can = useCan();
  const navigate = useNavigate();
  const filters = useFilters(["q", "status"]);
  const list = useList<Template>("/templates", filters, { limit: 100 });
  const brand = useBrand();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Template | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const rows = list.rows;
  const filtered = Boolean(filters.q || filters.status);
  const empty = !list.loading && !list.error && list.page === 1 && rows.length === 0 && !filtered;

  const duplicate = useMutation((row: Template) => client.post<Template>(`/templates/${row.id}/duplicate`), {
    success: "Template duplicated.",
    onSuccess: () => list.reload(),
  });

  return (
    <div className="page">
      <PageHeader
        title="Templates"
        learn={empty ? undefined : learnLinks("templates")}
        actions={can ? <button type="button" onClick={() => setCreating(true)}>Create template</button> : null}
      />
      <section className="stack" aria-labelledby="your-templates-title">
        <h2 id="your-templates-title">Your templates</h2>
        {!empty ? <FilterBar search="Search templates" filters={[{ param: "status", label: "Status", options: ["draft", "published"] }]} /> : null}

        {list.error ? (
          <Failed message={list.error} onRetry={() => void list.reload()} />
        ) : list.loading && list.rows.length === 0 ? (
          <div className="cardGrid" aria-busy>
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="card">
                <div className="cardBody">
                  <Skeleton lines={3} />
                </div>
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          !filtered ? (
            <Empty
              title="No templates yet"
              body="Create your own, or choose a ready-made template below."
            />
          ) : (
            <Empty title="No templates match" body="Try a different search or status." action={<button type="button" className="secondary" onClick={() => setParams((previous) => { const next = new URLSearchParams(previous); next.delete("q"); next.delete("status"); return next; })}>Clear filters</button>} />
          )
        ) : (
          <div className="cardGrid">
            {rows.map((row) => (
              <TemplateCard
                key={row.id}
                row={row}
                brand={brand}
                menu={
                  can ? (
                    <Menu
                      label={`Actions for ${row.name}`}
                      items={[
                        { label: "View details", read: true, onSelect: () => navigate(`/templates/${row.id}`) },
                        { label: "Edit", onSelect: () => navigate(`/templates/${row.id}/editor`) },
                        { label: "Rename", onSelect: () => setRenaming(row) },
                        { label: "Duplicate", onSelect: () => void duplicate.mutate(row) },
                        "divider",
                        { label: "Delete", danger: true, onSelect: () => setDeleting(row) },
                      ]}
                    />
                  ) : null
                }
              />
            ))}
          </div>
        )}

        {list.page > 1 || list.hasMore ? (
          <div className="tableFooter">
            <span>Page {list.page}</span>
            <div className="toolbar">
              <button type="button" className="secondary small" disabled={list.page <= 1 || list.loading} onClick={list.previous}>
                Previous
              </button>
              <button type="button" className="secondary small" disabled={!list.hasMore || list.loading} onClick={list.next}>
                Next
              </button>
            </div>
          </div>
        ) : null}
      </section>
      <Library onInstalled={() => void list.reload()} />

      {creating ? <CreateTemplate onClose={() => setCreating(false)} /> : null}
      {renaming ? <Rename template={renaming} onClose={() => setRenaming(null)} onDone={() => void list.reload()} /> : null}
      {deleting ? (
        <ConfirmPhrase
          title="Delete template"
          body={`Sends that use ${deleting.alias ?? deleting.name} will fail.`}
          phrase={deleting.name}
          action="Delete template"
          onConfirm={() => client.delete(`/templates/${deleting.id}`)}
          onClose={() => setDeleting(null)}
          onDone={() => {
            toast.success("Template deleted.");
            void list.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function TemplateCard({ row, brand, menu }: { row: Template; brand: Record<string, unknown>; menu: ReactNode }) {
  const html = useMemo(() => {
    const variables = normalizeVariables(row.variables);
    return row.html ? fill(row, { ...brand, ...samples(variables) }, variables).html : null;
  }, [row, brand]);
  return (
    <article className="card" aria-label={row.name}>
      <Link to={`/templates/${row.id}`} tabIndex={-1} aria-hidden>
        <Thumb html={html} />
      </Link>
      <div className="cardBody">
        <div className="cardTitle">
          <Link to={`/templates/${row.id}`}>{row.name}</Link>
          {menu}
        </div>
        <div className="cardMeta">
          {row.alias ? <span className="mono">{row.alias}</span> : null}
          <Badge value={row.status} />
          <Badge value={templateKind(row)} label={kindLabels[templateKind(row)]} />
          {row.status === "published" && row.has_unpublished_versions ? <Badge value="pending" label="Unpublished changes" /> : null}
        </div>
        <div className="cardMeta">
          <span>
            Updated <Time value={row.updated_at} />
          </span>
        </div>
      </div>
    </article>
  );
}

/** Rename modal, shared with the detail page. */
export function Rename({ template, onClose, onDone }: { template: Template; onClose: () => void; onDone: (template: Template) => void }) {
  const client = useClient();
  const [name, setName] = useState(template.name);
  const save = useMutation(() => client.patch<Template>(`/templates/${template.id}`, { name: name.trim() }), {
    success: "Template renamed.",
    onSuccess: (next) => {
      onDone(next);
      onClose();
    },
  });
  return (
    <Modal isOpen title="Rename template" onClose={onClose} onSubmit={() => void save.mutate()} submitLabel="Rename" submitting={save.isLoading} submitDisabled={!name.trim()}>
      <div className="form">
        <Field label="Name" value={name} onChange={setName} required autoFocus />
      </div>
    </Modal>
  );
}

/** Body for `POST /templates`. Templates are created as drafts and published from the editor. */
export function createBody(form: { name: string; alias: string; html: string }) {
  const body: Record<string, unknown> = { name: form.name.trim() };
  if (form.alias.trim()) body.alias = form.alias.trim();
  if (form.html.trim()) body.html = form.html;
  return body;
}

function CreateTemplate({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"blank" | "import">("blank");
  const [form, setForm] = useState({ name: "", alias: "", html: "" });
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const create = useMutation(() => client.post<Template>("/templates", createBody(mode === "blank" ? { ...form, html: "" } : form)), {
    success: "Template created.",
    onSuccess: (template) => navigate(`/templates/${template.id}/editor`),
  });

  async function pick(file: File | undefined) {
    if (!file) return;
    const html = await file.text();
    setForm((current) => ({ ...current, html, name: current.name || file.name.replace(/\.html?$/i, "") }));
  }

  return (
    <Modal
      isOpen
      title="Create template"
      onClose={onClose}
      onSubmit={() => void create.mutate()}
      submitLabel="Create"
      submitting={create.isLoading}
      submitDisabled={!form.name.trim() || (mode === "import" && !form.html.trim())}
      size="large"
    >
      <div className="stack">
        <Tabs
          label="Start from"
          value={mode}
          onChange={setMode}
          tabs={[
            { id: "blank", label: "Blank" },
            { id: "import", label: "Import HTML" },
          ]}
        />
        <div className="form two">
          <Field label="Name" value={form.name} onChange={set("name")} placeholder="Welcome" required autoFocus />
          <Field label="Alias" value={form.alias} onChange={set("alias")} placeholder="welcome" mono hint="Send with this instead of the ID." />
          {mode === "import" ? (
            <>
              <div className="field wide">
                <label htmlFor="template-file">HTML file</label>
                <input id="template-file" type="file" accept=".html,.htm,text/html" onChange={(event) => void pick(event.target.files?.[0])} />
              </div>
              <TextArea label="HTML" value={form.html} onChange={set("html")} mono rows={8} wide placeholder="Paste HTML, or choose a file." />
            </>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
