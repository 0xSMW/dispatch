import Fastify from "fastify";
import { beforeEach, expect, it, vi } from "vitest";
import type { IntegrationRecord } from "@dispatchmail/core";
import type { Db } from "@dispatchmail/db";

const methods = vi.hoisted(() => ({
  createIntegration: vi.fn(), deleteIntegration: vi.fn(), getIntegration: vi.fn(), listDeliveries: vi.fn(),
  rotateIntegration: vi.fn(), updateIntegration: vi.fn(),
  retryTx: vi.fn(async (_db, run) => run({})),
}));
// Keep real pagination, selected columns and redaction; unrelated management/history operations stay mocked.
vi.mock("@dispatchmail/db", async importOriginal => ({
  ...await importOriginal<typeof import("@dispatchmail/db")>(),
  ...methods,
}));
const { registerIntegrations } = await import("./integrations.js");
beforeEach(() => {
  vi.clearAllMocks();
  methods.listDeliveries.mockResolvedValue([]);
  methods.createIntegration.mockResolvedValue({ integration: { object: "integration", id: "int_1" }, token: "synthetic-token" });
  methods.rotateIntegration.mockResolvedValue({ integration: { object: "integration", id: "int_1" }, token: "replacement-token" });
});
async function harness() {
  const app = Fastify();
  app.addHook("preHandler", async request => {
    Object.assign(request, { auth: { tenant_id: "tenant_1" } });
  });
  registerIntegrations(app, { db: {} as Db, publicUrl: "https://api.example/", secret: "synthetic-app-secret",
    paging: request => ({ limit: Number((request.query as { limit?: string }).limit ?? 40) }) });
  return app;
}
it("lists only live tenant receivers across page boundaries without exposing credentials", async () => {
  const id = (n: number) => `int_${String(n).padStart(2, "0")}`;
  const rows: IntegrationRecord[] = [1, 2, 4, 5, 6, 7, 8, 9].map(n => ({
    id: id(n), tenant_id: n === 5 ? "tenant_other" : "tenant_1", provider: "stripe", name: `Receiver ${n}`, slug: "stripe",
    token_hash: `synthetic-token-hash-${n}`, secret: `synthetic-encrypted-secret-${n}`,
    settings: { map_plan: true, delete_contact: false, secret_header: "x-signature", stripe_restricted_key: n === 4 ? null : `synthetic-restricted-key-${n}` },
    last_received_at: null, created_at: n >= 5 ? "2026-10-05T00:00:00Z" : "2026-10-04T00:00:00Z",
    updated_at: "2026-10-05T00:00:00Z", deleted_at: [2, 7, 9].includes(n) ? "2026-10-06T00:00:00Z" : null,
  }));
  const compare = (a: IntegrationRecord, b: IntegrationRecord) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  const query = vi.fn(async (raw: string, params: unknown[]) => {
    const sql = raw.replace(/\s+/g, " ");
    expect(sql).toContain(" from integrations where tenant_id = $1 and deleted_at is null");
    const backward = sql.includes("order by created_at asc, id asc");
    const direction = backward ? "asc" : "desc";
    expect(sql).toContain(`order by created_at ${direction}, id ${direction} limit $${params.length}`);
    let matches = rows.filter(entry => entry.tenant_id === params[0] && entry.deleted_at === null);
    if (params.length === 3) {
      expect(sql).toContain(`(created_at, id) ${backward ? ">" : "<"} ( select created_at, id from integrations where tenant_id = $1 and id = $2 limit 1 )`);
      const cursor = rows.find(entry => entry.tenant_id === params[0] && entry.id === params[1]);
      matches = cursor ? matches.filter(entry => backward ? compare(entry, cursor) > 0 : compare(entry, cursor) < 0) : [];
    }
    return { rows: matches.sort((a, b) => (backward ? 1 : -1) * compare(a, b)).slice(0, Number(params.at(-1))) };
  });
  const app = Fastify();
  app.addHook("preHandler", async request => { request.auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" }; });
  registerIntegrations(app, { db: { query } as unknown as Db, secret: "offline", publicUrl: "https://api.example",
    paging: request => {
      const { limit, after, before } = request.query as { limit?: string; after?: string; before?: string };
      return { limit: Number(limit ?? 20), after, before };
    } });
  try {
    for (const { search, ids, has_more } of [
      { search: "limit=2", ids: [8, 6], has_more: true },
      { search: `limit=2&after=${id(6)}`, ids: [4, 1], has_more: false },
      { search: `limit=2&before=${id(1)}`, ids: [6, 4], has_more: true },
      { search: `limit=2&before=${id(4)}`, ids: [8, 6], has_more: false },
      { search: `limit=1&after=${id(8)}`, ids: [6], has_more: true },
      { search: `limit=2&after=${id(1)}`, ids: [], has_more: false },
      { search: `limit=2&after=${id(5)}`, ids: [], has_more: false },
      { search: `limit=2&after=${id(7)}`, ids: [6, 4], has_more: true },
    ]) {
      const response = await app.inject(`/integrations?${search}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ object: "list", has_more, data: ids.map(n => {
        const entry = rows.find(entry => entry.id === id(n))!;
        return { object: "integration", id: entry.id, provider: entry.provider, name: entry.name, slug: entry.slug,
          settings: { map_plan: true, delete_contact: false, secret_header: "x-signature" }, has_restricted_key: n !== 4,
          last_received_at: entry.last_received_at, created_at: entry.created_at, updated_at: entry.updated_at };
      }) });
      expect(response.body).not.toMatch(/synthetic-(?:token-hash|encrypted-secret|restricted-key)/);
      const params = new URLSearchParams(search);
      const cursor = params.get("after") ?? params.get("before");
      expect(query).toHaveBeenLastCalledWith(expect.any(String), ["tenant_1", ...(cursor ? [cursor] : []), Number(params.get("limit")) + 1]);
    }
    const calls = query.mock.calls.length;
    for (const search of ["limit=0", "limit=101", `limit=2&after=${id(8)}&before=${id(4)}`])
      expect((await app.inject(`/integrations?${search}`)).statusCode).toBe(400);
    expect(query.mock.calls).toHaveLength(calls);
  } finally { await app.close(); }
});

it("uses actual last20 history default rather than general dashboard page limit", async () => {
  const app = await harness();
  try {
    expect((await app.inject("/integrations/int_1/deliveries")).statusCode).toBe(200);
    expect(methods.listDeliveries).toHaveBeenLastCalledWith(expect.anything(), "tenant_1", "int_1", 20);
    await app.inject("/integrations/int_1/deliveries?limit=50");
    expect(methods.listDeliveries).toHaveBeenLastCalledWith(expect.anything(), "tenant_1", "int_1", 50);
  } finally { await app.close(); }
});
it("marks one-time create and rotate responses non-cacheable and composes the correct flat URL", async () => {
  const app = await harness();
  try {
    const created = await app.inject({ method: "POST", url: "/integrations", payload: {
      provider: "webhook", name: "App", secret: "synthetic",
    } });
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.json()).toEqual({ object: "integration", id: "int_1", token: "synthetic-token", url: "https://api.example/inbound/synthetic-token" });
    const rotated = await app.inject({ method: "POST", url: "/integrations/int_1/rotate" });
    expect(rotated.headers["cache-control"]).toBe("no-store");
    expect(rotated.json().url).toBe("https://api.example/inbound/replacement-token");
  } finally { await app.close(); }
});
