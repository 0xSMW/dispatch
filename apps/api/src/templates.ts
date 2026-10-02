import type { TemplateRecord } from "@dispatchmail/db";

export function presentTemplate(row: TemplateRecord) {
  return {
    object: "template" as const,
    id: row.id,
    name: row.name,
    alias: row.alias ?? null,
    from: row.from_address ?? null,
    reply_to: row.reply_to ?? [],
    subject: row.subject ?? null,
    html: row.html ?? null,
    text: row.text ?? null,
    variables: row.variables ?? [],
    status: row.status,
    published_at: row.published_at ?? null,
    published_version_id: row.published_version_id ?? null,
    current_version_id: row.current_version_id ?? null,
    has_unpublished_versions: Boolean(row.has_unpublished_versions),
    track: row.track ?? true,
    source: row.source && Object.keys(row.source).length > 0 ? row.source : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function presentVersion(row: {
  id: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  variables: unknown[] | null;
  from_address: string | null;
  reply_to: string[] | null;
  source?: Record<string, unknown> | null;
  created_at: string | Date;
  published_at: string | Date | null;
}) {
  return {
    id: row.id,
    from: row.from_address ?? null,
    reply_to: row.reply_to ?? [],
    subject: row.subject ?? null,
    html: row.html ?? null,
    text: row.text ?? null,
    variables: row.variables ?? [],
    source: row.source && Object.keys(row.source).length > 0 ? row.source : null,
    created_at: row.created_at,
    published_at: row.published_at ?? null,
  };
}

export function templateContentChanged(input: object) {
  return ["from", "reply_to", "subject", "html", "text", "variables", "source"].some((key) => key in input && (input as Record<string, unknown>)[key] !== undefined);
}
