import { randomBytes } from "node:crypto";
import {
  ApiError, id, integrationSchema, integrationUpdateSchema,
  type InboundDelivery, type Integration, type IntegrationInput,
  type IntegrationRecord, type IntegrationUpdate,
} from "@dispatchmail/core";
import type { Queryable } from "../index.js";
import { decryptCredentials, encryptCredentials, inboundTokenHash } from "./security.js";

export const integrationColumns = "id, tenant_id, provider, name, slug, token_hash, secret, settings, last_received_at, created_at, updated_at, deleted_at";
const deliveryColumns = "id, tenant_id, integration_id, provider_event_id, status, event_name, contact_id, error, created_at";
const reservedSlugs = new Set(["stripe", "clerk", "supabase"]);

// SQL and crypto failures may contain parameters. Never propagate them or attach a cause.
async function query<T extends IntegrationRecord | InboundDelivery | { id: string }>(
  client: Queryable, sql: string, values: unknown[],
): Promise<T[]> {
  try {
    return (await client.query<T>(sql, values)).rows;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "23505") {
      throw new ApiError("conflict", 409, "Integration already exists");
    }
    throw new ApiError("internal_error", 500, "Integration operation failed");
  }
}

function credentials(values: Parameters<typeof encryptCredentials>[0], appSecret: string) {
  try {
    return encryptCredentials(values, appSecret);
  } catch {
    throw new ApiError("internal_error", 500, "Integration credentials could not be stored");
  }
}

function missing(): never {
  throw new ApiError("not_found", 404, "Integration not found");
}

export function presentIntegration(row: IntegrationRecord): Integration {
  const settings: Integration["settings"] = {};
  if (row.settings.map_plan !== undefined) settings.map_plan = row.settings.map_plan;
  if (row.settings.delete_contact !== undefined) settings.delete_contact = row.settings.delete_contact;
  if (row.settings.secret_header !== undefined) settings.secret_header = row.settings.secret_header;
  return {
    object: "integration", id: row.id, provider: row.provider, name: row.name, slug: row.slug,
    settings, has_restricted_key: typeof row.settings.stripe_restricted_key === "string"
      && row.settings.stripe_restricted_key.length > 0,
    last_received_at: row.last_received_at, created_at: row.created_at, updated_at: row.updated_at,
  };
}

export async function createIntegration(
  client: Queryable, tenantId: string, input: IntegrationInput, appSecret: string,
): Promise<{ integration: Integration; token: string }> {
  const parsed = integrationSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("validation_error", 400, "Invalid integration");
  const data = parsed.data;
  if (data.provider === "webhook" && reservedSlugs.has(data.slug ?? "webhook")) {
    throw new ApiError("validation_error", 400, "Choose a nonreserved webhook slug");
  }
  if (data.provider !== "webhook" && data.slug !== undefined && data.slug !== data.provider) {
    throw new ApiError("validation_error", 400, "Provider integrations use their provider as the slug");
  }
  const stored = credentials({
    signingSecret: data.secret, stripeRestrictedKey: data.settings.stripe_restricted_key,
  }, appSecret);
  const settings = {
    ...data.settings, delete_contact: data.settings.delete_contact ?? false,
    ...(stored.stripeRestrictedKey !== undefined
      ? { stripe_restricted_key: stored.stripeRestrictedKey } : {}),
  };
  const token = randomBytes(32).toString("base64url");
  const rows = await query<IntegrationRecord>(client,
    `insert into integrations (id, tenant_id, provider, name, slug, token_hash, secret, settings)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     returning ${integrationColumns}`,
    [id("integration"), tenantId, data.provider, data.name, data.slug ?? data.provider,
      inboundTokenHash(token), stored.signingSecret, JSON.stringify(settings)],
  );
  if (!rows[0]) throw new ApiError("internal_error", 500, "Integration operation failed");
  return { integration: presentIntegration(rows[0]), token };
}

