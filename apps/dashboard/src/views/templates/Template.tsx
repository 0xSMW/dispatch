import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, FileText, Info } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Code } from "../../components/Code";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Failed } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { Switch } from "../../components/Field";
import { Menu } from "../../components/Menu";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { Template as TemplateRow } from "../../types";
import { Preview } from "./editor";
import { builtIn, fill, normalizeVariables, scan, type Variable } from "./render";
import { Rename } from "./Templates";
import { samples, sourceNotice, useBrand, Versions } from "./Versions";

type Row = Variable & { used: boolean; declared: boolean; inline: boolean };

/** Declared variables plus any the content uses without declaring. */
export function variableRows(template: Pick<TemplateRow, "subject" | "html" | "text" | "variables">): Row[] {
  const declared = normalizeVariables(template.variables);
  const found = scan(template.subject, template.html, template.text).filter((item) => !builtIn(item.key));
  const rows: Row[] = declared.map((item) => {
    const use = found.find((entry) => entry.key === item.key);
    return { ...item, declared: true, used: Boolean(use), inline: Boolean(use?.inline) };
  });
  for (const item of found) {
    if (!rows.some((row) => row.key === item.key)) {
      rows.push({ key: item.key, type: item.type, fallback_value: null, declared: false, used: true, inline: item.inline });
    }
  }
  return rows;
}

