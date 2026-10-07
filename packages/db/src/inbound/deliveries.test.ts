import { afterEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../index.js";
import type { IntegrationRecord } from "@dispatchmail/core";
import { pruneInboundDeliveries, pruneInboundDeliveriesIfDue, recordInboundFailure } from "./deliveries.js";

function fixture(...counts: number[]) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: counts.shift() ?? 0 }));
  return { query, db: { query } as unknown as Queryable };
}
const integration = {
  id: "integration_test", tenant_id: "tenant_test", secret: "synthetic_secret",
  token_hash: "synthetic_token", settings: { stripe_restricted_key: "synthetic_key" },
} as IntegrationRecord;

afterEach(() => vi.unstubAllEnvs());

describe("body-free inbound attempts and bounded retention (mocked database only)", () => {
  it.each(["invalid_signature", "invalid_payload", "processing_failed"] as const)("records only fixed %s with unique attempt identities", async reason => {
    const f = fixture();
    await recordInboundFailure(f.db, integration, "synthetic_request_body", reason);
    await recordInboundFailure(f.db, integration, "synthetic_request_body", reason);
    const calls = f.query.mock.calls as unknown as [string, unknown[]][];
    expect(calls[0]![0]).toContain("'failed', null, null");
    expect(calls[0]![1]).toEqual([
      expect.any(String), "tenant_test", "integration_test", expect.stringMatching(/^attempt:/), reason,
    ]);
    expect(calls[0]![1][3]).not.toBe(calls[1]![1][3]);
    for (const secret of ["synthetic_secret", "synthetic_token", "synthetic_key", "synthetic_request_body"]) {
      expect(JSON.stringify(calls)).not.toContain(secret);
    }
  });

  it("defends the failure allowlist at runtime and suppresses database exceptions", async () => {
    const f = fixture();
    await recordInboundFailure(f.db, integration, "request", "synthetic_raw_error" as never);
    expect((f.query.mock.calls as unknown as [string, unknown[]][])[0]![1].at(-1)).toBe("processing_failed");
    f.query.mockRejectedValue(new Error("synthetic_database_secret"));
    const error = await recordInboundFailure(f.db, integration, "request", "processing_failed").catch(error => error);
    expect(error).toMatchObject({ statusCode: 500, message: "Inbound delivery could not be recorded" });
    expect(error.cause).toBeUndefined();
  });

  it("prunes in ordered bounded batches and stops on a partial batch", async () => {
    const f = fixture(2, 2, 1);
    expect(await pruneInboundDeliveries(f.db, 30, 2, 4)).toBe(5);
    expect(f.query).toHaveBeenCalledTimes(3);
    const calls = f.query.mock.calls as unknown as [string, unknown[]][];
    expect(calls[0]![0]).toContain("order by created_at, id limit $2");
    expect(calls[0]![0]).toContain("created_at < now() - ($1::int * interval '1 day')");
    expect(calls[0]![1]).toEqual([30, 2]);
  });

  it("never exceeds the requested pass budget", async () => {
    const f = fixture(2, 2, 2);
    expect(await pruneInboundDeliveries(f.db, 30, 2, 2)).toBe(4);
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it("honors a zero pass budget without issuing a delete", async () => {
    const f = fixture();
    expect(await pruneInboundDeliveries(f.db, 30, 10_000, 0)).toBe(0);
    expect(f.query).not.toHaveBeenCalled();
  });

  it("caps oversized budgets and falls back safely for invalid retention settings", async () => {
    const f = fixture();
    f.query.mockResolvedValue({ rows: [], rowCount: 10_000 });
    expect(await pruneInboundDeliveries(f.db, NaN, Infinity, 1_000)).toBe(200_000);
    expect(f.query).toHaveBeenCalledTimes(20);
    expect((f.query.mock.calls as unknown as [string, unknown[]][])[0]![1]).toEqual([30, 10_000]);
    const small = fixture();
    await pruneInboundDeliveries(small.db, 0.5, 1_000_000, 1);
    expect((small.query.mock.calls as unknown as [string, unknown[]][])[0]![1]).toEqual([30, 10_000]);
  });

  it("uses LOG_RETENTION_DAYS with default 30 days", async () => {
    vi.stubEnv("LOG_RETENTION_DAYS", "7");
    const configured = fixture();
    await pruneInboundDeliveries(configured.db);
    expect((configured.query.mock.calls as unknown as [string, unknown[]][])[0]![1]).toEqual([7, 10_000]);
    vi.stubEnv("LOG_RETENTION_DAYS", "invalid");
    const fallback = fixture();
    await pruneInboundDeliveries(fallback.db);
    expect((fallback.query.mock.calls as unknown as [string, unknown[]][])[0]![1]).toEqual([30, 10_000]);
  });

  it("throttles to one minute and advances the cursor only after success", async () => {
    const f = fixture(3);
    const state = { last: 0 };
    expect(await pruneInboundDeliveriesIfDue(f.db, state, 59_999)).toBe(0);
    expect(f.query).not.toHaveBeenCalled();
    expect(await pruneInboundDeliveriesIfDue(f.db, state, 60_000)).toBe(3);
    expect(state.last).toBe(60_000);
    expect(await pruneInboundDeliveriesIfDue(f.db, state, 90_000)).toBe(0);
    f.query.mockRejectedValue(new Error("synthetic_failure"));
    await expect(pruneInboundDeliveriesIfDue(f.db, state, 120_000)).rejects.toThrow("synthetic_failure");
    expect(state.last).toBe(60_000);
  });
});