export async function updateIntegration(
  client: Queryable, tenantId: string, integrationId: string,
  input: IntegrationUpdate, appSecret: string,
): Promise<Integration> {
  const parsed = integrationUpdateSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("validation_error", 400, "Invalid integration update");
  const data = parsed.data;
  const rows = await query<IntegrationRecord>(client,
    `select ${integrationColumns} from integrations
     where tenant_id = $1 and id = $2 and deleted_at is null for update`,
    [tenantId, integrationId],
  );
  const current = rows[0] ?? missing();
  const settings = { ...current.settings };
  for (const key of ["map_plan", "delete_contact", "secret_header"] as const) {
    const value = data.settings?.[key];
    if (value !== undefined) Object.assign(settings, { [key]: value });
  }
  let secret = current.secret;
  const key = data.settings?.stripe_restricted_key;
  if (data.secret !== undefined || typeof key === "string") {
    // Decrypt only to supply the unchanged signing secret when encrypting a new key.
    // Omitted stored credentials retain their exact ciphertext.
    let signingSecret = data.secret;
    if (signingSecret === undefined) {
      try {
        signingSecret = decryptCredentials({ signingSecret: current.secret }, appSecret).signingSecret;
      } catch {
        throw new ApiError("internal_error", 500, "Integration credentials could not be stored");
      }
    }
    const stored = credentials({
      signingSecret, ...(key !== undefined ? { stripeRestrictedKey: key } : {}),
    }, appSecret);
    if (data.secret !== undefined) secret = stored.signingSecret;
    if (key !== undefined) settings.stripe_restricted_key = stored.stripeRestrictedKey;
  } else if (key === null) {
    settings.stripe_restricted_key = null;
  }
  const updated = await query<IntegrationRecord>(client,
    `update integrations set name = $3, secret = $4, settings = $5::jsonb, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null returning ${integrationColumns}`,
    [tenantId, integrationId, data.name ?? current.name, secret, JSON.stringify(settings)],
  );
  return presentIntegration(updated[0] ?? missing());
}

export async function deleteIntegration(
  client: Queryable, tenantId: string, integrationId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(client,
    `update integrations set deleted_at = now(), updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null returning id`,
    [tenantId, integrationId],
  );
  return rows.length > 0;
}

export async function getIntegration(
  client: Queryable, tenantId: string, integrationId: string,
): Promise<Integration> {
  const rows = await query<IntegrationRecord>(client,
    `select ${integrationColumns} from integrations
     where tenant_id = $1 and id = $2 and deleted_at is null`,
    [tenantId, integrationId],
  );
  return presentIntegration(rows[0] ?? missing());
}

export async function rotateIntegration(
  client: Queryable, tenantId: string, integrationId: string,
): Promise<{ integration: Integration; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const rows = await query<IntegrationRecord>(client,
    `update integrations set token_hash = $3, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null returning ${integrationColumns}`,
    [tenantId, integrationId, inboundTokenHash(token)],
  );
  return { integration: presentIntegration(rows[0] ?? missing()), token };
}

// Internal receiver lookup only: this deliberately returns encrypted credentials.
export async function integrationByToken(
  client: Queryable, token: string,
): Promise<IntegrationRecord | null> {
  if (typeof token !== "string" || !token) return null;
  const rows = await query<IntegrationRecord>(client,
    `select ${integrationColumns} from integrations where token_hash = $1 and deleted_at is null`,
    [inboundTokenHash(token)],
  );
  return rows[0] ?? null;
}

export async function listDeliveries(
  client: Queryable, tenantId: string, integrationId: string, limit = 20,
): Promise<InboundDelivery[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ApiError("validation_error", 400, "Delivery limit must be a positive integer");
  }
  await getIntegration(client, tenantId, integrationId);
  const rows = await query<InboundDelivery>(client,
    `select ${deliveryColumns} from inbound_deliveries
     where tenant_id = $1 and integration_id = $2 order by created_at desc, id desc limit $3`,
    [tenantId, integrationId, Math.min(limit, 100)],
  );
  // An allowlist also prevents accidental extra fields from reaching management callers.
  return rows.map(row => ({
    id: row.id, tenant_id: row.tenant_id, integration_id: row.integration_id,
    provider_event_id: row.provider_event_id, status: row.status, event_name: row.event_name,
    contact_id: row.contact_id, error: row.error, created_at: row.created_at,
  }));
}
