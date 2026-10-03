import { ApiError, id, isIsoDate, type PropertyType } from "@dispatchmail/core";
import type { Queryable } from "./index.js";

export type ContactRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  properties: Record<string, unknown> | null;
  unsubscribed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PropertyDefinition = { key: string; type: string };

export const contactColumns =
  "id, email, first_name, last_name, properties, unsubscribed_at, created_at, updated_at";

export function subscriptionStored(value: string) {
  return value === "opt_out" || value === "unsubscribed" ? "unsubscribed" : "subscribed";
}

export function subscriptionWire(value: string): "opt_in" | "opt_out" {
  return subscriptionStored(value) === "unsubscribed" ? "opt_out" : "opt_in";
}

export function topicDefaultStatus(input: { default_subscription?: string; default_status?: string }) {
  if (input.default_status) return subscriptionStored(input.default_status);
  if (input.default_subscription) return subscriptionStored(input.default_subscription);
  return "subscribed";
}

export function mergeProperties(current: Record<string, unknown> | null | undefined, patch: Record<string, unknown>) {
  const next = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export function wrapProperties(properties: Record<string, unknown> | null | undefined, definitions: PropertyDefinition[]) {
  const types = new Map(definitions.map((row) => [row.key, row.type]));
  const wrapped: Record<string, { value: unknown; type: string }> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    const declared = types.get(key);
    const type = declared ?? (typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string");
    wrapped[key] = { value, type };
  }
  return wrapped;
}

export function assertPropertyValues(properties: Record<string, unknown> | undefined, definitions: PropertyDefinition[]) {
  if (!properties) return;
  const types = new Map(definitions.map((row) => [row.key, row.type]));
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;
    const type = types.get(key);
    if (!type) continue;
    if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new ApiError("validation_error", 400, `Property ${key} must be a number`);
    }
    if (type === "string" && typeof value !== "string") {
      throw new ApiError("validation_error", 400, `Property ${key} must be a string`);
    }
    if (type === "boolean" && typeof value !== "boolean") {
      throw new ApiError("validation_error", 400, `Property ${key} must be a boolean`);
    }
    if (type === "date" && !isIsoDate(value)) {
      throw new ApiError("validation_error", 400, `Property ${key} must be an ISO date`);
    }
  }
}

