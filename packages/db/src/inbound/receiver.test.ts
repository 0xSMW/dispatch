import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../index.js";
import type { IntegrationRecord } from "@dispatchmail/core";
import { applyInbound } from "./application.js";
import { receiveInbound } from "./receiver.js";
import type { ReceiveInboundInput } from "./types.js";

vi.mock("./application.js", () => ({ applyInbound: vi.fn() }));

function integration(): IntegrationRecord {
  return {
    id: "integration_test", tenant_id: "tenant_test", provider: "stripe", slug: "stripe",
    name: "Synthetic", token_hash: "synthetic_hash", secret: "synthetic_ciphertext",
    settings: { map_plan: true, delete_contact: false },
    last_received_at: null, created_at: "2026-10-05", updated_at: "2026-10-05", deleted_at: null,
  };
}

function fixture() {
  const input: ReceiveInboundInput = {
    integration: integration(), tokenHash: "synthetic_hash", providerEventId: "evt_test",
    mapping: { action: "ignored", reason: "unsupported_event" }, requestId: "synthetic_request",
  };
  const calls: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> => {
    calls.push(sql);
    if (sql.startsWith("select") && sql.includes("from integrations")) return { rows: [integration()] };
    if (sql.startsWith("insert")) return { rows: [{ id: values?.[0] }] };
    return { rows: [] };
  });
  const audit = vi.fn(async (sql: string, _values?: unknown[]) => { calls.push(`audit:${sql}`); return { rows: [] }; });
  const release = vi.fn(() => { calls.push("release"); });
  const client = { query, release };
  const connect = vi.fn(async () => client);
  return { input, calls, query, audit, release, client, connect, db: { query: audit, connect } as unknown as Db };
}

beforeEach(() => {
  vi.mocked(applyInbound).mockReset();
  vi.mocked(applyInbound).mockResolvedValue({ status: "processed", eventName: "stripe.invoice.paid", contactId: "contact_test" });
});