export function Template() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const can = useCan();
  const navigate = useNavigate();
  const template = useResource<TemplateRow>(`/templates/${id}`);
  const brand = useBrand();
  const [view, setView] = useState<"preview" | "text" | "html">("preview");
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const publish = useMutation(() => client.post<TemplateRow>(`/templates/${id}/publish`, {}), {
    success: "Template published.",
    onSuccess: (next) => template.setData(next),
  });
  const track = useMutation((on: boolean) => client.patch<TemplateRow>(`/templates/${id}`, { track: on }), {
    success: (next) => (next.track === false ? "Tracking turned off." : "Tracking turned on."),
    onSuccess: (next) => template.setData(next),
  });
  const duplicate = useMutation(() => client.post<TemplateRow>(`/templates/${id}/duplicate`), {
    success: "Template duplicated.",
    onSuccess: (copy) => navigate(`/templates/${copy.id}`),
  });

  const row = template.data;
  const variables = useMemo(() => (row ? variableRows(row) : []), [row]);
  const preview = useMemo(
    () => (row ? fill(row, { ...brand, ...samples(variables) }, normalizeVariables(row.variables)) : null),
    [row, brand, variables],
  );

  if (template.error) return <Failed message={template.error} onRetry={template.reload} />;
  const notice = sourceNotice(row?.source);
  const canPublish = row ? row.status === "draft" || row.has_unpublished_versions : false;

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/templates", label: "Templates" }}
        icon={<FileText size={20} />}
        tone={row?.status === "published" ? "success" : "neutral"}
        label="Template"
        title={row ? row.name : <Skeleton width="medium" />}
        actions={
          row ? (
            <>
              {canPublish && can ? (
                <button type="button" className="secondary" disabled={publish.isLoading} onClick={() => void publish.mutate()}>
                  Publish
                </button>
              ) : null}
              <Link className="button" to={`/templates/${row.id}/editor`}>
                {can ? "Edit" : "View source"}
              </Link>
              {can ? (
                <Menu
                  items={[
                    { label: "Rename", onSelect: () => setRenaming(true) },
                    { label: "Duplicate", disabled: duplicate.isLoading, onSelect: () => void duplicate.mutate() },
                    "divider",
                    { label: "Delete template", danger: true, onSelect: () => setDeleting(true) },
                  ]}
                />
              ) : null}
            </>
          ) : null
        }
      />

      {notice ? (
        <div className="notice" role="note">
          <Info size={16} aria-hidden />
          <span>{notice}</span>
        </div>
      ) : null}

      {row ? (
        <Facts
          items={[
            { label: "Status", value: <Badge value={row.status} /> },
            { label: "Alias", value: row.alias, copy: Boolean(row.alias) },
            { label: "ID", value: row.id, copy: true },
            { label: "Published", value: row.published_at ? <Time value={row.published_at} mode="absolute" /> : null },
            { label: "Subject", value: row.subject },
            { label: "From", value: row.from },
            { label: "Reply-To", value: row.reply_to.join(", "), hidden: row.reply_to.length === 0 },
            { label: "Updated", value: <Time value={row.updated_at} mode="absolute" /> },
            {
              label: "Tracking",
              value: (
                <Switch
                  label={row.track === false ? "Off" : "Opens and clicks"}
                  checked={row.track !== false}
                  disabled={!can || track.isLoading}
                  onChange={(on) => void track.mutate(on)}
                />
              ),
            },
          ]}
        />
      ) : (
        <Skeleton lines={3} />
      )}

      {row?.has_unpublished_versions && row.status === "published" ? (
        <div className="notice warning" role="note">
          <AlertTriangle size={16} aria-hidden />
          <span>This template has unpublished changes. Sends use the published version until you publish.</span>
        </div>
      ) : null}

      <Panel title="Content">
        <Tabs
          label="Content"
          value={view}
          onChange={setView}
          tabs={[
            { id: "preview", label: "Preview" },
            { id: "text", label: "Plain text" },
            { id: "html", label: "HTML" },
          ]}
        />
        {!preview ? (
          <Skeleton lines={6} />
        ) : view === "preview" ? (
          <Preview html={preview.html} />
        ) : view === "text" ? (
          <Code value={row?.text ?? ""} language="text" empty={<p className="muted">No plain text version. The API generates one from the HTML at send time.</p>} />
        ) : (
          <Code value={row?.html ?? ""} language="html" empty={<p className="muted">No HTML.</p>} />
        )}
        {preview && view === "preview" ? <p className="dim">Shown with the brand settings, fallbacks, and stand-ins in brackets for required values.</p> : null}
      </Panel>

      <Panel title="Variables">
        <Table
          compact
          rows={variables}
          rowKey={(item) => item.key}
          loading={template.loading}
          empty={<p className="muted">This template has no variables.</p>}
          columns={[
            { header: "Key", cell: (item) => <span className="mono">{item.key}</span> },
            { header: "Type", cell: (item) => item.type },
            {
              header: "Fallback",
              cell: (item) =>
                item.fallback_value !== null ? (
                  item.fallback_value === "" ? <span className="dim">Empty</span> : <span className="mono">{String(item.fallback_value)}</span>
                ) : item.inline ? (
                  <span className="dim">Inline fallback</span>
                ) : (
                  <span className="warnMark">
                    <AlertTriangle size={13} aria-hidden /> None, required
                  </span>
                ),
            },
            {
              header: "Use",
              cell: (item) => (!item.declared ? <Badge value="pending" label="Not declared" /> : !item.used ? <span className="dim">Not used</span> : <span className="dim">Used</span>),
            },
          ]}
        />
      </Panel>

      <Panel title="Versions">{row ? <Versions key={`${row.current_version_id}-${row.published_at}`} template={row} onChange={template.setData} /> : <Skeleton lines={3} />}</Panel>

      {renaming && row ? <Rename template={row} onClose={() => setRenaming(false)} onDone={template.setData} /> : null}

      {deleting && row ? (
        <ConfirmPhrase
          title="Delete template"
          body={`Sends that use ${row.alias ?? row.name} will fail.`}
          phrase={row.name}
          action="Delete template"
          onConfirm={() => client.delete(`/templates/${row.id}`)}
          onClose={() => setDeleting(false)}
          onDone={() => {
            toast.success("Template deleted.");
            navigate("/templates");
          }}
        />
      ) : null}
    </div>
  );
}
