import { ApiError, id, type InboundResult, type IntegrationRecord } from "@dispatchmail/core";
import {
  assertPropertyValues, contactColumns, deleteContact, mergeProperties, propertyDefinitions,
  type ContactRow,
} from "../audience.js";
import { fireEventWithClient } from "../automations.js";
import { dispatchContactWrite } from "../contact-triggers.js";
import { emit } from "../events.js";
import type { Queryable } from "../index.js";
import { mapClerk } from "./clerk.js";
import { mapStripe } from "./stripe.js";
import { stripeCustomer } from "./stripe-customer.js";
import { mapSupabase } from "./supabase.js";
import { mapWebhook } from "./webhook.js";
import type { ContactLookup, InboundDependencies, Mapping } from "./types.js";

/** Pure mapping and optional provider I/O happen once, outside database-only retries. */
export async function prepareInbound(
  integration: IntegrationRecord, payload: unknown, dependencies: InboundDependencies = {},
): Promise<Mapping> {
  switch (integration.provider) {
    case "stripe":
      return mapStripe(payload, {
        mapPlan: integration.settings.map_plan === true,
        ...(dependencies.stripeRestrictedKey ? {
          resolveCustomer: (customerId: string) => stripeCustomer(
            customerId, dependencies.stripeRestrictedKey!, dependencies.customerTransport,
          ),
        } : {}),
      });
    case "clerk":
      return mapClerk(payload, { deleteContact: integration.settings.delete_contact === true });
    case "supabase":
      return mapSupabase(payload);
    case "webhook":
      return mapWebhook(payload, integration.slug);
  }
}

type StoredContact = ContactRow & { deleted_at: string | null };
const providerProperties = {
  stripe: "stripe_customer_id", clerk: "clerk_user_id", supabase: "supabase_user_id",
} as const;

function lookups(integration: IntegrationRecord, mapping: Exclude<Mapping, { action: "ignored" }>): ContactLookup[] {
  const result: ContactLookup[] = [mapping.lookup];
  if (mapping.action === "upsert" && integration.provider !== "webhook") {
    const property = providerProperties[integration.provider];
    const value = mapping.contact.properties?.[property];
    if (typeof value === "string" && value && !("property" in mapping.lookup)) result.push({ property, value });
  }
  return result;
}

async function lookupContact(client: Queryable, tenantId: string, identities: ContactLookup[]) {
  // Include tombstones and take all matching row locks in a stable order. A provider ID
  // and address identifying different rows is a conflict, not permission to pick one.
  const keys = identities.map((lookup) => "email" in lookup
    ? `email:${lookup.email.toLowerCase()}` : `${lookup.property}:${lookup.value}`).sort();
  for (const key of keys) await client.query(
    "select pg_advisory_xact_lock(hashtextextended('inbound_contact:' || $1::text || ':' || $2::text, 0))",
    [tenantId, key],
  );
  const values: unknown[] = [tenantId];
  const clauses = identities.map((lookup) => {
    if ("email" in lookup) {
      values.push(lookup.email.toLowerCase());
      return `lower(email) = $${values.length}`;
    }
    values.push(lookup.property, lookup.value);
    return `properties ->> $${values.length - 1}::text = $${values.length}::text`;
  });
  return (await client.query<StoredContact>(
    `select ${contactColumns}, deleted_at from contacts
     where tenant_id = $1 and (${clauses.join(" or ")}) order by id for update`, values,
  )).rows;
}

