import pg from "pg";
import { ApiError, id, list, type TemplateVariable } from "@dispatchmail/core";
export { settings, updateSettings } from "./settings.js";

const { Pool } = pg;

export type Db = pg.Pool;
export type Client = pg.PoolClient;
export type Queryable = {
  query: pg.Pool["query"];
};

export function connect(
  databaseUrl = process.env.DATABASE_URL ??
    "postgres://dispatch:dispatch@localhost:5432/dispatch",
) {
  return new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DB_POOL_SIZE ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function tx<T>(db: Db, run: (client: Client) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function publishedTemplate(
  client: Queryable,
  tenantId: string,
  templateIdOrAlias: string,
): Promise<{
  id: string;
  template_id: string;
  subject: string | null;
  html?: string | null;
  text?: string | null;
  variables: Array<string | TemplateVariable>;
  from_address?: string | null;
  reply_to?: string[] | null;
  track?: boolean | null;
}> {
  const row = await client.query(
    `select v.id, v.template_id, v.subject, v.html, v.text, v.variables, v.from_address, v.reply_to, t.track
     from templates t
     join template_versions v on v.id = t.published_version_id
     where t.tenant_id = $1 and t.deleted_at is null and (t.id = $2 or t.alias = $2 or t.name = $2)
     limit 1`,
    [tenantId, templateIdOrAlias],
  );
  if (!row.rows[0])
    throw new ApiError("not_found", 404, "Published template not found");
  return row.rows[0];
}

export type ContactUpsertInput =
  | string
  | {
      email: string;
      first_name?: string | null;
      last_name?: string | null;
      properties?: Record<string, unknown>;
      unsubscribed?: boolean;
    };

export async function upsertContact(
  client: Queryable,
  tenantId: string,
  contact: ContactUpsertInput,
) {
  const given = typeof contact === "string" ? { email: contact } : contact;
  const data = { ...given, email: given.email.toLowerCase() };
  const hasProps = data.properties !== undefined;
  const hasUnsub = data.unsubscribed !== undefined;
  const row = await client.query<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    properties: Record<string, unknown>;
    unsubscribed_at: string | null;
    created_at: string;
    updated_at: string;
    created: boolean;
  }>(
    `insert into contacts (id, tenant_id, email, first_name, last_name, properties, unsubscribed_at)
     values ($1, $2, $3, $4, $5, $6, case when $7::boolean then now() else null end)
     on conflict (tenant_id, email) do update set
       first_name = coalesce(excluded.first_name, contacts.first_name),
       last_name = coalesce(excluded.last_name, contacts.last_name),
       properties = case when $8::boolean then excluded.properties else contacts.properties end,
       unsubscribed_at = case when $9::boolean then (case when $7::boolean then now() else null end) else contacts.unsubscribed_at end,
       deleted_at = null,
       updated_at = now()
     returning id, email, first_name, last_name, properties, unsubscribed_at, created_at, updated_at,
       (contacts.xmax = 0) as created`,
    [
      id("contact"),
      tenantId,
      data.email,
      data.first_name ?? null,
      data.last_name ?? null,
      JSON.stringify(data.properties ?? {}),
      data.unsubscribed ?? false,
      hasProps,
      hasUnsub,
    ],
  );
  return row.rows[0];
}

export async function incrementUsage(
  client: Queryable,
  tenantId: string | null,
  key: string,
  count = 1,
) {
  const period = new Date().toISOString().slice(0, 10);
  await client.query(
    `insert into usage_counters (id, tenant_id, name, period, value)
     values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, name, period)
     do update set value = usage_counters.value + excluded.value, updated_at = now()`,
    [id("usage"), tenantId, key, period, count],
  );
}

const tablesWithoutDeletedAt = new Set([
  "emails",
  "webhooks",
  "received_emails",
  "logs",
]);

function deletedColumn(table: string, options: FindByOptions) {
  if (options.deletedCol !== undefined) return options.deletedCol;
  if (options.includeDeleted) return null;
  const name = table.trim().split(/\s+/)[0] ?? table;
  if (tablesWithoutDeletedAt.has(name)) return null;
  return "deleted_at";
}

export type FindByOptions = {
  select?: string | string[];
  tenantCol?: string;
  idCol?: string;
  deletedCol?: string | null;
  includeDeleted?: boolean;
  errorMessage?: string;
};

export async function findBy<T = Record<string, unknown>>(
  db: Queryable,
  table: string,
  tenantId: string,
  id: string,
  options: FindByOptions = {},
): Promise<T> {
  const selectCols = Array.isArray(options.select)
    ? options.select.join(", ")
    : (options.select ?? "*");
  const tenantCol = options.tenantCol ?? "tenant_id";
  const idCol = options.idCol ?? "id";
  let query = `select ${selectCols} from ${table} where ${tenantCol} = $1 and ${idCol} = $2`;
  const deletedCol = deletedColumn(table, options);
  if (deletedCol) {
    query += ` and ${deletedCol} is null`;
  }
  query += ` limit 1`;
  const res = await db.query(query, [tenantId, id]);
  if (!res.rows[0]) {
    const single = table.endsWith("ies")
      ? table.slice(0, -3) + "y"
      : table.endsWith("s")
        ? table.slice(0, -1)
        : table;
    const name = single.charAt(0).toUpperCase() + single.slice(1);
    throw new ApiError(
      "not_found",
      404,
      options.errorMessage ?? `${name} not found`,
    );
  }
  return res.rows[0] as T;
}

export async function softDelete(
  db: Queryable,
  table: string,
  tenantId: string,
  id: string,
  col = "deleted_at",
) {
  const sets =
    table === "domains"
      ? `${col} = now()`
      : `${col} = now(), updated_at = now()`;
  return db.query(
    `update ${table} set ${sets} where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
}

export type PaginateConfig = {
  table: string;
  tenantId: string;
  tenantCol?: string;
  select?: string | string[];
  where?: string;
  whereParams?: unknown[];
  params?: unknown[];
  groupBy?: string;
  orderBy?: string;
  orderDirection?: "asc" | "desc";
  cursorCol?: string;
  createdCol?: string;
  idCol?: string;
  deletedCol?: string | null;
};

export type PagingParams = {
  limit?: number;
  after?: string | null;
  before?: string | null;
};

export async function paginate<T = Record<string, unknown>>(
  db: Queryable,
  config: PaginateConfig,
  paging?: PagingParams,
): Promise<{ object: "list"; has_more: boolean; data: T[] }>;
export async function paginate<T = Record<string, unknown>>(
  db: Queryable,
  table: string,
  tenantId: string,
  paging?: PagingParams,
  options?: Omit<PaginateConfig, "table" | "tenantId">,
): Promise<{ object: "list"; has_more: boolean; data: T[] }>;
export async function paginate<T = Record<string, unknown>>(
  db: Queryable,
  tableOrConfig: string | PaginateConfig,
  tenantIdOrPaging?: string | PagingParams,
  pagingOrOptions?: PagingParams | Omit<PaginateConfig, "table" | "tenantId">,
  maybeOptions?: Omit<PaginateConfig, "table" | "tenantId">,
): Promise<{ object: "list"; has_more: boolean; data: T[] }> {
  let config: PaginateConfig;
  let paging: PagingParams = {};

  if (typeof tableOrConfig === "string") {
    config = {
      table: tableOrConfig,
      tenantId: tenantIdOrPaging as string,
      ...(maybeOptions ?? {}),
    };
    paging = (pagingOrOptions as PagingParams) ?? {};
  } else {
    config = tableOrConfig;
    paging = (tenantIdOrPaging as PagingParams) ?? {};
  }

  if (paging.after && paging.before) {
    throw new ApiError("validation_error", 400, "Use after or before, not both");
  }
  if (
    paging.limit !== undefined &&
    (!Number.isInteger(paging.limit) || paging.limit < 1 || paging.limit > 100)
  ) {
    throw new ApiError("validation_error", 400, "limit must be between 1 and 100");
  }
  const limit = paging.limit ?? 20;
  const selectCols = Array.isArray(config.select)
    ? config.select.join(", ")
    : (config.select ?? "*");
  const cursorCol = config.createdCol ?? config.cursorCol ?? "created_at";
  const idCol = config.idCol ?? "id";
  const tenantCol = config.tenantCol ?? "tenant_id";
  const deletedCol = config.deletedCol === undefined ? null : config.deletedCol;
  const newestFirst = (config.orderDirection ?? "desc") === "desc";

  const clauses: string[] = [`${tenantCol} = $1`];
  const params: unknown[] = [config.tenantId];
  if (deletedCol) clauses.push(`${deletedCol} is null`);
  if (config.where) clauses.push(`(${config.where})`);
  for (const param of config.whereParams ?? config.params ?? []) params.push(param);

  const forward = !paging.before;
  const descending = newestFirst === forward;
  const cursor = paging.after ?? paging.before;
  if (cursor) {
    params.push(cursor);
    clauses.push(
      `(${cursorCol}, ${idCol}) ${descending ? "<" : ">"} (
       select ${cursorCol}, ${idCol} from ${config.table}
       where ${tenantCol} = $1 and ${idCol} = $${params.length} limit 1
     )`,
    );
  }

  params.push(limit + 1);
  const direction = descending ? "desc" : "asc";
  const groupClause = config.groupBy ? ` group by ${config.groupBy}` : "";
  const query = `select ${selectCols} from ${config.table} where ${clauses.join(" and ")}${groupClause} order by ${cursorCol} ${direction}, ${idCol} ${direction} limit $${params.length}`;

  const res = await db.query(query, params);
  const rows = res.rows as T[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return list(forward ? page : page.reverse(), hasMore);
}

export * from "./accept.js";
export * from "./activity.js";
export * from "./audience.js";
export * from "./automations.js";
export * from "./broadcasts.js";
export * from "./emails.js";
export * from "./events.js";
export * from "./run-events.js";
export * from "./imports.js";
export * from "./keys.js";
export * from "./metrics.js";
export * from "./received.js";
export * from "./templates.js";
export * from "./tenants.js";
export * from "./unsubscribe.js";
