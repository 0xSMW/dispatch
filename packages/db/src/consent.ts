import { ApiError, id, seal, stableHash, unseal, type FormRecord } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { assertPropertyValues, contactColumns, mergeProperties, propertyDefinitions, setContactTopics, type ContactRow } from "./audience.js";
import { dispatchContactWrite, dispatchTopicChanges, recordContactChanges } from "./contact-triggers.js";
import { getForm, reserveConfirmation, validateForm } from "./forms.js";
import { settings } from "./settings.js";
import { emit } from "./events.js";

export type FormSubmission = { email: string; first_name?: string; last_name?: string; properties: Record<string, unknown> };
export type ConfirmationPayload = {
  use: "confirm"; id: string; tenant_id: string; form_id: string; contact_id: string; topic_hash: string; exp: number;
};
type ConfirmationRow = {
  id: string; tenant_id: string; form_id: string; contact_id: string; topic_ids: string[];
  expires_at: string; used_at: string | null;
};
const invalid = () => new ApiError("not_found", 404, "Confirmation link not found");

export function readConfirmationToken(token: string, secret: string): ConfirmationPayload | null {
  const payload = unseal<Partial<ConfirmationPayload>>(token, secret);
  if (!payload || payload.use !== "confirm" || !Number.isSafeInteger(payload.exp)
    || typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  for (const key of ["id", "tenant_id", "form_id", "contact_id"] as const)
    if (typeof payload[key] !== "string" || !payload[key]) return null;
  if (typeof payload.topic_hash !== "string" || !/^[0-9a-f]{64}$/.test(payload.topic_hash)) return null;
  return payload as ConfirmationPayload;
}

export async function confirmationState(client: Queryable, payload: ConfirmationPayload, lock = false) {
  const result = await client.query<ConfirmationRow>(
    `select id, tenant_id, form_id, contact_id, topic_ids, expires_at, used_at from confirmations
     where id = $1 and tenant_id = $2 and form_id = $3 and contact_id = $4
       and expires_at > clock_timestamp()${lock ? " for update" : ""}`,
    [payload.id, payload.tenant_id, payload.form_id, payload.contact_id],
  );
  const row = result.rows[0];
  if (!row || stableHash(row.topic_ids) !== payload.topic_hash
    || Math.floor(new Date(row.expires_at).getTime() / 1000) !== payload.exp) throw invalid();
  return row;
}

// Lock an address even before it exists. Forms never call the reviving API upsert.
async function formContact(client: Queryable, tenantId: string, input: FormSubmission) {
  await client.query("select pg_advisory_xact_lock(hashtextextended('form_contact:' || $1::text || ':' || $2::text, 0))", [tenantId, input.email]);
  const result = await client.query<ContactRow & { deleted_at: string | null }>(
    `select ${contactColumns}, deleted_at from contacts where tenant_id = $1 and lower(email) = $2 for update`,
    [tenantId, input.email],
  );
  return result.rows[0] ?? null;
}

export async function submitForm(client: Queryable, form: FormRecord, input: FormSubmission, requestId: string,
  deps: { secret: string; enqueue: (client: Queryable, form: FormRecord, email: string, token: string) => Promise<void> }) {
  const { id: _id, tenant_id: _tenant, key: _key, created_at: _created, updated_at: _updated, deleted_at: _deleted, ...fields } = form;
  await validateForm(client, form.tenant_id, fields);
  const definitions = await propertyDefinitions(client, form.tenant_id);
  assertPropertyValues(input.properties, definitions);
  // Tenant quota lock precedes every address/contact lock, even when confirmation is off.
  await client.query("select pg_advisory_xact_lock(hashtextextended('confirmation_quota:' || $1::text, 0))", [form.tenant_id]);
  const before = await formContact(client, form.tenant_id, input);
  // A tombstone or global opt-out always requires deliberate consent, including on single-opt-in forms.
  const needsConfirmation = form.double_opt_in || Boolean(before?.unsubscribed_at || before?.deleted_at);
  if (needsConfirmation) {
    const config = await settings(client, form.tenant_id);
    if (!await reserveConfirmation(client, form.tenant_id, form.id, input.email, config.confirmation_daily_limit)) return;
  }
  let contact: ContactRow;
  if (!before) {
    const inserted = await client.query<ContactRow>(
      `insert into contacts (id, tenant_id, email, first_name, last_name, properties)
       values ($1, $2, $3, $4, $5, $6::jsonb) on conflict do nothing returning ${contactColumns}`,
      [id("contact"), form.tenant_id, input.email, input.first_name ?? null, input.last_name ?? null, JSON.stringify(input.properties)],
    );
    if (!inserted.rows[0]) throw new ApiError("conflict", 409, "Contact changed during submission");
    contact = inserted.rows[0];
  } else if (before.deleted_at) {
    // Do not alter tombstone fields before confirmation either.
    contact = before;
  } else {
    const updated = await client.query<ContactRow>(
      `update contacts set first_name = coalesce($3, first_name), last_name = coalesce($4, last_name),
         properties = $5::jsonb, updated_at = clock_timestamp()
       where tenant_id = $1 and id = $2 and deleted_at is null returning ${contactColumns}`,
      [form.tenant_id, before.id, input.first_name ?? null, input.last_name ?? null,
        JSON.stringify(mergeProperties(before.properties, input.properties))],
    );
    contact = updated.rows[0]!;
  }
  const changes = await setContactTopics(client, form.tenant_id, contact.id,
    [...new Set(form.topic_ids)].sort().map((topicId) => ({ id: topicId, subscription: needsConfirmation ? "pending" : "opt_in" })));
  if (needsConfirmation) {
    // Pending is not a topic subscription event. Record only actual receiving changes.
    for (const change of changes) if (before && !contact.unsubscribed_at && !before.deleted_at && change.before === "subscribed")
      await recordContactChanges(client, form.tenant_id, requestId, contact.id, [{ field: `topics.${change.topic_id}`, from: true, to: false }]);
    const result = await client.query<ConfirmationRow>(
      `insert into confirmations (id, tenant_id, form_id, contact_id, topic_ids, expires_at)
       values ($1, $2, $3, $4, $5, date_trunc('second', clock_timestamp()) + interval '7 days')
       returning id, tenant_id, form_id, contact_id, topic_ids, expires_at, used_at`,
      [id("confirm"), form.tenant_id, form.id, contact.id, [...new Set(form.topic_ids)].sort()],
    );
    const row = result.rows[0]!;
    const token = seal({ use: "confirm", id: row.id, tenant_id: row.tenant_id, form_id: row.form_id,
      contact_id: row.contact_id, topic_hash: stableHash(row.topic_ids), exp: Math.floor(new Date(row.expires_at).getTime() / 1000) }, deps.secret);
    // Both quota writes, contact/pending/token, template installation and enqueue roll back together.
    await deps.enqueue(client, form, input.email, token);
    if (before?.deleted_at) return;
  }
  await dispatchContactWrite(client, form.tenant_id, requestId, before, contact, { created: !before });
  if (!needsConfirmation) {
    await dispatchTopicChanges(client, form.tenant_id, requestId, contact, changes.map((change) =>
      !before ? { ...change, before: "pending" } : change));
  }
  await emit(client, { tenantId: form.tenant_id, requestId, type: before ? "contact.updated" : "contact.created",
    resourceId: contact.id, data: { id: contact.id, email: contact.email }, key: `${id("change")}:form` });
}

export async function confirmForm(client: Queryable, payload: ConfirmationPayload, requestId: string) {
  // Form -> contact -> durable token. Every caller uses this order; no stale unlocked state drives effects.
  const form = await getForm(client, payload.tenant_id, payload.form_id, true);
  const found = await client.query<ContactRow & { deleted_at: string | null }>(
    `select ${contactColumns}, deleted_at from contacts where tenant_id = $1 and id = $2 for update`,
    [payload.tenant_id, payload.contact_id],
  );
  const before = found.rows[0];
  if (!before) throw invalid();
  const state = await confirmationState(client, payload, true);
  if (state.used_at) return form.redirect_url;
  const topics = await client.query<{ id: string }>(
    "select id from topics where tenant_id = $1 and id = any($2::text[]) and deleted_at is null order by id for share",
    [payload.tenant_id, state.topic_ids],
  );
  if (topics.rows.length !== state.topic_ids.length) throw invalid();
  const contact = (await client.query<ContactRow>(
    `update contacts set deleted_at = null, unsubscribed_at = null, updated_at = clock_timestamp()
     where tenant_id = $1 and id = $2 returning ${contactColumns}`,
    [payload.tenant_id, payload.contact_id],
  )).rows[0]!;
  const changes = await setContactTopics(client, payload.tenant_id, contact.id, state.topic_ids.map((topicId) => ({ id: topicId, subscription: "opt_in" })));
  await dispatchContactWrite(client, payload.tenant_id, requestId, before, contact, { created: Boolean(before.deleted_at) });
  await dispatchTopicChanges(client, payload.tenant_id, requestId, contact, changes.map((change) =>
    before.deleted_at || before.unsubscribed_at ? { ...change, before: "pending" } : change));
  await emit(client, { tenantId: payload.tenant_id, requestId, type: "contact.topics.updated",
    resourceId: contact.id, data: { id: contact.id, email: contact.email }, key: `${state.id}:confirmed` });
  await client.query("update confirmations set used_at = clock_timestamp() where tenant_id = $1 and id = $2", [payload.tenant_id, state.id]);
  return form.redirect_url;
}
