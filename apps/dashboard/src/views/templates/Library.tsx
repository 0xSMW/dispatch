import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Drawer } from "../../components/Drawer";
import { Empty, Failed } from "../../components/Empty";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Tabs } from "../../components/Tabs";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { LibraryDetail, LibraryTemplate, List, Rendered } from "../../types";
import { templateTabs } from "../tabs";
import { Preview, Thumb } from "./editor";

/** The rendered entry. The API is renaming `preview` to `rendered`; read both until that lands. */
export function renderedOf(data: LibraryDetail | null | undefined): Rendered | null {
  if (!data) return null;
  if (data.rendered) return data.rendered;
  return data.preview && typeof data.preview === "object" ? data.preview : null;
}

/** Entries grouped by category, in the order the manifest lists them. */
export function byCategory(entries: LibraryTemplate[]) {
  const groups = new Map<string, LibraryTemplate[]>();
  for (const entry of entries) groups.set(entry.category, [...(groups.get(entry.category) ?? []), entry]);
  return [...groups.entries()];
}

function title(category: string) {
  const text = category.replaceAll("_", " ").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Default template gallery. */
export function Library() {
  const library = useResource<List<LibraryTemplate>>("/template-library");
  const [open, setOpen] = useState<LibraryTemplate | null>(null);
  const entries = library.data?.data ?? [];

  return (
    <div className="page">
      <PageHeader title="Templates" description="Ready-made emails rendered with your brand. Install one to send it by its alias." />
      <Tabs tabs={templateTabs} />
      {library.error ? (
        <Failed message={library.error} onRetry={() => void library.reload()} />
      ) : library.loading && !library.data ? (
        <Skeleton lines={6} />
      ) : entries.length === 0 ? (
        <Empty title="No library templates" body="The template library is empty on this install." />
      ) : (
        byCategory(entries).map(([category, items]) => (
          <section key={category} className="stack" aria-label={title(category)}>
            <h2 className="categoryTitle">{title(category)}</h2>
            <div className="cardGrid">
              {items.map((entry) => (
                <LibraryCard key={entry.slug} entry={entry} onOpen={() => setOpen(entry)} />
              ))}
            </div>
          </section>
        ))
      )}
      {open ? <LibraryPreview entry={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function LibraryCard({ entry, onOpen }: { entry: LibraryTemplate; onOpen: () => void }) {
  const detail = useResource<LibraryDetail>(`/template-library/${entry.slug}`);
  const rendered = renderedOf(detail.data);
  return (
    <article className="card" aria-label={entry.name}>
      <Thumb html={rendered?.html} />
      <div className="cardBody">
        <div className="cardTitle">
          <button type="button" className="cardLink" onClick={onOpen}>
            {entry.name}
          </button>
          <Badge value={entry.kind} variant={entry.kind === "marketing" ? "accent" : "neutral"} />
        </div>
        <p className="cardText">{entry.description}</p>
        <div className="cardMeta">
          <span className="mono">{entry.slug}</span>
          <span>{entry.variables.length} variables</span>
        </div>
      </div>
    </article>
  );
}

function LibraryPreview({ entry, onClose }: { entry: LibraryTemplate; onClose: () => void }) {
  const client = useClient();
  const can = useCan();
  const detail = useResource<LibraryDetail>(`/template-library/${entry.slug}`);
  const [installed, setInstalled] = useState<string | null>(null);
  const install = useMutation(() => client.post<{ object: "template"; id: string }>(`/template-library/${entry.slug}/install`), {
    success: "Template installed.",
    onSuccess: (result) => setInstalled(result.id),
  });
  const rendered = renderedOf(detail.data);

  return (
    <Drawer
      isOpen
      width="wide"
      label="Library template"
      title={entry.name}
      onClose={onClose}
      actions={
        installed ? (
          <Link className="button" to={`/templates/${installed}`}>
            Open template
          </Link>
        ) : can ? (
          <button type="button" disabled={install.isLoading} aria-busy={install.isLoading} onClick={() => void install.mutate()}>
            {install.isLoading ? <span className="spinner" aria-hidden /> : null}
            Use template
          </button>
        ) : null
      }
    >
      <div className="stack">
        <p className="muted">{entry.description}</p>
        {installed ? (
          <p className="notice" role="status">
            Installed as <span className="mono">{entry.slug}</span>. Send it with <span className="mono">{`template: { id: "${entry.slug}" }`}</span>.
          </p>
        ) : null}
        {detail.error ? (
          <Failed message={detail.error} onRetry={() => void detail.reload()} />
        ) : rendered ? (
          <>
            <p>
              <span className="dim">Subject</span> {rendered.subject}
            </p>
            <Preview html={rendered.html ?? ""} />
          </>
        ) : (
          <Skeleton lines={6} />
        )}
        <Panel title="Variables">
          <Table
            compact
            rows={entry.variables}
            rowKey={(item) => item.key}
            empty={<p className="muted">Only brand values.</p>}
            columns={[
              { header: "Key", cell: (item) => <span className="mono">{item.key}</span> },
              { header: "Type", cell: (item) => item.type ?? "string" },
              {
                header: "Fallback",
                cell: (item) =>
                  item.fallback_value === null || item.fallback_value === undefined ? (
                    <span className="warnMark">
                      <AlertTriangle size={13} aria-hidden /> Required
                    </span>
                  ) : item.fallback_value === "" ? (
                    <span className="dim">Empty, optional</span>
                  ) : (
                    <span className="mono">{String(item.fallback_value)}</span>
                  ),
              },
            ]}
          />
        </Panel>
      </div>
    </Drawer>
  );
}
