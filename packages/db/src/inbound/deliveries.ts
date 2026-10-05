import { randomUUID } from "node:crypto";
import { ApiError, id, type IntegrationRecord } from "@dispatchmail/core";
import type { Queryable } from "../index.js";

type FailureReason = "invalid_signature" | "invalid_payload" | "processing_failed";
const failureReasons = new Set<FailureReason>(["invalid_signature", "invalid_payload", "processing_failed"]);

// Failed attempts never reserve the provider's verified replay identity. Neither the
// request ID (caller-controlled) nor a body, credential or exception belongs in this log.
export async function recordInboundFailure(
  db: Queryable, integration: IntegrationRecord, requestId: string, reason: FailureReason,
): Promise<void> {
  void requestId;
  const safeReason = failureReasons.has(reason) ? reason : "processing_failed";
  try {
    await db.query(
      `insert into inbound_deliveries
       (id, tenant_id, integration_id, provider_event_id, status, event_name, contact_id, error)
       values ($1, $2, $3, $4, 'failed', null, null, $5)`,
      [id("delivery"), integration.tenant_id, integration.id, `attempt:${randomUUID()}`, safeReason],
    );
  } catch {
    throw new ApiError("internal_error", 500, "Inbound delivery could not be recorded");
  }
}

function bounded(value: number, fallback: number, maximum: number) {
  return Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), maximum) : fallback;
}

// Pruning canonical keys also bounds replay protection to this retention period.
export async function pruneInboundDeliveries(
  db: Queryable,
  days = Number(process.env.LOG_RETENTION_DAYS ?? 30),
  batch = 10_000,
  maxBatches = 20,
): Promise<number> {
  const retention = bounded(days, 30, 2_147_483_647);
  const size = bounded(batch, 10_000, 10_000);
  const passes = Number.isFinite(maxBatches)
    ? Math.max(0, Math.min(Math.floor(maxBatches), 20)) : 20;
  let removed = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    const result = await db.query(
      `delete from inbound_deliveries where id in (
         select id from inbound_deliveries
         where created_at < now() - ($1::int * interval '1 day')
         order by created_at, id limit $2
       )`,
      [retention, size],
    );
    const count = result.rowCount ?? 0;
    removed += count;
    if (count < size) break;
  }
  return removed;
}

export async function pruneInboundDeliveriesIfDue(
  db: Queryable, state: { last: number }, now = Date.now(),
): Promise<number> {
  if (!Number.isFinite(now) || now - state.last < 60_000) return 0;
  const removed = await pruneInboundDeliveries(db);
  state.last = now;
  return removed;
}
