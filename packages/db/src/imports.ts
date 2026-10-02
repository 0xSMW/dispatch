import { ApiError, id, type ImportColumnMap } from "@dispatchmail/core";
import { tx, type Db, type Queryable } from "./index.js";

export type ImportCounts = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
};

export type ImportStatus = "queued" | "in_progress" | "completed" | "failed";

export type ImportRow = {
  id: string;
  tenant_id: string;
  status: ImportStatus;
  storage_key: string;
  column_map: ImportColumnMap;
  on_conflict: "upsert" | "skip";
  segments: Array<{ id: string }>;
  topics: Array<{ id: string; subscription: string }>;
  counts: ImportCounts;
  // Data rows already committed. Above zero only when an earlier worker stopped part way.
  row_offset?: number;
  error: string | null;
  created_at: string | Date;
  completed_at: string | Date | null;
};

export type ImportContact = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  properties: Record<string, unknown>;
  unsubscribed: boolean;
};

export const importColumns = "id, status, counts, error, created_at, completed_at";

const workColumns =
  "id, tenant_id, status, storage_key, column_map, on_conflict, segments, topics, counts, row_offset, error, created_at, completed_at";

export function emptyCounts(): ImportCounts {
  return { total: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
}

export function presentImport(row: Pick<ImportRow, "id" | "status" | "counts" | "error" | "created_at" | "completed_at">) {
  return {
    object: "contact_import" as const,
    id: row.id,
    status: row.status,
    counts: { ...emptyCounts(), ...(row.counts ?? {}) },
    error: row.error ?? null,
    created_at: row.created_at,
    completed_at: row.completed_at ?? null,
  };
}

export function importKey(tenantId: string, importId: string) {
  return `imports/${tenantId}/${importId}`;
}

export async function createImport(
  db: Queryable,
  input: {
    id: string;
    tenantId: string;
    storageKey: string;
    columnMap: ImportColumnMap;
    onConflict: "upsert" | "skip";
    segments: Array<{ id: string }>;
    topics: Array<{ id: string; subscription: string }>;
  },
) {
  const row = await db.query<ImportRow>(
    `insert into contact_imports (id, tenant_id, storage_key, column_map, on_conflict, segments, topics)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${importColumns}`,
    [
      input.id,
      input.tenantId,
      input.storageKey,
      JSON.stringify(input.columnMap),
      input.onConflict,
      JSON.stringify(input.segments),
      JSON.stringify(input.topics),
    ],
  );
  return row.rows[0];
}

export async function findImport(db: Queryable, tenantId: string, importId: string) {
  const row = await db.query<ImportRow>(
    `select ${importColumns} from contact_imports where tenant_id = $1 and id = $2`,
    [tenantId, importId],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Contact import not found");
  return row.rows[0];
}

export async function assertImportRefs(
  db: Queryable,
  tenantId: string,
  segments: Array<{ id: string }>,
  topics: Array<{ id: string }>,
) {
  const segmentIds = [...new Set(segments.map((segment) => segment.id))];
  const topicIds = [...new Set(topics.map((topic) => topic.id))];
  if (segmentIds.length === 0 && topicIds.length === 0) return;
  const row = await db.query<{ segments: number; topics: number }>(
    `select
       (select count(*) from segments where tenant_id = $1 and id = any($2::text[]) and deleted_at is null)::integer as segments,
       (select count(*) from topics where tenant_id = $1 and id = any($3::text[]) and deleted_at is null)::integer as topics`,
    [tenantId, segmentIds, topicIds],
  );
  if ((row.rows[0]?.segments ?? 0) !== segmentIds.length) throw new ApiError("not_found", 404, "Segment not found");
  if ((row.rows[0]?.topics ?? 0) !== topicIds.length) throw new ApiError("not_found", 404, "Topic not found");
}

// An import whose worker stopped stays in_progress. Each batch refreshes locked_at, so a lock
// older than ten minutes means nobody is working on it and it is run again. Rows are upserts,
// so a second pass over the same file is safe.
export async function claimImports(db: Db, limit: number) {
  return tx(db, async (client) => {
    const rows = await client.query<ImportRow>(
      `select ${workColumns}
       from contact_imports
       where status = 'queued'
          or (status = 'in_progress' and locked_at < now() - interval '10 minutes')
       order by created_at, id
       limit $1
       for update skip locked`,
      [limit],
    );
    if (!rows.rows.length) return [];
    await client.query(
      "update contact_imports set status = 'in_progress', locked_at = now() where id = any($1::text[])",
      [rows.rows.map((row) => row.id)],
    );
    return rows.rows.map((row) => ({ ...row, status: "in_progress" as const }));
  });
}

// Postgres rejects an upsert that touches the same row twice, so the last row for an email wins.
export function dedupeByEmail(contacts: ImportContact[]) {
  const byEmail = new Map<string, ImportContact>();
  for (const contact of contacts) {
    byEmail.delete(contact.email);
    byEmail.set(contact.email, contact);
  }
  return { rows: [...byEmail.values()], dropped: contacts.length - byEmail.size };
}

export async function importBatch(
  client: Queryable,
  job: Pick<ImportRow, "tenant_id" | "on_conflict" | "segments" | "topics">,
  contacts: ImportContact[],
) {
  if (contacts.length === 0) return { created: 0, updated: 0, skipped: 0, ids: [] as string[] };
  // A deleted contact is treated as new in both modes: it comes back with the file's values and
  // none of its old ones. A global unsubscribe is never cleared by an import.
  const conflict =
    job.on_conflict === "skip"
      ? `do update set
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       properties = excluded.properties,
       unsubscribed_at = coalesce(contacts.unsubscribed_at, excluded.unsubscribed_at),
       deleted_at = null,
       updated_at = now()
       where contacts.deleted_at is not null`
      : `do update set
       first_name = case when contacts.deleted_at is not null then excluded.first_name else coalesce(excluded.first_name, contacts.first_name) end,
       last_name = case when contacts.deleted_at is not null then excluded.last_name else coalesce(excluded.last_name, contacts.last_name) end,
       properties = case when contacts.deleted_at is not null then excluded.properties else contacts.properties || excluded.properties end,
       unsubscribed_at = coalesce(contacts.unsubscribed_at, excluded.unsubscribed_at),
       deleted_at = null,
       updated_at = now()`;
  const result = await client.query<{ id: string; created: boolean }>(
    `insert into contacts (id, tenant_id, email, first_name, last_name, properties, unsubscribed_at)
     select t.id, $2, t.email, t.first_name, t.last_name, t.properties, case when t.unsubscribed then now() end
     from unnest($1::text[], $3::text[], $4::text[], $5::text[], $6::jsonb[], $7::boolean[])
       as t(id, email, first_name, last_name, properties, unsubscribed)
     on conflict (tenant_id, email) ${conflict}
     returning id, (xmax = 0) as created`,
    [
      contacts.map(() => id("contact")),
      job.tenant_id,
      contacts.map((contact) => contact.email),
      contacts.map((contact) => contact.first_name),
      contacts.map((contact) => contact.last_name),
      contacts.map((contact) => JSON.stringify(contact.properties)),
      contacts.map((contact) => contact.unsubscribed),
    ],
  );
  const created = result.rows.filter((row) => row.created).length;
  const updated = result.rows.length - created;
  const skipped = contacts.length - result.rows.length;
  const ids = result.rows.map((row) => row.id);
  await joinSegments(client, job, ids);
  await joinTopics(client, job, ids);
  return { created, updated, skipped, ids };
}

async function joinSegments(client: Queryable, job: Pick<ImportRow, "tenant_id" | "segments">, contactIds: string[]) {
  const pairs = contactIds.flatMap((contactId) => (job.segments ?? []).map((segment) => [segment.id, contactId]));
  if (pairs.length === 0) return;
  await client.query(
    `insert into segment_contacts (id, tenant_id, segment_id, contact_id)
     select t.id, $2, t.segment_id, t.contact_id
     from unnest($1::text[], $3::text[], $4::text[]) as t(id, segment_id, contact_id)
     where exists (select 1 from segments s where s.tenant_id = $2 and s.id = t.segment_id and s.deleted_at is null)
     on conflict (tenant_id, segment_id, contact_id) do nothing`,
    [pairs.map(() => id("member")), job.tenant_id, pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])],
  );
}

