import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Drawer } from "../../components/Drawer";
import { Menu } from "../../components/Menu";
import { Table } from "../../components/Table";
import { Time } from "../../components/Time";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useClient } from "../../shell/session";
import type { Brand, List, Template, TemplateSource, TemplateVersion } from "../../types";
import { Preview } from "./editor";
import { brandValues, fill, normalizeVariables, sampleContact, type Variable } from "./render";

/**
 * Brand values for previews, plus a sample recipient for templates that use contact fields or an
 * unsubscribe link. A failed `/brand` call leaves the brand placeholders visible.
 */
export function useBrand() {
  const brand = useResource<Brand>("/brand");
  return useMemo(() => ({ ...sampleContact, ...brandValues(brand.data) }), [brand.data]);
}

/** Sample values for a template preview: each variable's fallback, else a readable stand-in. */
export function samples(variables: Variable[]) {
  return Object.fromEntries(
    variables.map((item) => [
      item.key,
      item.fallback_value !== null && item.fallback_value !== "" ? String(item.fallback_value) : item.type === "list" ? "" : item.type === "number" ? "1" : `[${item.key}]`,
    ]),
  );
}

/** The notice for a version written by a push or a library install. Null for anything else. */
export function sourceNotice(source: TemplateSource | null | undefined) {
  if (source?.kind === "react-email") {
    return `Pushed from ${source.path ?? "a React Email file"}. Changes made here are overwritten by the next push.`;
  }
  if (source?.kind === "library") {
    return `Installed from the template library${source.slug ? ` (${source.slug})` : ""}. Changes made here are overwritten if it is installed again.`;
  }
  return null;
}

/** A short name for where a version came from, for the history table. */
export function sourceLabel(source: TemplateSource | null | undefined) {
  if (source?.kind === "react-email") return source.path ?? "React Email";
  if (source?.kind === "library") return "Library";
  return "Dashboard or API";
}

/** The live version: the one `published_version_id` names. */
export function liveVersion(template: Pick<Template, "published_version_id">, versions: TemplateVersion[]) {
  if (!template.published_version_id) return undefined;
  return versions.find((version) => version.id === template.published_version_id);
}

/** Body for `POST /templates/:id/versions` that copies a version's content into a new draft. */
export function versionBody(version: TemplateVersion) {
  const body: Record<string, unknown> = { variables: normalizeVariables(version.variables) };
  if (version.subject) body.subject = version.subject;
  if (version.html) body.html = version.html;
  if (version.text) body.text = version.text;
  if (version.from) body.from = version.from;
  if (version.reply_to?.length) body.reply_to = version.reply_to;
  return body;
}

/** Version history with publish, restore, and preview. Used on the detail page and in the editor's drawer. */
export function Versions({ template, onChange }: { template: Template; onChange: (template: Template) => void }) {
  const client = useClient();
  const brand = useBrand();
  const versions = useResource<List<TemplateVersion>>(`/templates/${template.id}/versions`);
  const [viewing, setViewing] = useState<TemplateVersion | null>(null);
  const rows = versions.data?.data ?? [];
  const live = liveVersion(template, rows);

  const publish = useMutation((version: TemplateVersion) => client.post<Template>(`/templates/${template.id}/publish`, { version_id: version.id }), {
    success: "Version published.",
    onSuccess: (next) => {
      onChange(next);
      void versions.reload();
    },
  });
  const restore = useMutation((version: TemplateVersion) => client.post<Template>(`/templates/${template.id}/versions`, versionBody(version)), {
    success: "Draft created from that version.",
    onSuccess: (next) => {
      onChange(next);
      void versions.reload();
    },
  });

  return (
    <>
      <Table
        compact
        rows={rows}
        loading={versions.loading}
        error={versions.error}
        onRetry={() => void versions.reload()}
        empty={<p className="muted">No versions yet.</p>}
        columns={[
          { header: "Version", cell: (row) => <span className="mono">{row.id}</span> },
          {
            header: "State",
            cell: (row) =>
              row.id === live?.id ? (
                <Badge value="published" label="Live" />
              ) : row.id === template.current_version_id && template.has_unpublished_versions ? (
                <Badge value="draft" label="Draft" />
              ) : row.published_at ? (
                <Badge value="sent" label="Published before" />
              ) : (
                <span className="dim">Not published</span>
              ),
          },
          { header: "Subject", cell: (row) => <span className="truncate">{row.subject ?? ""}</span> },
          { header: "Source", cell: (row) => <span className="dim">{sourceLabel(row.source)}</span> },
          { header: "Created", cell: (row) => <Time value={row.created_at} /> },
        ]}
        menu={(row) => (
          <Menu
            items={[
              { label: "Preview", read: true, onSelect: () => setViewing(row) },
              { label: "Publish this version", hidden: row.id === live?.id, disabled: publish.isLoading, onSelect: () => void publish.mutate(row) },
              { label: "Restore as draft", hidden: row.id === template.current_version_id, disabled: restore.isLoading, onSelect: () => void restore.mutate(row) },
            ]}
          />
        )}
      />
      {viewing ? (
        <Drawer isOpen width="wide" label="Version" title={viewing.subject ?? viewing.id} onClose={() => setViewing(null)}>
          {sourceNotice(viewing.source) ? (
            <div className="notice" role="note">
              <Info size={16} aria-hidden />
              <span>{sourceNotice(viewing.source)}</span>
            </div>
          ) : null}
          <Preview html={fill(viewing, { ...brand, ...samples(normalizeVariables(viewing.variables)) }, normalizeVariables(viewing.variables)).html} />
        </Drawer>
      ) : null}
    </>
  );
}