/** All effects use the caller's transaction. Never calls a reviving upsert or owns a transaction. */
export async function applyInbound(
  client: Queryable, integration: IntegrationRecord, mapping: Mapping, requestId: string,
): Promise<InboundResult> {
  const ignored = (reason: string): InboundResult => ({
    status: "ignored", eventName: mapping.action === "ignored" ? null : mapping.event.name,
    contactId: null, reason,
  });
  if (mapping.action === "ignored") return ignored(mapping.reason);
  // Defense in depth: mappings cannot cross provider/app namespaces or reach internal triggers.
  const namespace = integration.provider === "webhook" ? integration.slug : integration.provider;
  if (!mapping.event.name.startsWith(`${namespace}.`) || mapping.event.name.startsWith("@")) {
    throw new ApiError("validation_error", 400, "Invalid inbound event namespace");
  }
  const found = await lookupContact(client, integration.tenant_id, lookups(integration, mapping));
  if (found.length > 1) return ignored("ambiguous_contact");
  const before = found[0] ?? null;
  if (before?.deleted_at) return ignored("no_contact");
  if (!before && (mapping.action !== "upsert" || !("email" in mapping.lookup))) return ignored("no_contact");
  let contact: ContactRow;
  if (mapping.action === "upsert") {
    if (before && integration.provider !== "webhook") {
      const property = providerProperties[integration.provider];
      const previous = before.properties?.[property];
      const incoming = mapping.contact.properties?.[property];
      if (previous != null && incoming != null && previous !== incoming) return ignored("ambiguous_contact");
    }
    const definitions = await propertyDefinitions(client, integration.tenant_id);
    assertPropertyValues(mapping.contact.properties, definitions);
    const properties = mergeProperties(before?.properties, mapping.contact.properties ?? {});
    if (before) {
      const updated = await client.query<ContactRow>(
        `update contacts set
           first_name = case when $3::boolean then $4 else first_name end,
           last_name = case when $5::boolean then $6 else last_name end,
           properties = $7::jsonb, updated_at = clock_timestamp()
         where tenant_id = $1 and id = $2 and deleted_at is null returning ${contactColumns}`,
        [integration.tenant_id, before.id, mapping.contact.first_name !== undefined,
          mapping.contact.first_name ?? null, mapping.contact.last_name !== undefined,
          mapping.contact.last_name ?? null, JSON.stringify(properties)],
      );
      if (!updated.rows[0]) throw new ApiError("conflict", 409, "Contact changed during inbound application");
      contact = updated.rows[0];
    } else {
      // The guarded branch above guarantees an address. ON CONFLICT never revives a tombstone.
      const address = "email" in mapping.lookup ? mapping.lookup.email.toLowerCase() : "";
      const inserted = await client.query<ContactRow>(
        `insert into contacts (id, tenant_id, email, first_name, last_name, properties)
         values ($1, $2, $3, $4, $5, $6::jsonb) on conflict do nothing returning ${contactColumns}`,
        [id("contact"), integration.tenant_id, address, mapping.contact.first_name ?? null,
          mapping.contact.last_name ?? null, JSON.stringify(properties)],
      );
      if (!inserted.rows[0]) throw new ApiError("conflict", 409, "Contact changed during inbound application");
      contact = inserted.rows[0];
    }
    await dispatchContactWrite(client, integration.tenant_id, requestId, before, contact, { created: !before });
    await emit(client, {
      tenantId: integration.tenant_id, requestId, type: before ? "contact.updated" : "contact.created",
      resourceId: contact.id, data: { id: contact.id, email: contact.email }, key: `${id("change")}:inbound`,
    });
  } else {
    contact = before!;
  }
  await fireEventWithClient(client, integration.tenant_id, requestId, {
    ...mapping.event, email: contact.email,
  }, contact);
  if (mapping.action === "delete") {
    // Record the lifecycle event while the resolved contact is live; then ordinary cleanup.
    // No eventContact/fireEvent call after deletion can implicitly resurrect it.
    if (!await deleteContact(client, integration.tenant_id, contact.id)) {
      throw new ApiError("conflict", 409, "Contact changed during inbound application");
    }
    await emit(client, {
      tenantId: integration.tenant_id, requestId, type: "contact.deleted",
      resourceId: contact.id, data: { id: contact.id, email: contact.email }, key: `${id("change")}:inbound`,
    });
  }
  return { status: "processed", eventName: mapping.event.name, contactId: contact.id };
}
