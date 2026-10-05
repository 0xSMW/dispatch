import type { LibraryUpdates } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { addTemplateVersion, type LibraryInstallEntry } from "./templates.js";

type Installed = {
  id: string;
  name: string;
  alias: string | null;
  published_version_id: string | null;
  library_slug: string | null;
};
type Latest = {
  id: string;
  source: Record<string, unknown> | null;
  variables: unknown[] | null;
  from_address: string | null;
  reply_to: string[] | null;
  html: string | null;
  text: string | null;
};

function variableKey(variable: unknown) {
  if (typeof variable === "string") return variable;
  return variable && typeof variable === "object" && "key" in variable ? variable.key : undefined;
}

// The caller owns the transaction. Locks stay held through version creation and publication.
// Never use installLibrary here: it can create missing templates and replace sending settings.
export async function updateLibraryTemplates(
  db: Queryable,
  tenantId: string,
  entries: LibraryInstallEntry[],
  version = "1.0.0",
): Promise<LibraryUpdates> {
  const result: LibraryUpdates = { updated: [], skipped: [] };
  if (!entries.length) return result;
  const catalog = new Map(entries.map((entry) => [entry.slug, entry]));
  const slugs = [...catalog.keys()];
  const installed = await db.query<Installed>(
    `select t.id, t.name, t.alias, t.published_version_id,
       (select v.source->>'slug' from template_versions v
        where v.tenant_id = $1 and v.template_id = t.id
          and v.source->>'kind' = 'library' and v.source->>'slug' = any($2::text[])
        order by v.created_at desc, v.id desc limit 1) as library_slug
     from templates t
     where t.tenant_id = $1 and t.deleted_at is null
       and (t.alias = any($2::text[]) or exists (
         select 1 from template_versions v where v.tenant_id = $1 and v.template_id = t.id
           and v.source->>'kind' = 'library' and v.source->>'slug' = any($2::text[])
       ))
     order by t.id
     for update of t`,
    [tenantId, slugs],
  );
  for (const template of installed.rows) {
    const latest = (await db.query<Latest>(
      `select v.id, v.source, v.variables, v.from_address, v.reply_to, v.html, v.text
       from template_versions v
       where v.tenant_id = $1 and v.template_id = $2
       order by v.created_at desc, v.id desc
       limit 1 for update of v`,
      [tenantId, template.id],
    )).rows[0];
    const sourceSlug = typeof latest?.source?.slug === "string" ? latest.source.slug : null;
    const slug = sourceSlug && catalog.has(sourceSlug) ? sourceSlug : template.library_slug ?? template.alias ?? "";
    const identity = { id: template.id, name: template.name, slug };
    const entry = catalog.get(slug);
    if (!latest || latest.source?.kind !== "library" || sourceSlug !== slug || !entry) {
      result.skipped.push({ ...identity, reason: !latest ? "No template version" : "Latest version is custom or no longer matches the library" });
      continue;
    }
    const variables = latest.variables ?? [];
    const keys = new Set(variables.map(variableKey));
    // Existing names, types and fallback values belong to the tenant; append only new declarations.
    const merged = [...variables, ...(entry.variables ?? []).filter((variable) => !keys.has(variableKey(variable)))];
    const marketing = latest.source.send_kind === "marketing" || entry.kind === "marketing"
      || /\{\{\{?\s*UNSUBSCRIBE_URL\b/.test(`${latest.html ?? ""}\n${latest.text ?? ""}`);
    const sendKind = marketing ? "marketing" : latest.source.send_kind ?? entry.kind;
    await addTemplateVersion(db, tenantId, template.id, {
      name: template.name,
      subject: entry.subject,
      html: entry.html,
      text: entry.text,
      variables: merged,
      from: latest.from_address,
      reply_to: latest.reply_to,
      // Leave track untouched. An unpublished latest library version remains a draft.
      publish: template.published_version_id === latest.id,
      source: { ...latest.source, kind: "library", slug, version, ...(sendKind ? { send_kind: sendKind } : {}) },
    });
    result.updated.push(identity);
  }
  return result;
}
