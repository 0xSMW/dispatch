import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Drawer } from "../../components/Drawer";
import { Empty, Failed } from "../../components/Empty";
import { FilterBar } from "../../components/FilterBar";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { useMutation } from "../../hooks/useMutation";
import { useFilters } from "../../hooks/useFilters";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import { kindLabels } from "../../lib/emailKind";
import { docsBase } from "../../lib/docs";
import type { LibraryDetail, LibraryTemplate, List, Rendered } from "../../types";
import { Preview, Thumb } from "./editor";

// Local until the listing contract is added to the shared dashboard types.
export type DiscoveryTemplate = LibraryTemplate & { stage?: string | null; when?: string };
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

function title(category: string) {
  const text = category.replaceAll("_", " ").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** An explicit browse view, separate from the account's template collection. */
export function Library() {
  const library = useResource<List<DiscoveryTemplate>>("/template-library");
  const [open, setOpen] = useState<DiscoveryTemplate | null>(null);
  const [, setParams] = useSearchParams();
  const filters = useFilters(["q", "category"]);
  const entries = library.data?.data ?? [];
  const query = filters.q?.trim().toLowerCase() ?? "";
  const visible = entries.filter((entry) =>
    (!filters.category || entry.category === filters.category) &&
    (!query || `${entry.name} ${entry.slug} ${entry.description}`.toLowerCase().includes(query)),
  );
  const categories = [...new Set(entries.map((entry) => entry.category))];

  return (
    <div className="page">
      <PageHeader title="Browse templates" back={{ to: "/templates", label: "Templates" }} />
      <FilterBar search="Search templates" filters={[{
        param: "category", label: "Category", all: "All categories",
        options: categories.map((category) => ({ value: category, label: title(category) })),
      }]} />
      {library.error ? (
        <Failed message={library.error} onRetry={() => void library.reload()} />
      ) : library.loading && !library.data ? (
        <Skeleton lines={6} />
      ) : entries.length === 0 ? (
        <Empty title="No library templates" body="There are no templates in the library yet." />
      ) : visible.length === 0 ? (
        <Empty title="No templates match" body="Try a different search or category." action={
          <button type="button" className="secondary" onClick={() => setParams({})}>Clear filters</button>
        } />
      ) : (
        <div className="cardGrid">
          {visible.map((entry) => (
            <LibraryCard key={entry.slug} entry={entry} onOpen={() => setOpen(entry)} />
          ))}
        </div>
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
      <button type="button" className="cardPreview" aria-label={`Preview ${entry.name}`} onClick={onOpen}>
        <Thumb html={rendered?.html ?? (detail.loading ? undefined : null)} />
      </button>
      <div className="cardBody">
        <div className="cardIdentity">
          <button type="button" className="cardLink" onClick={onOpen}>
            {entry.name}
          </button>
          <span className="cardSlug mono">{entry.slug}</span>
        </div>
      </div>
    </article>
  );
}

function LibraryPreview({ entry, onClose }: { entry: DiscoveryTemplate; onClose: () => void }) {
  const client = useClient();
  const can = useCan();
  const navigate = useNavigate();
  const detail = useResource<LibraryDetail>(`/template-library/${entry.slug}`);
  const install = useMutation(() => client.post<{ object: "template"; id: string }>(`/template-library/${entry.slug}/install`), {
    success: "Template added.",
    onSuccess: (result) => navigate(`/templates?added=${encodeURIComponent(result.id)}`),
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
        can ? (
          <button type="button" disabled={install.isLoading} aria-busy={install.isLoading} onClick={() => void install.mutate()}>
            {install.isLoading ? <span className="spinner" aria-hidden /> : null}
            Add to templates
          </button>
        ) : null
      }
    >
      <div className="stack">
        <Badge value={entry.kind} label={kindLabels[entry.kind]} />
        <p className="muted">{entry.description}</p>
        <Guidance entry={entry} />
        <Link to="/settings/brand">Edit brand</Link>
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
