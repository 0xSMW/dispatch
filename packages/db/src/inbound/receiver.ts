import { isDeepStrictEqual } from "node:util";
import { ApiError, id, type InboundDelivery, type InboundResult, type IntegrationRecord } from "@dispatchmail/core";
import type { Client, Db } from "../index.js";
import { retryTx } from "../retry.js";
import { applyInbound } from "./application.js";
import { recordInboundFailure } from "./deliveries.js";
import { integrationColumns } from "./management.js";
import type { ReceiveInboundInput } from "./types.js";

const reasons = new Set([
  "unsupported_event", "invalid_payload", "no_contact", "deleted_contact", "ambiguous_contact",
]);

function safeResult(result: InboundResult): InboundResult {
  if (result.status !== "processed" && result.status !== "ignored") {
    throw new Error("Invalid inbound application result");
  }
  return {
    status: result.status, eventName: result.eventName, contactId: result.contactId,
    ...(result.reason !== undefined
      ? { reason: reasons.has(result.reason) ? result.reason : "no_contact" } : {}),
  };
}

type InboundIdentity = Pick<ReceiveInboundInput, "integration" | "tokenHash" | "providerEventId">;
type Duplicate = InboundResult & { duplicate: true };

async function lockIntegration(
  client: Client, input: InboundIdentity, errors: { missing: ApiError; changed: ApiError },
): Promise<IntegrationRecord> {
  // Both advisory lookup and receive serialize with management's changes and
  // authenticate the current row, not the earlier authenticated/prepared snapshot.
  const locked = await client.query<IntegrationRecord>(
    `select ${integrationColumns} from integrations
     where tenant_id = $1 and id = $2 and deleted_at is null for update`,
    [input.integration.tenant_id, input.integration.id],
  );
  const current = locked.rows[0];
  if (!current || current.deleted_at !== null
    || current.token_hash !== input.tokenHash
    || input.integration.token_hash !== input.tokenHash) throw errors.missing;
  if (current.provider !== input.integration.provider
    || current.slug !== input.integration.slug
    || current.secret !== input.integration.secret
    || !isDeepStrictEqual(current.settings, input.integration.settings)) throw errors.changed;
  if (typeof input.providerEventId !== "string" || !input.providerEventId
    || input.providerEventId.startsWith("attempt:")) {
    throw new Error("Invalid verified event identity");
  }
  return current;
}

async function storedDuplicate(
  client: Client, integration: IntegrationRecord, providerEventId: string,
): Promise<Duplicate | null> {
  const existing = await client.query<InboundDelivery>(
    `select status, event_name, contact_id, error from inbound_deliveries
     where tenant_id = $1 and integration_id = $2 and provider_event_id = $3`,
    [integration.tenant_id, integration.id, providerEventId],
  );
  const delivery = existing.rows[0];
  if (!delivery) return null;
  if (delivery.status === "failed") throw new Error("Delivery reservation unavailable");
  return {
    ...safeResult({
      status: delivery.status, eventName: delivery.event_name, contactId: delivery.contact_id,
      ...(delivery.error !== null ? { reason: delivery.error } : {}),
    }),
    duplicate: true,
  };
}

/** Authenticated advisory read only: a miss must still use receive's full lock/recheck. */
export async function inboundDuplicate(
  db: Db, input: InboundIdentity,
): Promise<Duplicate | null> {
  const missing = new ApiError("not_found", 404, "Integration not found");
  const changed = new ApiError("service_unavailable", 503, "Inbound delivery could not be processed; retry");
  try {
    return await retryTx(db, async client => {
      const current = await lockIntegration(client, input, { missing, changed });
      return storedDuplicate(client, current, input.providerEventId);
    });
  } catch (error) {
    if (error === missing || error === changed) throw error;
    // Lookup failures remain retryable without reserving identities or writing audits.
    throw new ApiError("service_unavailable", 503, "Inbound delivery could not be processed; retry");
  }
}

export async function receiveInbound(
  db: Db, input: ReceiveInboundInput,
): Promise<InboundResult & { duplicate?: boolean }> {
  const missing = new ApiError("not_found", 404, "Integration not found");
  const changed = new ApiError("service_unavailable", 503, "Inbound delivery could not be processed; retry");
  try {
    return await retryTx(db, async client => {
      const current = await lockIntegration(client, input, { missing, changed });

      const deliveryId = id("delivery");
      const reserved = await client.query<{ id: string }>(
        `insert into inbound_deliveries
         (id, tenant_id, integration_id, provider_event_id, status)
         values ($1, $2, $3, $4, 'failed')
         on conflict (integration_id, provider_event_id) do nothing returning id`,
        [deliveryId, current.tenant_id, current.id, input.providerEventId],
      );
      if (!reserved.rows[0]) {
        const duplicate = await storedDuplicate(client, current, input.providerEventId);
        if (!duplicate) throw new Error("Delivery reservation unavailable");
        return duplicate;
      }
      const result = safeResult(await applyInbound(client, current, input.mapping, input.requestId));
      await client.query(
        `update inbound_deliveries set status = $3, event_name = $4, contact_id = $5, error = $6
         where tenant_id = $1 and id = $2`,
        [current.tenant_id, deliveryId, result.status, result.eventName, result.contactId, result.reason ?? null],
      );
      await client.query(
        `update integrations set last_received_at = now()
         where tenant_id = $1 and id = $2`,
        [current.tenant_id, current.id],
      );
      return result;
    });
  } catch (error) {
    // retryTx has already rolled back/released before any separate failure audit.
    if (error === missing || error === changed) throw error;
    try {
      await recordInboundFailure(db, input.integration, input.requestId, "processing_failed");
    } catch {
      // Audit availability must not replace the fixed, retryable receiver response.
    }
    throw new ApiError("service_unavailable", 503, "Inbound delivery could not be processed; retry");
  }
}
