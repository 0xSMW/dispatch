import { ApiError, goalMetricsSchema, goalSchema, goalUpdateSchema } from "@dispatchmail/core";
import { createGoal, deleteGoal, getGoal, goalColumns, goalMetrics, paginate, presentGoal, retryTx, updateGoal, type Db, type PagingParams } from "@dispatchmail/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

export function registerGoals(app: FastifyInstance, deps: { db: Db; paging: (request: FastifyRequest) => PagingParams }) {
  const { db, paging } = deps;
  app.get("/goals", async (request) => {
    const page = await paginate<Awaited<ReturnType<typeof getGoal>>>(db,
      { table: "goals", tenantId: request.auth!.tenant_id, select: goalColumns }, paging(request));
    return { ...page, data: page.data.map(presentGoal) };
  });
  app.post("/goals", async (request) => presentGoal(await retryTx(db,
    (client) => createGoal(client, request.auth!.tenant_id, goalSchema.parse(request.body)))));
  app.get("/goals/:id", async (request) => presentGoal(await getGoal(db, request.auth!.tenant_id, (request.params as { id: string }).id)));
  app.patch("/goals/:id", async (request) => presentGoal(await retryTx(db,
    (client) => updateGoal(client, request.auth!.tenant_id, (request.params as { id: string }).id, goalUpdateSchema.parse(request.body)))));
  app.delete("/goals/:id", async (request) => {
    const goalId = (request.params as { id: string }).id;
    if (!await deleteGoal(db, request.auth!.tenant_id, goalId)) throw new ApiError("not_found", 404, "Goal not found");
    return { object: "goal", id: goalId, deleted: true };
  });
  app.get("/goals/:id/metrics", async (request) => goalMetrics(db, request.auth!.tenant_id,
    (request.params as { id: string }).id, goalMetricsSchema.parse(request.query)));
}
