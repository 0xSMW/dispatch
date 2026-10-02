import { ApiError, assertBlocks, id } from "@dispatchmail/core";
import type { Queryable } from "./index.js";

export type TemplateWrite = {
  name: string;
  alias?: string | null;
  from?: string | null;
  reply_to?: string[] | null;
  subject?: string | null;
  html?: string | null;
  text?: string | null;
  variables?: unknown[];
  publish?: boolean;
  track?: boolean;
  source?: Record<string, unknown> | null;
};

export type TemplateRecord = {
  id: string;
  name: string;
  alias: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  status: "draft" | "published";
  published_at: string | Date | null;
  published_version_id?: string | null;
  current_version_id: string | null;
  has_unpublished_versions: boolean;
  subject: string | null;
  html: string | null;
  text: string | null;
  variables: unknown[] | null;
  from_address: string | null;
  reply_to: string[] | null;
  track?: boolean | null;
  source?: Record<string, unknown> | null;
};

export const templateFrom = `templates t
  left join template_versions pv on pv.id = t.published_version_id
  left join lateral (
    select id, subject, html, text, variables, from_address, reply_to, source
    from template_versions v
    where v.template_id = t.id
    order by v.created_at desc, v.id desc
    limit 1
  ) latest on true`;

export const templateSelect = `t.id, t.name, t.alias, t.created_at, t.updated_at,
  case when t.published_version_id is null then 'draft' else 'published' end as status,
  pv.published_at,
  t.published_version_id,
  latest.id as current_version_id,
  (latest.id is distinct from t.published_version_id) as has_unpublished_versions,
  latest.subject, latest.html, latest.text, latest.variables, latest.from_address, latest.reply_to,
  t.track, latest.source`;

