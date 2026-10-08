import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Drawer } from "../../components/Drawer";
import { Empty, Failed } from "../../components/Empty";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import { kindLabels } from "../../lib/emailKind";
import { docsBase } from "../../lib/docs";
import type { LibraryDetail, LibraryTemplate, List, Rendered } from "../../types";
import { Preview, Thumb } from "./editor";

// Local until the listing contract is added to the shared dashboard types.
export type DiscoveryTemplate = LibraryTemplate & { stage?: string | null; when?: string };
export type LibraryTab = "transactional" | "lifecycle";
/** Stage takes precedence over kind: transactional dunning emails are lifecycle emails too. */
export function libraryTab(entry: DiscoveryTemplate): LibraryTab {
  return entry.stage || entry.kind === "marketing" ? "lifecycle" : "transactional";
}

export function visibleTemplates(entries: DiscoveryTemplate[], tab: LibraryTab, stage = "") {
  return entries.filter((entry) => libraryTab(entry) === tab && (tab !== "lifecycle" || !stage || entry.stage === stage));
}

// Only link to public recipes actually bundled with the dashboard.
const recipes = import.meta.glob<string>("../../../../../docs/templates/{stripe,authjs,better-auth}.md", {
  query: "?raw", import: "default", eager: true,
});
export function recipeLinks(category: string) {
  const names = category === "billing" ? ["stripe"] : category === "authentication" ? ["authjs", "better-auth"] : [];
  const labels: Record<string, string> = { stripe: "Stripe recipe", authjs: "Auth.js recipe", "better-auth": "Better Auth recipe" };
  return names.filter((name) => Object.keys(recipes).some((path) => path.endsWith(`/${name}.md`)))
    .map((name) => ({ label: labels[name]!, href: `${docsBase()}templates/${name}.md` }));
}

function Guidance({ entry }: { entry: DiscoveryTemplate }) {
  return (
    <>
      {entry.when ? <p className="cardText"><strong>When to send:</strong> {entry.when}</p> : null}
      {recipeLinks(entry.category).map((recipe) => (
        <a key={recipe.href} href={recipe.href} target="_blank" rel="noreferrer">{recipe.label}</a>
      ))}
    </>
  );
}

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

/** Ready-made templates shown directly below the account's templates. */
export function Library({ onInstalled }: { onInstalled?: () => void }) {
  const library = useResource<List<DiscoveryTemplate>>("/template-library");
  const [open, setOpen] = useState<DiscoveryTemplate | null>(null);
  const entries = library.data?.data ?? [];

  return (
    <section className="stack" id="ready-made" aria-labelledby="ready-made-title">
      <h2 id="ready-made-title">Ready-made templates</h2>
      {library.error ? (
        <Failed message={library.error} onRetry={() => void library.reload()} />
      ) : library.loading && !library.data ? (
        <Skeleton lines={6} />
      ) : entries.length === 0 ? (
        <Empty title="No ready-made templates" body="There are no ready-made templates here yet." />
      ) : (
        (["transactional", "lifecycle"] as const).map((group) => {
          const items = visibleTemplates(entries, group);
          if (!items.length) return null;
          return (
            <section key={group} className="stack" aria-label={title(group)}>
              <h3>{title(group)}</h3>
              {byCategory(items).map(([category, templates]) => (
                <section key={category} className="stack" aria-label={title(category)}>
                  <h4 className="categoryTitle">{title(category)}</h4>
                  <div className="cardGrid">
                    {templates.map((entry) => (
                      <LibraryCard key={entry.slug} entry={entry} onOpen={() => setOpen(entry)} />
                    ))}
                  </div>
                </section>
              ))}
            </section>
          );
        })
      )}
      {open ? <LibraryPreview entry={open} onClose={() => setOpen(null)} onInstalled={onInstalled} /> : null}
    </section>
  );
}

function LibraryCard({ entry, onOpen }: { entry: DiscoveryTemplate; onOpen: () => void }) {
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
          <Badge value={entry.kind} label={kindLabels[entry.kind]} variant={entry.kind === "marketing" ? "accent" : "neutral"} />
        </div>
        <p className="cardText">{entry.description}</p>
        <Guidance entry={entry} />
        <div className="cardMeta">
          <span className="mono">{entry.slug}</span>
          <span>{entry.variables.length} variables</span>
        </div>
      </div>
    </article>
  );
}

function LibraryPreview({ entry, onClose, onInstalled }: { entry: DiscoveryTemplate; onClose: () => void; onInstalled?: () => void }) {
  const client = useClient();
  const can = useCan();
  const detail = useResource<LibraryDetail>(`/template-library/${entry.slug}`);
  const [installed, setInstalled] = useState<string | null>(null);
  const install = useMutation(() => client.post<{ object: "template"; id: string }>(`/template-library/${entry.slug}/install`), {
    success: "Template installed.",
    onSuccess: (result) => {
      setInstalled(result.id);
      onInstalled?.();
    },
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
        <Badge value={entry.kind} label={kindLabels[entry.kind]} />
        <p className="muted">{entry.description}</p>
        <Guidance entry={entry} />
        <Link to="/settings/brand">Edit brand</Link>
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
            empty={<p className="muted">This template only uses your brand values, so there's nothing to fill in.</p>}
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