export function presentContact(row: ContactRow, definitions: PropertyDefinition[] = []) {
  return {
    object: "contact" as const,
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    unsubscribed: Boolean(row.unsubscribed_at),
    properties: wrapProperties(row.properties, definitions),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function presentTopic(row: {
  id: string;
  name: string;
  key: string;
  description?: string | null;
  visibility?: string | null;
  default_status: string;
  created_at: string;
  updated_at: string;
}) {
  return {
    object: "topic" as const,
    id: row.id,
    name: row.name,
    key: row.key,
    description: row.description ?? null,
    visibility: row.visibility ?? "private",
    default_subscription: subscriptionWire(row.default_status),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function presentSegment(row: {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  contacts?: number;
}) {
  return {
    object: "segment" as const,
    id: row.id,
    name: row.name,
    ...(row.contacts === undefined ? {} : { contacts: row.contacts }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function suppressionOrigin(row: { origin?: string | null; reason?: string | null }) {
  if (row.origin && row.origin !== "manual") return row.origin;
  if (row.reason === "email.bounced") return "bounce";
  if (row.reason === "email.complained") return "complaint";
  return row.origin || "manual";
}

export function presentSuppression(row: {
  id: string;
  email: string;
  reason?: string | null;
  origin?: string | null;
  source_id?: string | null;
  created_at: string;
}) {
  return {
    object: "suppression" as const,
    id: row.id,
    email: row.email,
    reason: row.reason ?? "manual",
    origin: suppressionOrigin(row),
    source_id: row.source_id ?? null,
    created_at: row.created_at,
  };
}

export function presentProperty(row: {
  id: string;
  key: string;
  type: string;
  fallback_value: unknown;
  created_at: string;
  updated_at: string;
}) {
  return { object: "contact_property" as const, ...row };
}

export function presentPage<T, U>(page: { object: "list"; has_more: boolean; data: T[] }, present: (row: T) => U) {
  return { object: page.object, has_more: page.has_more, data: page.data.map(present) };
}

export async function propertyDefinitions(db: Queryable, tenantId: string) {
  const rows = await db.query<PropertyDefinition>(
    "select key, type from contact_properties where tenant_id = $1 and deleted_at is null",
    [tenantId],
  );
  return rows.rows;
}

export async function findContact(db: Queryable, tenantId: string, ref: string) {
  const byEmail = ref.includes("@");
  const row = await db.query<ContactRow>(
    `select ${contactColumns} from contacts
     where tenant_id = $1 and ${byEmail ? "lower(email)" : "id"} = $2 and deleted_at is null
     order by created_at limit 1`,
    [tenantId, byEmail ? ref.toLowerCase() : ref],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Contact not found");
  return row.rows[0];
}

// Deletes a contact and takes it out of its segments. Topic opt-outs are kept, so a person who
// said no to a topic does not start receiving it if the address is added again later.
export async function deleteContact(db: Queryable, tenantId: string, contactId: string) {
  const removed = await db.query(
    "update contacts set deleted_at = now(), updated_at = now() where tenant_id = $1 and id = $2 and deleted_at is null returning id",
    [tenantId, contactId],
  );
  if (!removed.rows[0]) return false;
  await db.query("delete from segment_contacts where tenant_id = $1 and contact_id = $2", [tenantId, contactId]);
  await db.query("delete from topic_subscriptions where tenant_id = $1 and contact_id = $2 and status = 'subscribed'", [tenantId, contactId]);
  return true;
}

export async function updateContact(
  db: Queryable,
  tenantId: string,
  contactId: string,
  input: {
    first_name?: string | null;
    last_name?: string | null;
    properties?: Record<string, unknown>;
    unsubscribed?: boolean;
  },
) {
  const row = await db.query<ContactRow>(
    `update contacts set
       first_name = case when $3::boolean then $4 else first_name end,
       last_name = case when $5::boolean then $6 else last_name end,
       properties = case when $7::boolean then $8::jsonb else properties end,
       unsubscribed_at = case when $9::boolean is null then unsubscribed_at when $9 then now() else null end,
       updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning ${contactColumns}`,
    [
      tenantId,
      contactId,
      input.first_name !== undefined,
      input.first_name ?? null,
      input.last_name !== undefined,
      input.last_name ?? null,
      input.properties !== undefined,
      JSON.stringify(input.properties ?? {}),
      input.unsubscribed ?? null,
    ],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Contact not found");
  return row.rows[0];
}

export async function createProperty(
  db: Queryable,
  tenantId: string,
  input: { key: string; type: PropertyType; fallback_value?: string | number | boolean | null },
) {
  const existing = await db.query<{ id: string; type: string; deleted_at: string | null }>(
    "select id, type, deleted_at from contact_properties where tenant_id = $1 and key = $2",
    [tenantId, input.key],
  );
  const current = existing.rows[0];
  if ((!current || current.deleted_at) && (input.key === "topics" || input.key === "segments")) {
    throw new ApiError("validation_error", 400, `Property key ${input.key} is reserved`);
  }
  assertPropertyValues({ [input.key]: input.fallback_value }, [{ key: input.key, type: input.type }]);
  const fallback = JSON.stringify(input.fallback_value ?? null);
  if (!current) {
    const inserted = await db.query(
      `insert into contact_properties (id, tenant_id, key, type, fallback_value)
       values ($1, $2, $3, $4, $5)
       returning id, key, type, fallback_value, created_at, updated_at`,
      [id("prop"), tenantId, input.key, input.type, fallback],
    );
    return inserted.rows[0];
  }
  if (current.deleted_at) {
    const revived = await db.query(
      `update contact_properties
       set type = $3, fallback_value = $4, deleted_at = null, updated_at = now()
       where tenant_id = $1 and id = $2
       returning id, key, type, fallback_value, created_at, updated_at`,
      [tenantId, current.id, input.type, fallback],
    );
    return revived.rows[0];
  }
  if (current.type !== input.type) {
    throw new ApiError("validation_error", 400, `Property ${input.key} type cannot change`);
  }
  const updated = await db.query(
    `update contact_properties set fallback_value = $3, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning id, key, type, fallback_value, created_at, updated_at`,
    [tenantId, current.id, fallback],
  );
  return updated.rows[0];
}

export async function updateProperty(db: Queryable, tenantId: string, propertyId: string, fallback: unknown) {
  const existing = await db.query<PropertyDefinition>(
    "select key, type from contact_properties where tenant_id = $1 and id = $2 and deleted_at is null",
    [tenantId, propertyId],
  );
  if (!existing.rows[0]) throw new ApiError("not_found", 404, "Contact property not found");
  assertPropertyValues({ [existing.rows[0].key]: fallback }, existing.rows);
  const row = await db.query(
    `update contact_properties set fallback_value = $3, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning id, key, type, fallback_value, created_at, updated_at`,
    [tenantId, propertyId, JSON.stringify(fallback ?? null)],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Contact property not found");
  return row.rows[0];
}

export async function addContactSegment(db: Queryable, tenantId: string, contactId: string, segmentId: string) {
  const segment = await db.query(
    "select id from segments where tenant_id = $1 and id = $2 and deleted_at is null",
    [tenantId, segmentId],
  );
  if (!segment.rows[0]) throw new ApiError("not_found", 404, "Segment not found");
  const row = await db.query(
    `insert into segment_contacts (id, tenant_id, segment_id, contact_id)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, segment_id, contact_id) do update set segment_id = excluded.segment_id
     returning id, segment_id, contact_id, created_at`,
    [id("member"), tenantId, segmentId, contactId],
  );
  return row.rows[0];
}

export async function removeContactSegment(db: Queryable, tenantId: string, contactId: string, segmentId: string) {
  const row = await db.query(
    `delete from segment_contacts
     where tenant_id = $1 and contact_id = $2 and segment_id = $3
     returning id`,
    [tenantId, contactId, segmentId],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Segment contact not found");
  return row.rows[0];
}

export async function setContactTopics(
  db: Queryable,
  tenantId: string,
  contactId: string,
  topics: Array<{ id: string; subscription: string }>,
) {
  const saved: Array<{ topic_id: string; status: string }> = [];
  for (const topic of topics) {
    const found = await db.query(
      "select id from topics where tenant_id = $1 and id = $2 and deleted_at is null",
      [tenantId, topic.id],
    );
    if (!found.rows[0]) throw new ApiError("not_found", 404, "Topic not found");
    const status = subscriptionStored(topic.subscription);
    const row = await db.query<{ topic_id: string; status: string }>(
      `insert into topic_subscriptions (id, tenant_id, topic_id, contact_id, status)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, topic_id, contact_id)
       do update set status = excluded.status, updated_at = now()
       returning topic_id, status`,
      [id("sub"), tenantId, topic.id, contactId, status],
    );
    saved.push(row.rows[0]);
  }
  return saved;
}

export async function contactTopics(db: Queryable, tenantId: string, contactId: string) {
  const rows = await db.query<{ id: string; name: string; key: string; status: string; explicit: boolean }>(
    // Every topic, with the topic's default where the contact has made no choice.
    `select t.id, t.name, t.key, coalesce(s.status, t.default_status) as status, s.status is not null as explicit
     from topics t
     left join topic_subscriptions s on s.tenant_id = t.tenant_id and s.topic_id = t.id and s.contact_id = $2
     where t.tenant_id = $1 and t.deleted_at is null
     order by t.name`,
    [tenantId, contactId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    key: row.key,
    subscription: subscriptionWire(row.status),
    // False when the state is the topic's default and the contact never chose.
    explicit: Boolean(row.explicit),
  }));
}

export async function addSuppressions(db: Queryable, tenantId: string, emails: string[], reason = "manual") {
  // Stored lowercase so a later send to the same mailbox in another case still matches.
  const unique = [...new Set(emails.map((email) => email.toLowerCase()))];
  const row = await db.query<{
    id: string;
    email: string;
    reason: string;
    origin: string;
    source_id: string | null;
    created_at: string;
  }>(
    `insert into suppressions (id, tenant_id, email, reason, origin)
     select 'supp_' || md5($1 || email), $1, email, $3, 'manual'
     from unnest($2::text[]) as t(email)
     on conflict (tenant_id, email) do update set
       reason = excluded.reason,
       origin = 'manual',
       removed_at = null
     returning id, email, reason, origin, source_id, created_at`,
    [tenantId, unique, reason],
  );
  return row.rows;
}

export async function removeSuppressions(db: Queryable, tenantId: string, filter: { emails?: string[]; ids?: string[] }) {
  const column = filter.emails ? "lower(email)" : "id";
  const values = filter.emails?.map((email) => email.toLowerCase()) ?? filter.ids ?? [];
  const row = await db.query<{ id: string; email: string }>(
    `update suppressions set removed_at = now()
     where tenant_id = $1 and removed_at is null and ${column} = any($2::text[])
     returning id, email`,
    [tenantId, values],
  );
  return row.rows;
}

export async function findSuppression(db: Queryable, tenantId: string, ref: string) {
  const byEmail = ref.includes("@");
  const row = await db.query<{
    id: string;
    email: string;
    reason: string;
    origin: string | null;
    source_id: string | null;
    created_at: string;
  }>(
    `select id, email, reason, origin, source_id, created_at
     from suppressions
     where tenant_id = $1 and ${byEmail ? "lower(email)" : "id"} = $2 and removed_at is null`,
    [tenantId, byEmail ? ref.toLowerCase() : ref],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Suppression not found");
  return row.rows[0];
}
