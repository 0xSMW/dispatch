import { ApiError, integrationSchema, integrationUpdateSchema, type IntegrationRecord } from "@dispatchmail/core";
import {
  createIntegration, deleteIntegration, getIntegration, integrationColumns, listDeliveries, paginate,
  presentIntegration, retryTx, rotateIntegration, updateIntegration, type Db, type PagingParams,
} from "@dispatchmail/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

// Public receiver registration is separate so management never bypasses authentication.
export function registerIntegrations(app: FastifyInstance, deps: {
  db: Db; secret: string; publicUrl: string; paging: (request: FastifyRequest) => PagingParams;
}) {
  const { db, secret, publicUrl, paging } = deps;
  const created = (result: Awaited<ReturnType<typeof createIntegration>>) => ({
    ...result.integration, token: result.token, url: `${publicUrl.replace(/\/$/, "")}/inbound/${encodeURIComponent(result.token)}`,
  });
  app.get("/integrations", async (request) => {
    const page = await paginate<IntegrationRecord>(db, { table: "integrations", tenantId: request.auth!.tenant_id, select: integrationColumns }, paging(request));
    return { ...page, data: page.data.map(presentIntegration) };
  });
  app.post("/integrations", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return created(await retryTx(db, (client) =>
      createIntegration(client, request.auth!.tenant_id, integrationSchema.parse(request.body), secret)));
  });
  app.get("/integrations/:id", async (request) =>
    getIntegration(db, request.auth!.tenant_id, (request.params as { id: string }).id));
  app.patch("/integrations/:id", async (request) => retryTx(db, (client) =>
    updateIntegration(client, request.auth!.tenant_id, (request.params as { id: string }).id, integrationUpdateSchema.parse(request.body), secret)));
  app.delete("/integrations/:id", async (request) => {
    const integrationId = (request.params as { id: string }).id;
    if (!await deleteIntegration(db, request.auth!.tenant_id, integrationId)) throw new ApiError("not_found", 404, "Integration not found");
    return { object: "integration", id: integrationId, deleted: true };
  });
  app.post("/integrations/:id/rotate", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return created(await retryTx(db, (client) =>
      rotateIntegration(client, request.auth!.tenant_id, (request.params as { id: string }).id)));
  });
  app.get("/integrations/:id/deliveries", async (request) => ({
    object: "list", has_more: false, data: (await listDeliveries(db, request.auth!.tenant_id,
      (request.params as { id: string }).id,
      (request.query as { limit?: string }).limit === undefined ? 20 : paging(request).limit)).map(({ tenant_id: _tenant, ...row }) => row),
  }));
}
