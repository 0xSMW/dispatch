import {
  ApiError,
  broadcastRecipientsSchema,
  broadcastSchema,
  broadcastSendSchema,
  broadcastUpdateSchema,
} from "@dispatchmail/core";
import {
  broadcastAudience,
  broadcastColumns,
  cancelBroadcast,
  clickedLinks,
  createBroadcast,
  deleteBroadcast,
  duplicateBroadcast,
  findBroadcast,
  paginate,
  pauseBroadcast,
  presentBroadcast,
  presentBroadcastSummary,
  presentPage,
  presentRecipient,
  recipientFilter,
  resumeBroadcast,
  previewBroadcast,
  sendBroadcast,
  tx,
  updateBroadcast,
  type BroadcastRow,
  type Db,
  type PagingParams,
} from "@dispatchmail/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { broadcastWhere, type BroadcastQuery } from "./filters.js";
import { scheduleAt } from "./schedule.js";

export function registerBroadcasts(
  app: FastifyInstance,
  deps: {
    db: Db;
    paging: (request: FastifyRequest) => PagingParams;
  },
) {
  const { db, paging } = deps;
  const param = (request: FastifyRequest) => (request.params as { id: string }).id;

  app.post("/broadcasts", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const input = broadcastSchema.parse(request.body);
    const scheduled = scheduleAt(input.scheduled_at);
    // One transaction, so a send that is refused does not leave a draft behind.
    const row = await tx(db, async (client) => {
      const created = await createBroadcast(client, tenantId, request.request_id, input);
      if (!input.send) return created;
      return sendBroadcast(client, tenantId, created.id, { scheduledAt: scheduled, requestId: request.request_id });
    });
    return presentBroadcast(row);
  });

  app.get("/broadcasts", async (request) => {
    const filters = broadcastWhere(request.query as BroadcastQuery);
    const page = await paginate<BroadcastRow>(db, "broadcasts", request.auth!.tenant_id, paging(request), {
      select: broadcastColumns,
      deletedCol: "deleted_at",
      where: filters.where,
      params: filters.params,
    });
    return presentPage(page, presentBroadcastSummary);
  });

  app.get("/broadcasts/:id/audience", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const broadcast = await findBroadcast(db, tenantId, param(request));
    return broadcastAudience(db, tenantId, { segmentId: broadcast.segment_id, topicId: broadcast.topic_id });
  });

  app.get("/broadcasts/:id", async (request) => {
    return presentBroadcast(await findBroadcast(db, request.auth!.tenant_id, param(request)));
  });

  app.patch("/broadcasts/:id", async (request) => {
    const input = broadcastUpdateSchema.parse(request.body ?? {});
    return presentBroadcast(await updateBroadcast(db, request.auth!.tenant_id, param(request), input));
  });

  app.delete("/broadcasts/:id", async (request) => {
    const row = await deleteBroadcast(db, request.auth!.tenant_id, param(request));
    return { object: "broadcast", id: row.id, deleted: true };
  });

  app.post("/broadcasts/:id/send", async (request) => {
    const input = broadcastSendSchema.parse(request.body ?? {});
    const row = await sendBroadcast(db, request.auth!.tenant_id, param(request), {
      scheduledAt: scheduleAt(input.scheduled_at),
      requestId: request.request_id,
    });
    return { id: row.id };
  });

  // The saved broadcast as one recipient would get it, for a test send. `variables` replace
  // what the sample contact supplies, such as `contact` or `FIRST_NAME`.
  app.post("/broadcasts/:id/render", async (request) => {
    const body = (request.body ?? {}) as { variables?: unknown };
    const variables = body.variables;
    if (variables !== undefined && (variables === null || typeof variables !== "object" || Array.isArray(variables))) {
      throw new ApiError("validation_error", 422, "variables must be an object");
    }
    return { object: "broadcast_render", rendered: await previewBroadcast(db, request.auth!.tenant_id, param(request), (variables ?? {}) as Record<string, unknown>) };
  });

  app.post("/broadcasts/:id/cancel", async (request) => {
    return presentBroadcast(await cancelBroadcast(db, request.auth!.tenant_id, param(request)));
  });

  app.post("/broadcasts/:id/duplicate", async (request) => {
    const name = (request.body as { name?: unknown } | undefined)?.name;
    if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 120)) {
      throw new ApiError("validation_error", 400, "name must be 1 to 120 characters");
    }
    return presentBroadcast(await duplicateBroadcast(db, request.auth!.tenant_id, param(request), request.request_id, name));
  });

  app.post("/broadcasts/:id/pause", async (request) => {
    return presentBroadcast(await pauseBroadcast(db, request.auth!.tenant_id, param(request)));
  });

  app.post("/broadcasts/:id/resume", async (request) => {
    return presentBroadcast(await resumeBroadcast(db, request.auth!.tenant_id, param(request)));
  });

  app.get("/broadcasts/:id/recipients", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const broadcast = await findBroadcast(db, tenantId, param(request));
    const query = broadcastRecipientsSchema.parse(request.query ?? {});
    const filter = recipientFilter(broadcast.id, query);
    const page = await paginate<Parameters<typeof presentRecipient>[0]>(
      db,
      "broadcast_recipients br",
      tenantId,
      paging(request),
      {
        tenantCol: "br.tenant_id",
        createdCol: "br.created_at",
        idCol: "br.id",
        where: filter.where,
        params: filter.params,
        select: "br.id, br.contact_id, br.email, br.email_id, br.status, br.created_at",
      },
    );
    return presentPage(page, presentRecipient);
  });

  app.get("/broadcasts/:id/clicked-links", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const broadcast = await findBroadcast(db, tenantId, param(request));
    return pageRows(await clickedLinks(db, tenantId, broadcast.id), paging(request));
  });
}

// Pages an already-sorted list in memory with the same id cursors paginate() uses.
export function pageRows<T extends { id: string }>(rows: T[], paging: PagingParams) {
  const { limit = 20, after, before } = paging;
  if (after && before) throw new ApiError("validation_error", 400, "Use after or before, not both");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError("validation_error", 400, "limit must be between 1 and 100");
  }
  const cursor = after ?? before;
  const at = cursor ? rows.findIndex((row) => row.id === cursor) : -1;
  if (before) {
    const end = Math.max(0, at);
    const start = Math.max(0, end - limit);
    return { object: "list" as const, has_more: start > 0, data: rows.slice(start, end) };
  }
  const start = cursor ? (at < 0 ? rows.length : at + 1) : 0;
  return { object: "list" as const, has_more: start + limit < rows.length, data: rows.slice(start, start + limit) };
}
