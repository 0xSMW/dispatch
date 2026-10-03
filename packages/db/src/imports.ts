import { ApiError, id, type ImportColumnMap } from "@dispatchmail/core";
import { tx, type Db, type Queryable } from "./index.js";
import { contactColumns, type ContactRow } from "./audience.js";
import { settings } from "./settings.js";
import { contactDiff, fireContactTrigger, recordContactChanges } from "./contact-triggers.js";

export type ImportCounts = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
};

export type ImportStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled";

export type ImportRow = {
  id: string;
  tenant_id: string;
  status: ImportStatus;
  storage_key: string;
  column_map: ImportColumnMap;
  on_conflict: "upsert" | "skip";
  segments: Array<{ id: string }>;
  topics: Array<{ id: string; subscription: string }>;
  trigger_automations?: boolean;
  counts: ImportCounts;
  // Data rows already committed. Above zero only when an earlier worker stopped part way.
  row_offset?: number;
  locked_at?: string | Date | null;
  claim_version?: number;
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

export const importColumns = "id, status, trigger_automations, counts, error, created_at, completed_at";

const workColumns =
  "id, tenant_id, status, storage_key, column_map, on_conflict, segments, topics, trigger_automations, counts, row_offset, locked_at, claim_version, error, created_at, completed_at";

export function emptyCounts(): ImportCounts {
  return { total: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
}

export function presentImport(row: Pick<ImportRow, "id" | "status" | "counts" | "error" | "created_at" | "completed_at" | "trigger_automations">) {
  return {
    object: "contact_import" as const,
    id: row.id,
    status: row.status,
    trigger_automations: row.trigger_automations ?? false,
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
    triggerAutomations?: boolean;
  },
) {
  const triggerAutomations = input.triggerAutomations ?? (await settings(db, input.tenantId)).import_trigger_automations;
  const row = await db.query<ImportRow>(
    `insert into contact_imports (id, tenant_id, storage_key, column_map, on_conflict, segments, topics, trigger_automations)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${importColumns}`,
    [
      input.id,
      input.tenantId,
      input.storageKey,
      JSON.stringify(input.columnMap),
      input.onConflict,
      JSON.stringify(input.segments),
      JSON.stringify(input.topics),
      triggerAutomations,
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

export async function cancelImport(db: Queryable, tenantId: string, importId: string) {
  await db.query(
    `update contact_imports set status = 'cancelled', locked_at = null, completed_at = now()
     where tenant_id = $1 and id = $2 and status in ('queued', 'in_progress')`,
    [tenantId, importId],
  );
  return findImport(db, tenantId, importId);
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
       (select count(*) from segments s where tenant_id = $1 and id = any($2::text[]) and deleted_at is null
         and to_jsonb(s)->>'rule' is null and coalesce(to_jsonb(s)->>'type', 'static') = 'static')::integer as segments,
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
    const claimed = await client.query<ImportRow>(
      `update contact_imports set status = 'in_progress', locked_at = clock_timestamp(), claim_version = claim_version + 1 where id = any($1::text[])
       returning ${workColumns}`,
      [rows.rows.map((row) => row.id)],
    );
    return claimed.rows;
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
  job: Pick<ImportRow, "tenant_id" | "on_conflict" | "segments" | "topics" | "trigger_automations"> & { id?: string },
  contacts: ImportContact[],
) {
  if (contacts.length === 0) return { created: 0, updated: 0, skipped: 0, ids: [] as string[], rows: [] as ImportChange[] };
  // A deleted contact is treated as new in both modes: it comes back with the file's values and
  // none of its old ones. A global unsubscribe is never cleared by an import.
  const inserted = await client.query<ContactRow>(
    `insert into contacts (id, tenant_id, email, first_name, last_name, properties, unsubscribed_at)
     select t.id, $2, t.email, t.first_name, t.last_name, t.properties, case when t.unsubscribed then now() end
     from unnest($1::text[], $3::text[], $4::text[], $5::text[], $6::jsonb[], $7::boolean[])
       as t(id, email, first_name, last_name, properties, unsubscribed)
     order by t.email
     on conflict do nothing
     returning ${contactColumns}`,
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
  // Re-read after insert conflicts, so even an initially absent concurrent insert has a
  // locked, accurate prior row. Revival is not inferred from Postgres's xmax.
  const insertedEmails = new Set(inserted.rows.map((row) => row.email));
  const remaining = contacts.filter((row) => !insertedEmails.has(row.email));
  const prior = remaining.length ? await client.query<ContactRow & { deleted_at: string | null }>(
    `select ${contactColumns}, deleted_at from contacts where tenant_id = $1 and email = any($2::text[])
     order by email for update`, [job.tenant_id, remaining.map((row) => row.email)]
  ) : { rows: [] };
  const before = new Map(prior.rows.map((row) => [row.email, row]));
  const updatedRows = remaining.length ? await client.query<ContactRow>(
    `update contacts c set
       first_name = case when c.deleted_at is not null then t.first_name else coalesce(t.first_name, c.first_name) end,
       last_name = case when c.deleted_at is not null then t.last_name else coalesce(t.last_name, c.last_name) end,
       properties = case when c.deleted_at is not null then t.properties else c.properties || t.properties end,
       unsubscribed_at = coalesce(c.unsubscribed_at, case when t.unsubscribed then now() end),
       deleted_at = null, updated_at = now()
     from unnest($2::text[], $3::text[], $4::text[], $5::jsonb[], $6::boolean[])
       as t(email, first_name, last_name, properties, unsubscribed)
     where c.tenant_id = $1 and c.email = t.email and ($7::boolean or c.deleted_at is not null)
     returning ${contactColumns.split(", ").map((column) => `c.${column}`).join(", ")}`,
    [job.tenant_id, remaining.map((row) => row.email), remaining.map((row) => row.first_name),
      remaining.map((row) => row.last_name), remaining.map((row) => JSON.stringify(row.properties)),
      remaining.map((row) => row.unsubscribed), job.on_conflict === "upsert"]
  ) : { rows: [] };
  const all = [...inserted.rows, ...updatedRows.rows];
  const ids = all.map((row) => row.id);
  const segments = await joinSegments(client, job, ids);
  const topics = await joinTopics(client, job, ids);
  const rows: ImportChange[] = all.map((contact) => ({
    id: contact.id, contact,
    created: insertedEmails.has(contact.email) || Boolean(before.get(contact.email)?.deleted_at),
    segments_added: segments.filter((row) => row.contact_id === contact.id).map((row) => row.segment_id),
    topics_subscribed: topics.filter((row) => row.contact_id === contact.id).map((row) => row.topic_id),
  }));
  for (const row of rows) {
    const requestId = job.id ?? id("req");
    await recordContactChanges(client, job.tenant_id, requestId, row.id, contactDiff(before.get(row.contact.email) ?? null, row.contact));
    for (const segmentId of row.segments_added) await recordContactChanges(client, job.tenant_id, requestId, row.id, [{ field: `segments.${segmentId}`, from: false, to: true }]);
    for (const topicId of row.topics_subscribed) await recordContactChanges(client, job.tenant_id, requestId, row.id, [{ field: `topics.${topicId}`, from: false, to: true }]);
    if (!job.trigger_automations) continue;
    const options = { contact: row.contact, priority: "bulk" as const };
    if (row.created) await fireContactTrigger(client, job.tenant_id, requestId, { ...options, triggerType: "contact_created", key: "@contact.created" });
    for (const topicId of row.topics_subscribed) await fireContactTrigger(client, job.tenant_id, requestId, { ...options, triggerType: "topic_subscribed", key: `@topic.subscribed:${topicId}` });
    for (const segmentId of row.segments_added) await fireContactTrigger(client, job.tenant_id, requestId, { ...options, triggerType: "segment_added", key: `@segment.added:${segmentId}` });
  }
  const created = rows.filter((row) => row.created).length;
  return { created, updated: rows.length - created, skipped: contacts.length - rows.length, ids, rows };
}

export type ImportChange = { id: string; contact: ContactRow; created: boolean; segments_added: string[]; topics_subscribed: string[] };

async function joinSegments(client: Queryable, job: Pick<ImportRow, "tenant_id" | "segments">, contactIds: string[]) {
  const segmentIds = [...new Set((job.segments ?? []).map((segment) => segment.id))];
  const pairs = contactIds.flatMap((contactId) => segmentIds.map((segmentId) => [segmentId, contactId]));
  if (pairs.length === 0) return [] as Array<{ contact_id: string; segment_id: string }>;
  const result = await client.query<{ contact_id: string; segment_id: string }>(
    `insert into segment_contacts (id, tenant_id, segment_id, contact_id)
     select t.id, $2, t.segment_id, t.contact_id
     from unnest($1::text[], $3::text[], $4::text[]) as t(id, segment_id, contact_id)
     where exists (select 1 from segments s where s.tenant_id = $2 and s.id = t.segment_id and s.deleted_at is null
       and to_jsonb(s)->>'rule' is null and coalesce(to_jsonb(s)->>'type', 'static') = 'static')
     on conflict (tenant_id, segment_id, contact_id) do nothing returning contact_id, segment_id`,
    [pairs.map(() => id("member")), job.tenant_id, pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])],
  );
  return result.rows;
}

async function joinTopics(client: Queryable, job: Pick<ImportRow, "tenant_id" | "topics">, contactIds: string[]) {
  const choices = [...new Map((job.topics ?? []).map((topic) => [topic.id, topic])).values()];
  const rows = contactIds.flatMap((contactId) =>
    choices.map((topic) => ({
      topic: topic.id,
      contact: contactId,
      status: topic.subscription === "opt_out" || topic.subscription === "unsubscribed" ? "unsubscribed" : "subscribed",
    })),
  );
  if (rows.length === 0) return [] as Array<{ contact_id: string; topic_id: string }>;
  const prior = await client.query<{ contact_id: string; topic_id: string; receiving: boolean; eligible: boolean }>(
    `select c.id as contact_id, t.id as topic_id,
       (c.unsubscribed_at is null and coalesce(s.status, t.default_status) = 'subscribed') as receiving,
       c.unsubscribed_at is null as eligible
     from contacts c cross join topics t
     left join topic_subscriptions s on s.tenant_id = $1 and s.contact_id = c.id and s.topic_id = t.id
     where c.tenant_id = $1 and c.id = any($2::text[]) and t.tenant_id = $1 and t.id = any($3::text[])`,
    [job.tenant_id, contactIds, choices.map((topic) => topic.id)]
  );
  const receiving = new Map(prior.rows.map((row) => [`${row.contact_id}:${row.topic_id}`, row.receiving]));
  const eligible = new Set(prior.rows.filter((row) => row.eligible).map((row) => row.contact_id));
  const result = await client.query<{ contact_id: string; topic_id: string; status: string }>(
    `insert into topic_subscriptions (id, tenant_id, topic_id, contact_id, status)
     select t.id, $2, t.topic_id, t.contact_id, t.status
     from unnest($1::text[], $3::text[], $4::text[], $5::text[]) as t(id, topic_id, contact_id, status)
     where exists (select 1 from topics x where x.tenant_id = $2 and x.id = t.topic_id and x.deleted_at is null)
     on conflict (tenant_id, topic_id, contact_id) do update set status = excluded.status, updated_at = now()
     -- An import can record an opt-out. It never turns one back into an opt-in.
     where not (topic_subscriptions.status = 'unsubscribed' and excluded.status = 'subscribed')
     returning contact_id, topic_id, status`,
    [
      rows.map(() => id("sub")),
      job.tenant_id,
      rows.map((row) => row.topic),
      rows.map((row) => row.contact),
      rows.map((row) => row.status),
    ],
  );
  return result.rows.filter((row) => row.status === "subscribed" && receiving.get(`${row.contact_id}:${row.topic_id}`) === false)
    .filter((row) => eligible.has(row.contact_id));
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
     where id = $1 and status = 'in_progress'`,
    [importId, status, JSON.stringify(counts), error],
  );
}
