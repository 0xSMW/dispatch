import { ApiError, eventSchema, eventSendSchema, eventUpdateSchema, id, payloadIssues } from "@dispatchmail/core";
import {
  findBy,
  fireEvent,
  paginate,
  type Db,
  type FiredEvent,
  type PagingParams,
  type Queryable,
} from "@dispatchmail/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

type DefinitionRow = {
  id: string;
  name: string;
  schema: Record<string, string>;
  created_at: string;
  updated_at: string;
};

const definitionColumns = "id, name, schema, created_at, updated_at";

export function presentDefinition(row: DefinitionRow) {
  return { object: "event", ...row, schema: row.schema ?? {} };
}

export function presentFired(row: FiredEvent) {
  return {
    object: "fired_event",
    id: row.id,
    name: row.name,
    email: row.email,
    payload: row.data ?? {},
    request_id: row.request_id,
    created_at: row.created_at,
  };
}

export async function findDefinition(db: Queryable, tenantId: string, ref: string) {
  const row = await db.query<DefinitionRow>(
    `select ${definitionColumns} from event_schemas
     where tenant_id = $1 and (id = $2 or name = $2) and deleted_at is null
     limit 1`,
    [tenantId, ref],
  );
  return row.rows[0] ?? null;
}

// Throws validation_error when the payload breaks the event's stored schema. No schema, no check.
export async function checkPayload(db: Queryable, tenantId: string, name: string, payload: Record<string, unknown>) {
  const definition = await findDefinition(db, tenantId, name);
  if (!definition || definition.name !== name) return;
  const issues = payloadIssues(definition.schema ?? {}, payload);
  if (issues.length) throw new ApiError("validation_error", 422, issues.join("; "));
}

export function registerEvents(
  app: FastifyInstance,
  deps: {
    db: Db;
    paging: (request: FastifyRequest) => PagingParams;
  },
) {
  const { db, paging } = deps;

  async function definition(request: FastifyRequest) {
    const ref = (request.params as { id: string }).id;
    const row = await findDefinition(db, request.auth!.tenant_id, ref);
    if (!row) throw new ApiError("not_found", 404, "Event not found");
    return row;
  }

  app.post("/events", async (request) => {
    const input = eventSchema.parse(request.body);
    const row = await db.query<DefinitionRow>(
      `insert into event_schemas (id, tenant_id, name, schema)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, name) do update set
         schema = excluded.schema, deleted_at = null, created_at = now(), updated_at = now()
         where event_schemas.deleted_at is not null
       returning ${definitionColumns}`,
      [id("evdef"), request.auth!.tenant_id, input.name, JSON.stringify(input.schema)],
    );
    if (!row.rows[0]) throw new ApiError("conflict", 409, `Event ${input.name} already exists`);
    return presentDefinition(row.rows[0]);
  });

  app.get("/events", async (request) => {
    const page = await paginate<DefinitionRow>(db, "event_schemas", request.auth!.tenant_id, paging(request), {
      select: definitionColumns,
      deletedCol: "deleted_at",
    });
    return { object: page.object, has_more: page.has_more, data: page.data.map(presentDefinition) };
  });

  app.get("/events/:id", async (request) => presentDefinition(await definition(request)));

  app.patch("/events/:id", async (request) => {
    const input = eventUpdateSchema.parse(request.body);
    const current = await definition(request);
    const row = await db.query<DefinitionRow>(
      `update event_schemas set schema = $3, updated_at = now()
       where tenant_id = $1 and id = $2 and deleted_at is null
       returning ${definitionColumns}`,
      [request.auth!.tenant_id, current.id, JSON.stringify(input.schema)],
    );
    return presentDefinition(row.rows[0]!);
  });

  app.delete("/events/:id", async (request) => {
    const current = await definition(request);
    await db.query("update event_schemas set deleted_at = now(), updated_at = now() where tenant_id = $1 and id = $2", [
      request.auth!.tenant_id,
      current.id,
    ]);
    return { object: "event", id: current.id, deleted: true };
  });

  app.post("/events/send", async (request, reply) => {
    const name = (request.body as { event?: unknown } | undefined)?.event;
    if (typeof name === "string" && name.startsWith("@")) throw new ApiError("validation_error", 422, "Event names cannot start with @");
    const input = eventSendSchema.parse(request.body);
    const tenantId = request.auth!.tenant_id;
    const email = input.contact_id
      ? (
          await findBy<{ email: string }>(db, "contacts", tenantId, input.contact_id, {
            select: "email",
            errorMessage: "Contact not found",
          })
        ).email
      : (input.email ?? null);
    await checkPayload(db, tenantId, input.event, input.payload);

    // The event and its runs are stored here. The worker executes the runs, so this request
    // does a bounded amount of work however many automations the event starts.
    const fired = await fireEvent(db, tenantId, request.request_id, { name: input.event, email, data: input.payload });
    reply.code(202);
    return { object: "event", event: input.event, id: fired.event.id };
  });

  app.get("/fired-events", async (request) => {
    const page = await paginate<FiredEvent>(db, "custom_events", request.auth!.tenant_id, paging(request), {
      select: "id, request_id, name, email, data, created_at",
      deletedCol: "deleted_at",
      where: "name not like '@%'",
    });
    return { object: page.object, has_more: page.has_more, data: page.data.map(presentFired) };
  });

  app.get("/fired-events/:id", async (request) => {
    const row = await findBy<FiredEvent>(db, "custom_events", request.auth!.tenant_id, (request.params as { id: string }).id, {
      select: "id, request_id, name, email, data, created_at",
      errorMessage: "Event not found",
    });
    if (row.name.startsWith("@")) throw new ApiError("not_found", 404, "Event not found");
    return presentFired(row);
  });
}