async function joinTopics(client: Queryable, job: Pick<ImportRow, "tenant_id" | "topics">, contactIds: string[]) {
  const rows = contactIds.flatMap((contactId) =>
    (job.topics ?? []).map((topic) => ({
      topic: topic.id,
      contact: contactId,
      status: topic.subscription === "opt_out" || topic.subscription === "unsubscribed" ? "unsubscribed" : "subscribed",
    })),
  );
  if (rows.length === 0) return;
  await client.query(
    `insert into topic_subscriptions (id, tenant_id, topic_id, contact_id, status)
     select t.id, $2, t.topic_id, t.contact_id, t.status
     from unnest($1::text[], $3::text[], $4::text[], $5::text[]) as t(id, topic_id, contact_id, status)
     where exists (select 1 from topics x where x.tenant_id = $2 and x.id = t.topic_id and x.deleted_at is null)
     on conflict (tenant_id, topic_id, contact_id) do update set status = excluded.status, updated_at = now()
     -- An import can record an opt-out. It never turns one back into an opt-in.
     where not (topic_subscriptions.status = 'unsubscribed' and excluded.status = 'subscribed')`,
    [
      rows.map(() => id("sub")),
      job.tenant_id,
      rows.map((row) => row.topic),
      rows.map((row) => row.contact),
      rows.map((row) => row.status),
    ],
  );
}

// `offset` is how many data rows are committed, written with the batch that committed them.
export async function saveImportCounts(db: Queryable, importId: string, counts: ImportCounts, offset = 0) {
  await db.query("update contact_imports set counts = $2, row_offset = $3, locked_at = now() where id = $1", [importId, JSON.stringify(counts), offset]);
}

export async function finishImport(
  db: Queryable,
  importId: string,
  status: "completed" | "failed",
  counts: ImportCounts,
  error: string | null = null,
) {
  await db.query(
    `update contact_imports
     set status = $2, counts = $3, error = $4, completed_at = now(), locked_at = null
     where id = $1`,
    [importId, status, JSON.stringify(counts), error],
  );
}