describe("atomic inbound receiver (mocked database only)", () => {
  it("locks and reserves before applying with the same client, then finalizes before commit", async () => {
    const f = fixture();
    const result = await receiveInbound(f.db, f.input);
    expect(result).toEqual({ status: "processed", eventName: "stripe.invoice.paid", contactId: "contact_test" });
    expect(f.query.mock.calls[1]![0]).toContain("deleted_at is null for update");
    expect(f.query.mock.calls[2]![0]).toContain("on conflict (integration_id, provider_event_id) do nothing");
    expect(f.query.mock.calls[2]![1]).toEqual([expect.any(String), "tenant_test", "integration_test", "evt_test"]);
    expect(applyInbound).toHaveBeenCalledExactlyOnceWith(f.client, integration(), f.input.mapping, f.input.requestId);
    expect(f.query.mock.calls[3]![1]).toEqual([
      "tenant_test", expect.any(String), "processed", "stripe.invoice.paid", "contact_test", null,
    ]);
    expect(f.query.mock.calls[4]![0]).toContain("last_received_at = now()");
    expect(f.calls.at(-2)).toBe("commit");
    expect(f.calls.at(-1)).toBe("release");
    expect(f.audit).not.toHaveBeenCalled();
  });

  it.each(["processed", "ignored"] as const)("returns a successful %s duplicate without effects", async status => {
    const f = fixture();
    f.query.mockImplementation(async sql => {
      f.calls.push(sql);
      if (sql.includes("from integrations")) return { rows: [integration()] };
      if (sql.includes("from inbound_deliveries")) return { rows: [{
        status, event_name: status === "processed" ? "stripe.invoice.paid" : null,
        contact_id: status === "processed" ? "contact_test" : null,
        error: status === "ignored" ? "unsupported_event" : null,
      }] };
      return { rows: [] };
    });
    expect(await receiveInbound(f.db, f.input)).toEqual({
      status, eventName: status === "processed" ? "stripe.invoice.paid" : null,
      contactId: status === "processed" ? "contact_test" : null, duplicate: true,
      ...(status === "ignored" ? { reason: "unsupported_event" } : {}),
    });
    expect(applyInbound).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("update"))).toBe(false);
    expect(f.audit).not.toHaveBeenCalled();
  });

  it.each(["deleted", "rotated", "snapshot_token"] as const)("rejects an old authorization after %s", async mode => {
    const f = fixture();
    if (mode === "snapshot_token") f.input.integration.token_hash = "different_hash";
    f.query.mockImplementation(async sql => {
      f.calls.push(sql);
      return { rows: sql.includes("from integrations")
        ? mode === "deleted" ? [] : [{ ...integration(), token_hash: mode === "rotated" ? "new_hash" : "synthetic_hash" }]
        : [] };
    });
    await expect(receiveInbound(f.db, f.input)).rejects.toMatchObject({
      name: "not_found", statusCode: 404, message: "Integration not found",
    });
    expect(applyInbound).not.toHaveBeenCalled();
    expect(f.calls.slice(-2)).toEqual(["rollback", "release"]);
    expect(f.audit).not.toHaveBeenCalled();
  });

  it.each([
    { secret: "new_ciphertext" }, { settings: { map_plan: false } },
    { provider: "webhook", slug: "billing" },
  ])("requires retry if authenticated credentials or prepared settings change (%j)", async change => {
    const f = fixture();
    f.query.mockImplementation(async sql => ({
      rows: sql.includes("from integrations") ? [{ ...integration(), ...change }] : [],
    }));
    await expect(receiveInbound(f.db, f.input)).rejects.toMatchObject({
      statusCode: 503, message: "Inbound delivery could not be processed; retry",
    });
    expect(applyInbound).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
  });

  it("compares settings by value rather than JSON key order and ignores name edits", async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql, values) => ({
      rows: sql.includes("from integrations")
        ? [{ ...integration(), name: "Renamed", settings: { delete_contact: false, map_plan: true } }]
        : sql.startsWith("insert") ? [{ id: values?.[0] }] : [],
    }));
    await expect(receiveInbound(f.db, f.input)).resolves.toMatchObject({ status: "processed" });
  });

  it("rolls back failed application before writing a body-free distinct audit, then permits replay", async () => {
    const f = fixture();
    vi.mocked(applyInbound).mockRejectedValueOnce(new Error("synthetic_body_secret"));
    await expect(receiveInbound(f.db, f.input)).rejects.toMatchObject({
      name: "service_unavailable", statusCode: 503, message: "Inbound delivery could not be processed; retry",
    });
    expect(f.calls.findIndex(sql => sql.startsWith("audit:"))).toBeGreaterThan(f.calls.indexOf("release"));
    const [sql, values] = f.audit.mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).not.toContain("synthetic_body_secret");
    expect(values).toEqual([expect.any(String), "tenant_test", "integration_test", expect.stringMatching(/^attempt:/), "processing_failed"]);
    expect(JSON.stringify(values)).not.toContain(f.input.requestId);
    expect(JSON.stringify(values)).not.toContain(f.input.providerEventId);
    await expect(receiveInbound(f.db, f.input)).resolves.toMatchObject({ status: "processed" });
    expect(applyInbound).toHaveBeenCalledTimes(2);
  });

  it("retries only a rolled-back deadlock, with application and reservation in each attempt", async () => {
    const f = fixture();
    vi.mocked(applyInbound).mockRejectedValueOnce(Object.assign(new Error("synthetic_deadlock"), { code: "40P01" }));
    await receiveInbound(f.db, f.input);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(applyInbound).toHaveBeenCalledTimes(2);
    expect(f.calls.filter(sql => sql.startsWith("insert"))).toHaveLength(2);
    expect(f.calls.indexOf("rollback")).toBeLessThan(f.calls.lastIndexOf("begin"));
    expect(f.audit).not.toHaveBeenCalled();
  });

  it.each(["update inbound_deliveries", "update integrations", "commit"])("sanitizes %s failures and audit outages", async stage => {
    const f = fixture();
    const normal = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values) => {
      if (sql.startsWith(stage)) throw new Error("synthetic_SQL_secret");
      return normal(sql, values);
    });
    f.audit.mockRejectedValue(new Error("synthetic_audit_secret"));
    const error = await receiveInbound(f.db, f.input).catch(error => error);
    expect(error).toMatchObject({ statusCode: 503, message: "Inbound delivery could not be processed; retry" });
    expect(error.cause).toBeUndefined();
    expect(f.calls).toContain("rollback");
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.audit).toHaveBeenCalledOnce();
  });

  it("records ignored results in the same transaction and only allowlists reasons", async () => {
    const f = fixture();
    vi.mocked(applyInbound).mockResolvedValue({
      status: "ignored", eventName: null, contactId: null, reason: "synthetic_untrusted_body",
    });
    expect(await receiveInbound(f.db, f.input)).toEqual({
      status: "ignored", eventName: null, contactId: null, reason: "no_contact",
    });
    expect(f.query.mock.calls[3]![1]?.at(-1)).toBe("no_contact");
  });

  it.each(["", "attempt:synthetic"])("rejects invalid/reserved canonical identity %j without application", async providerEventId => {
    const f = fixture();
    f.input.providerEventId = providerEventId;
    await expect(receiveInbound(f.db, f.input)).rejects.toMatchObject({ statusCode: 503 });
    expect(applyInbound).not.toHaveBeenCalled();
    expect(f.audit).toHaveBeenCalledOnce();
  });
});