export async function templateDetail(db: Queryable, tenantId: string, idOrAlias: string) {
  const row = await db.query<TemplateRecord>(
    `select ${templateSelect}
     from ${templateFrom}
     where t.tenant_id = $1 and (t.id = $2 or t.alias = $2) and t.deleted_at is null
     limit 1`,
    [tenantId, idOrAlias],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Template not found");
  return row.rows[0];
}

export async function createTemplate(db: Queryable, tenantId: string, input: TemplateWrite) {
  if (input.publish) assertBlocks(input);
  const templateId = id("template");
  const versionId = id("version");
  await db.query(
    `insert into templates (id, tenant_id, name, alias, track) values ($1, $2, $3, $4, $5)`,
    [templateId, tenantId, input.name, input.alias ?? null, input.track ?? true],
  );
  await insertVersion(db, tenantId, templateId, versionId, input, Boolean(input.publish));
  if (input.publish) await markPublished(db, tenantId, templateId, versionId);
  return templateDetail(db, tenantId, templateId);
}

// `reuseDraft` writes over the latest version when it has never been published. An editor that
// saves as the user types would otherwise add a version to the history every few seconds.
export async function addTemplateVersion(
  db: Queryable,
  tenantId: string,
  templateId: string,
  input: TemplateWrite,
  options: { reuseDraft?: boolean } = {},
) {
  if (input.publish) assertBlocks(input);
  const draft = options.reuseDraft ? await unpublishedDraft(db, tenantId, templateId) : null;
  const versionId = draft ?? id("version");
  if (draft) await overwriteVersion(db, tenantId, draft, input, Boolean(input.publish));
  else await insertVersion(db, tenantId, templateId, versionId, input, Boolean(input.publish));
  if (input.publish) await markPublished(db, tenantId, templateId, versionId);
  if (input.track !== undefined) {
    await db.query("update templates set track = $3, updated_at = now() where tenant_id = $1 and id = $2", [tenantId, templateId, input.track]);
  }
  return templateDetail(db, tenantId, templateId);
}

export async function publishTemplate(db: Queryable, tenantId: string, idOrAlias: string, versionId?: string | null) {
  const template = await templateDetail(db, tenantId, idOrAlias);
  const version = await db.query<{ id: string; subject: string | null; html: string | null; text: string | null }>(
    `select id, subject, html, text from template_versions
     where tenant_id = $1 and template_id = $2 and ($3::text is null or id = $3)
     order by created_at desc, id desc
     limit 1`,
    [tenantId, template.id, versionId ?? null],
  );
  if (!version.rows[0]) throw new ApiError("not_found", 404, "Template version not found");
  assertBlocks(version.rows[0]);
  // The time of this publish, also when an earlier version is published again.
  await db.query(
    "update template_versions set published_at = now() where tenant_id = $1 and id = $2",
    [tenantId, version.rows[0].id],
  );
  await markPublished(db, tenantId, template.id, version.rows[0].id);
  return templateDetail(db, tenantId, template.id);
}

export async function updateTemplateMeta(
  db: Queryable,
  tenantId: string,
  templateId: string,
  input: { name?: string; alias?: string | null },
) {
  await db.query(
    `update templates
     set name = coalesce($3, name),
         alias = case when $4::boolean then $5 else alias end,
         updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null`,
    [tenantId, templateId, input.name ?? null, input.alias !== undefined, input.alias ?? null],
  );
}

export type LibraryInstallEntry = {
  slug: string;
  name: string;
  subject: string;
  html: string;
  text?: string | null;
  track?: boolean;
  variables?: unknown[];
};

export async function installLibrary(db: Queryable, tenantId: string, entries: LibraryInstallEntry[], version = "1.0.0") {
  for (const entry of entries) {
    const existing = await db.query<{ id: string; source: { kind?: string } | null }>(
      `select t.id, latest.source
       from templates t
       left join lateral (
         select source from template_versions v
         where v.template_id = t.id
         order by v.created_at desc, v.id desc
         limit 1
       ) latest on true
       where t.tenant_id = $1 and t.alias = $2 and t.deleted_at is null
       limit 1`,
      [tenantId, entry.slug],
    );
    const row = existing.rows[0];
    if (row && row.source?.kind !== "library") {
      throw new ApiError("conflict", 409, `Template ${entry.slug} already exists`);
    }
    const write: TemplateWrite = {
      name: entry.name,
      alias: entry.slug,
      subject: entry.subject,
      html: entry.html,
      text: entry.text,
      variables: entry.variables ?? [],
      track: entry.track ?? true,
      publish: true,
      source: { kind: "library", slug: entry.slug, version },
    };
    if (!row) await createTemplate(db, tenantId, write);
    else await addTemplateVersion(db, tenantId, row.id, write);
  }
}

export async function listTemplateVersions(db: Queryable, tenantId: string, templateId: string) {
  const rows = await db.query(
    `select id, subject, html, text, variables, from_address, reply_to, source, created_at, published_at
     from template_versions
     where tenant_id = $1 and template_id = $2
     order by created_at desc, id desc`,
    [tenantId, templateId],
  );
  return rows.rows;
}

async function insertVersion(
  db: Queryable,
  tenantId: string,
  templateId: string,
  versionId: string,
  input: TemplateWrite,
  publish: boolean,
) {
  await db.query(
    `insert into template_versions
       (id, tenant_id, template_id, subject, html, text, variables, from_address, reply_to, source, published_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${publish ? "now()" : "null"})`,
    [
      versionId,
      tenantId,
      templateId,
      input.subject ?? null,
      input.html ?? null,
      input.text ?? null,
      JSON.stringify(input.variables ?? []),
      input.from ?? null,
      JSON.stringify(input.reply_to ?? []),
      JSON.stringify(input.source ?? {}),
    ],
  );
}

async function unpublishedDraft(db: Queryable, tenantId: string, templateId: string) {
  const latest = await db.query<{ id: string; published_at: string | null; live: boolean }>(
    `select v.id, v.published_at, (v.id = t.published_version_id) as live
     from template_versions v
     join templates t on t.id = v.template_id and t.tenant_id = v.tenant_id
     where v.tenant_id = $1 and v.template_id = $2
     order by v.created_at desc, v.id desc
     limit 1`,
    [tenantId, templateId],
  );
  const row = latest.rows[0];
  return row && row.published_at === null && !row.live ? row.id : null;
}

async function overwriteVersion(db: Queryable, tenantId: string, versionId: string, input: TemplateWrite, publish: boolean) {
  await db.query(
    `update template_versions
     set subject = $3, html = $4, text = $5, variables = $6, from_address = $7, reply_to = $8, source = $9,
       published_at = ${publish ? "now()" : "null"}
     where tenant_id = $1 and id = $2`,
    [
      tenantId,
      versionId,
      input.subject ?? null,
      input.html ?? null,
      input.text ?? null,
      JSON.stringify(input.variables ?? []),
      input.from ?? null,
      JSON.stringify(input.reply_to ?? []),
      JSON.stringify(input.source ?? {}),
    ],
  );
}

async function markPublished(db: Queryable, tenantId: string, templateId: string, versionId: string) {
  await db.query(
    "update templates set published_version_id = $3, updated_at = now() where tenant_id = $1 and id = $2",
    [tenantId, templateId, versionId],
  );
}
