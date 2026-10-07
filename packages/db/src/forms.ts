import { randomBytes } from "node:crypto";
import { ApiError, formSchema, id, type Form, type FormInput, type FormRecord, type FormUpdate } from "@dispatchmail/core";
import type { Queryable } from "./index.js";

export const formColumns = `id, tenant_id, name, key, topic_ids, properties, double_opt_in,
  from_email, allowed_origins, redirect_url, created_at, updated_at, deleted_at`;

export function presentForm(row: FormRecord): Form {
  const { tenant_id: _tenantId, deleted_at: _deletedAt, ...form } = row;
  return {
    ...form,
    object: "form",
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function parseForm(input: unknown): FormInput {
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("validation_error", 400, parsed.error.issues[0]?.message ?? "Invalid form");
  return parsed.data;
}

// Callers own the transaction. Shared reference locks keep validation valid until commit.
export async function validateForm(client: Queryable, tenantId: string, input: FormInput): Promise<void> {
  const data = parseForm(input);
  const domain = data.from_email.slice(data.from_email.lastIndexOf("@") + 1).toLowerCase();
  const sender = await client.query(
    `select id from domains where tenant_id = $1 and lower(name) = $2
     and status = 'verified' and sending = 'enabled' and deleted_at is null for share`,
    [tenantId, domain],
  );
  if (!sender.rows[0]) throw new ApiError("validation_error", 400, "The form sender requires an exact verified, sending-enabled domain");
  const topicIds = [...new Set(data.topic_ids)].sort();
  const topics = await client.query<{ id: string }>(
    `select id from topics where tenant_id = $1 and id = any($2::text[])
     and deleted_at is null order by id for share`,
    [tenantId, topicIds],
  );
  const foundTopics = new Set(topics.rows.map((row) => row.id));
  if (topicIds.some((topicId) => !foundTopics.has(topicId))) {
    throw new ApiError("validation_error", 400, "Form topics must be live topics belonging to this tenant");
  }
  const propertyKeys = [...new Set(data.properties)].sort();
  if (!propertyKeys.length) return;
  const properties = await client.query<{ key: string }>(
    `select key from contact_properties where tenant_id = $1 and key = any($2::text[])
     and deleted_at is null order by key for share`,
    [tenantId, propertyKeys],
  );
  const foundProperties = new Set(properties.rows.map((row) => row.key));
  if (propertyKeys.some((key) => !foundProperties.has(key))) {
    throw new ApiError("validation_error", 400, "Form properties must be declared, live properties belonging to this tenant");
  }
}

function values(input: FormInput) {
  return [input.name, input.topic_ids, input.properties, input.double_opt_in,
    input.from_email, input.allowed_origins, input.redirect_url];
}

export async function createForm(client: Queryable, tenantId: string, input: FormInput): Promise<FormRecord> {
  const data = parseForm(input);
  await validateForm(client, tenantId, data);
  const result = await client.query<FormRecord>(
    `insert into forms (id, tenant_id, key, name, topic_ids, properties, double_opt_in,
      from_email, allowed_origins, redirect_url)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${formColumns}`,
    [id("form"), tenantId, randomBytes(32).toString("base64url"), ...values(data)],
  );
  return result.rows[0]!;
}

export async function getForm(client: Queryable, tenantId: string, formId: string, lock = false): Promise<FormRecord> {
  const result = await client.query<FormRecord>(
    `select ${formColumns} from forms where tenant_id = $1 and id = $2 and deleted_at is null${lock ? " for update" : ""}`,
    [tenantId, formId],
  );
  if (!result.rows[0]) throw new ApiError("not_found", 404, "Form not found");
  return result.rows[0];
}

export async function getFormByKey(client: Queryable, key: string, lock = false): Promise<FormRecord | null> {
  const result = await client.query<FormRecord>(
    `select ${formColumns} from forms where key = $1 and deleted_at is null${lock ? " for update" : ""}`,
    [key],
  );
  return result.rows[0] ?? null;
}

export async function updateForm(client: Queryable, tenantId: string, formId: string, input: FormUpdate): Promise<FormRecord> {
  const current = await getForm(client, tenantId, formId, true);
  const { id: _id, tenant_id: _tenantId, key: _key, created_at: _createdAt,
    updated_at: _updatedAt, deleted_at: _deletedAt, ...fields } = current;
  // Undefined means omitted; false and null are meaningful updates.
  const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const data = parseForm({ ...fields, ...patch });
  await validateForm(client, tenantId, data);
  const result = await client.query<FormRecord>(
    `update forms set name = $3, topic_ids = $4, properties = $5, double_opt_in = $6,
      from_email = $7, allowed_origins = $8, redirect_url = $9, updated_at = clock_timestamp()
     where tenant_id = $1 and id = $2 and deleted_at is null returning ${formColumns}`,
    [tenantId, formId, ...values(data)],
  );
  if (!result.rows[0]) throw new ApiError("not_found", 404, "Form not found");
  return result.rows[0];
}

export async function deleteForm(client: Queryable, tenantId: string, formId: string): Promise<boolean> {
  const result = await client.query(
    `update forms set deleted_at = clock_timestamp(), updated_at = clock_timestamp()
     where tenant_id = $1 and id = $2 and deleted_at is null returning id`,
    [tenantId, formId],
  );
  return Boolean(result.rows[0]);
}

// Lock order: tenant quota advisory lock FIRST, then the address/form reservation.
// All confirmation writers must use this helper on their caller-owned enqueue transaction.
// The tenant lock covers absent counter/address rows and serializes different forms/addresses.
// Capture database wall time AFTER acquiring it (never transaction-start now()).
// A refusal writes nothing; both successful writes roll back if enqueueing later fails.
export async function reserveConfirmation(
  client: Queryable, tenantId: string, formId: string, normalizedEmail: string, cap = 500,
): Promise<boolean> {
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > 2_147_483_647) return false;
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended('confirmation_quota:' || $1::text, 0))",
    [tenantId],
  );
  const result = await client.query<{ reserved: boolean }>(
    `with instant as materialized (
       select clock_timestamp() as time
     ), reservation as (
       insert into confirmation_sends (tenant_id, form_id, email, sent_at)
       select $1, $2, $3, instant.time from instant
       where exists (select 1 from forms where tenant_id = $1 and id = $2 and deleted_at is null)
         and coalesce((select sends from confirmation_days
           where tenant_id = $1 and day = (instant.time at time zone 'UTC')::date), 0) < $4
         and not exists (select 1 from confirmation_sends
           where tenant_id = $1 and form_id = $2 and email = $3
             and sent_at > instant.time - interval '24 hours')
       on conflict (tenant_id, form_id, email) do update set sent_at = excluded.sent_at
         where confirmation_sends.sent_at <= excluded.sent_at - interval '24 hours'
       returning sent_at
     ), incremented as (
       insert into confirmation_days (tenant_id, day, sends)
       select $1, (sent_at at time zone 'UTC')::date, 1 from reservation
       on conflict (tenant_id, day) do update set sends = confirmation_days.sends + 1
       returning sends
     )
     select true as reserved from incremented`,
    [tenantId, formId, normalizedEmail.toLowerCase(), cap],
  );
  return result.rows[0]?.reserved === true;
}
