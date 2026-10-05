import Fastify from "fastify";
import { beforeEach, expect, it, vi } from "vitest";
import type { Db } from "@dispatchmail/db";

const methods = vi.hoisted(() => ({
  createIntegration: vi.fn(), deleteIntegration: vi.fn(), getIntegration: vi.fn(), listDeliveries: vi.fn(),
  presentIntegration: vi.fn(value => value), paginate: vi.fn(), rotateIntegration: vi.fn(), updateIntegration: vi.fn(),
  retryTx: vi.fn(async (_db, run) => run({})), integrationColumns: "safe columns",
}));
vi.mock("@dispatchmail/db", () => methods);
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
