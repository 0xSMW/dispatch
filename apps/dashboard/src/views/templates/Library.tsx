import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Drawer } from "../../components/Drawer";
import { Empty, Failed } from "../../components/Empty";
import { Select } from "../../components/Field";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Tabs } from "../../components/Tabs";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import { kindLabels } from "../../lib/emailKind";
import { docsBase } from "../../lib/docs";
import type { LibraryDetail, LibraryTemplate, List, Rendered } from "../../types";
import { templateTabs } from "../tabs";
import { Preview, Thumb } from "./editor";
import { Presets } from "../automations/Presets";

// Local until the listing contract is added to the shared dashboard types.
export type DiscoveryTemplate = LibraryTemplate & { stage?: string | null; when?: string };
export type LibraryTab = "transactional" | "lifecycle";
export const stageOptions = [
  { value: "acquisition", label: "Acquisition" },
  { value: "onboarding", label: "Onboarding" },
  { value: "retention", label: "Retention" },
  { value: "reengagement", label: "Re-engagement" },
  { value: "dunning", label: "Dunning" },
  { value: "reactivation", label: "Reactivation" },
];

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

/** Default template gallery. */
export function Library() {
  const library = useResource<List<DiscoveryTemplate>>("/template-library");
  const [open, setOpen] = useState<DiscoveryTemplate | null>(null);
  const [params, setParams] = useSearchParams();
  const tab: LibraryTab = params.get("tab") === "lifecycle" ? "lifecycle" : "transactional";
  const stage = stageOptions.some((option) => option.value === params.get("stage")) ? params.get("stage")! : "";
  const entries = library.data?.data ?? [];
  const visible = visibleTemplates(entries, tab, stage);
  function filter(name: string, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    });
  }

  return (
    <div className="page">
      <PageHeader title="Templates" description="Ready-made emails rendered with your brand. Install one to send it by its alias."
        actions={<Link className="button secondary" to="/settings/brand">Edit brand</Link>} />
      <Tabs tabs={templateTabs} />
      <Tabs label="Library templates" value={tab} onChange={(value) => filter("tab", value)}
        tabs={[{ id: "transactional", label: "Transactional" }, { id: "lifecycle", label: "Lifecycle" }]} />
      {tab === "lifecycle" ? (
        <div className="stack">
          <p className="muted">Emails for each stage of the customer lifecycle. Marketing emails respect topic opt-outs; transactional emails are always sent.</p>
          <Select label="Stage" value={stage} onChange={(value) => filter("stage", value)} placeholder="All stages" options={stageOptions} />
          <Presets stage={stage} />
        </div>
      ) : null}
      {library.error ? (
        <Failed message={library.error} onRetry={() => void library.reload()} />
      ) : library.loading && !library.data ? (
        <Skeleton lines={6} />
      ) : entries.length === 0 ? (
        <Empty title="No library templates" body="The template library is empty on this install." />
      ) : visible.length === 0 ? (
        <Empty title="No matching templates" body="Choose another stage or library tab." />
      ) : (
        byCategory(visible).map(([category, items]) => (
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

function LibraryPreview({ entry, onClose }: { entry: DiscoveryTemplate; onClose: () => void }) {
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
