import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { id, keyHash } from "@dispatchmail/core";

const { query, connect, end, createStorage } = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  createStorage: vi.fn(() => ({})),
}));
vi.mock("@dispatchmail/db", async (original) => ({
  ...(await original<typeof import("@dispatchmail/db")>()),
  connect: () => ({ query, connect, end }),
}));
vi.mock("@dispatchmail/storage", async (original) => ({
  ...(await original<typeof import("@dispatchmail/storage")>()),
  createStorage,
}));

type Batch = unknown[][];
const committedLogs: Batch[] = [];
const committedUsage: Batch[] = [];
const releases = vi.fn();
const transactions: string[] = [];
const attemptedLatencies: number[][] = [];
const secret = "dm_test_telemetry_secret";
const tenantId = "tenant_telemetry";
const keyId = "key_telemetry";
const dashboard = "http://127.0.0.1:5173";
let server: typeof import("./server.js");

beforeAll(async () => {
  vi.stubEnv("API_KEY_PEPPER", "telemetry-test-pepper");
  vi.stubEnv("APP_SECRET", "telemetry-test-secret");
  vi.stubEnv("COUNTER_BACKEND", "postgres");
  vi.stubEnv("WORKER_RUNTIME", "local");
  vi.stubEnv("TELEMETRY_FLUSH_MS", "600000");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SES_PROVIDER", "fake");
  vi.stubEnv("STORAGE_BACKEND", "local");
  vi.stubEnv("CORS_ORIGINS", dashboard);
  vi.stubEnv("PUBLIC_URL", "http://127.0.0.1:3100");
  vi.stubEnv("APP_URL", dashboard);
  query.mockImplementation(async (raw: string, params: unknown[]) => {
    const sql = raw.replace(/\s+/g, " ").trim();
    if (sql.includes("from api_keys k")) {
      expect(params).toEqual([secret.slice(0, 12)]);
      expect(sql).toContain("k.revoked_at is null");
      return { rows: [{
        id: keyId, tenant_id: tenantId, hash: keyHash(secret, "telemetry-test-pepper"),
        scope: "full", domain_id: null, domain_name: null, last_used_at: new Date().toISOString(),
      }] };
    }
    if (sql.startsWith("insert into counters")) {
      expect(params[0]).toContain(tenantId);
      return { rows: [{ value: "1", window_id: params[1] }] };
    }
    if (sql.includes("from logs")) {
      expect(params).toEqual([tenantId]);
      return { rows: committedLogs.flatMap(batch => batch[0].map((logId, index) => ({
        id: logId, created_at: new Date().toISOString(), path: batch[5][index],
        method: batch[4][index], status: batch[6][index], user_agent: batch[3][index],
        tenant_id: batch[1][index],
      }))).filter(log => log.tenant_id === tenantId) };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  });
  connect.mockImplementation(async () => {
    let active = false;
    const logs: Batch[] = [];
    const usage: Batch[] = [];
    return {
      release: releases,
      query: async (raw: string, params?: Batch) => {
        const sql = raw.replace(/\s+/g, " ").trim();
        if (["begin", "commit", "rollback"].includes(sql)) {
          transactions.push(sql);
          if (sql === "begin") {
            expect(active).toBe(false);
            active = true;
          } else {
            expect(active).toBe(true);
            if (sql === "commit") {
              committedLogs.push(...logs);
              committedUsage.push(...usage);
            }
            logs.length = 0;
            usage.length = 0;
            active = false;
          }
          return { rows: [] };
        }
        expect(active).toBe(true);
        if (sql.startsWith("insert into logs")) {
          const latencies = params![7] as number[];
          attemptedLatencies.push([...latencies]);
          if (latencies.some(value => !Number.isFinite(value) || !Number.isInteger(value) || value < 0))
            throw Object.assign(new Error("invalid integer telemetry latency"), { code: "22P02" });
          logs.push(structuredClone(params!));
        } else if (sql.startsWith("insert into usage_counters")) {
          usage.push(structuredClone(params!));
        } else {
          throw new Error(`Unexpected transaction query: ${sql}`);
        }
        return { rows: [] };
      },
    };
  });
  server = await import("./server.js");
});

afterAll(async () => {
  try {
    await server?.close();
    expect(releases).toHaveBeenCalledTimes(connect.mock.calls.length);
    expect(end).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock("@dispatchmail/db");
    vi.doUnmock("@dispatchmail/storage");
  }
});

describe("actual server telemetry", () => {
  it("commits preflight and authenticated request logs and usage without rollback", async () => {
    const preflightId = id("req");
    const meId = id("req");
    const path = `/forms/${id("form")}`;
    const preflight = await server.app.inject({
      method: "OPTIONS", url: path, headers: {
        origin: dashboard, "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization", "x-request-id": preflightId, "user-agent": "",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(dashboard);
    expect(preflight.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(preflight.headers["access-control-allow-headers"]).toContain("authorization");
    expect.soft(preflight.headers["x-request-id"]).toBe(preflightId);
    expect.soft(preflight.headers).toMatchObject({
      "x-content-type-options": "nosniff", "x-frame-options": "DENY",
      "referrer-policy": "no-referrer", "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "dispatch-warning": "missing_user_agent",
    });
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    const me = await server.app.inject({
      method: "GET", url: "/me", headers: {
        authorization: `Bearer ${secret}`, "x-request-id": meId, "user-agent": "dispatch-telemetry-test",
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ tenant_id: tenantId, api_key_id: keyId, request_id: meId });
    expect(me.headers["ratelimit-remaining"]).toBeDefined();
    const exported = await server.app.inject({
      method: "GET", url: "/logs/export", headers: { authorization: `Bearer ${secret}` },
    });
    expect(exported.statusCode).toBe(200);
    expect.soft(attemptedLatencies.flat().every(value => Number.isFinite(value) && Number.isInteger(value) && value >= 0)).toBe(true);
    expect.soft(transactions).toEqual(["begin", "commit"]);
    expect(committedLogs).toHaveLength(1);
    const batch = committedLogs[0];
    expect(batch[1]).toEqual([null, tenantId]);
    expect(batch[2]).toEqual([preflightId, meId]);
    expect(batch[4]).toEqual(["OPTIONS", "GET"]);
    expect(batch[5]).toEqual([path, "/me"]);
    expect(batch[6]).toEqual([204, 200]);
    expect(batch[7]).toHaveLength(2);
    expect(attemptedLatencies).toEqual([batch[7]]);
    expect(batch[8]).toEqual([null, keyId]);
    expect(committedUsage).toHaveLength(1);
    expect(committedUsage[0].slice(1)).toEqual([[tenantId], ["api_requests"], [new Date().toISOString().slice(0, 10)], [1]]);
    expect(exported.json().logs).toEqual([expect.objectContaining({ endpoint: "/me", response_status: 200 })]);
  });

  it("keeps unauthenticated requests and foreign origins outside the existing boundaries", async () => {
    const calls = query.mock.calls.length;
    const unauthenticated = await server.app.inject({ method: "GET", url: "/me" });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ name: "missing_api_key" });
    const foreign = await server.app.inject({
      method: "OPTIONS", url: `/forms/${id("form")}`, headers: {
        origin: "https://dashboard.evil", "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization",
      },
    });
    expect(foreign.statusCode).toBe(401);
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
    expect(foreign.headers["access-control-allow-methods"]).toBeUndefined();
    expect(query.mock.calls).toHaveLength(calls);
  });
});
