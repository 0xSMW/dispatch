import "dotenv/config";
import cors from "@fastify/cors";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  ApiError,
  automationSchema,
  automationUpdateSchema,
  batchSchema,
  broadcastSchema,
  broadcastUpdateSchema,
  contactSchema,
  contactUpdateSchema,
  customEventSchema,
  customEventUpdateSchema,
  domainSchema,
  emailUpdateSchema,
  hash,
  id,
  inboundSchema,
  keyHash,
  keySchema,
  list,
  makeKey,
  membershipSchema,
  normalizeWebhookUrl,
  prepareTracking,
  renderSchema,
  renderTemplate,
  requestId,
  roleSchema,
  roleUpdateSchema,
  sendSchema,
  segmentContactSchema,
  segmentSchema,
  segmentUpdateSchema,
  sessionSchema,
  stableHash,
  subscriptionSchema,
  suppressionSchema,
  topicSchema,
  topicUpdateSchema,
  userSchema,
  userUpdateSchema,
  templateSchema,
  templateUpdateSchema,
  templateVersionSchema,
  toArray,
  webhookSchema
} from "@dispatch/core";
import { connect, tx } from "@dispatch/db";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import { Redis } from "ioredis";

type Auth = {
  tenant_id: string;
  api_key_id: string;
  scope: "full" | "send";
  user_id?: string;
  session_id?: string;
  permissions?: string[];
};

declare module "fastify" {
  interface FastifyRequest {
    request_id: string;
    started_at: number;
    auth?: Auth;
  }
}

type ApiKeyRow = {
  id: string;
  tenant_id: string;
  hash: string;
  scope: "full" | "send";
  last_used_at: string | null;
};

type LogRecord = {
  id: string;
  tenant_id: string | null;
  request_id: string;
  user_agent: string | null;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  api_key_id: string | null;
};

type AuditRecord = {
  id: string;
  tenant_id: string;
  request_id: string;
  actor_user_id: string | null;
  api_key_id: string;
  session_id: string | null;
  action: string;
  data: Record<string, unknown>;
};

const db = connect();
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 1
});
const pepper = process.env.API_KEY_PEPPER ?? "dev-pepper-change-before-deploy";
const storageRoot = process.env.STORAGE_DIR ?? ".dispatch/storage";
const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:3100";
const bodyLimit = Number(process.env.MAX_BODY_BYTES ?? 50 * 1024 * 1024);
const authCacheTtlMs = Number(process.env.AUTH_CACHE_TTL_MS ?? 5_000);
const domainCacheTtlMs = Number(process.env.DOMAIN_CACHE_TTL_MS ?? 5_000);
const app = Fastify({ logger: true, bodyLimit });
const apiKeyCache = new Map<string, { row: ApiKeyRow; expires_at: number }>();
const domainCache = new Map<string, number>();
const logQueue: LogRecord[] = [];
const auditQueue: AuditRecord[] = [];
const usageDeltas = new Map<string, { tenant_id: string; name: string; amount: number }>();
let telemetryFlushPromise: Promise<void> | null = null;

assertProductionConfig();

await app.register(cors, {
  origin(origin, callback) {
    callback(null, allowedOrigin(origin));
  },
  allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-request-id"],
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
});

setInterval(() => {
  void flushTelemetry();
}, Number(process.env.TELEMETRY_FLUSH_MS ?? 100)).unref();

app.addHook("onRequest", async (request, reply) => {
  request.started_at = Date.now();
  request.request_id = safeRequestId(request.headers["x-request-id"]?.toString());
  securityHeaders(reply);
  reply.header("x-request-id", request.request_id);
  if (!request.headers["user-agent"]) reply.header("dispatch-warning", "missing_user_agent");
});

app.addHook("preHandler", async (request, reply) => {
  const path = request.url.split("?")[0];
  if (
    request.url === "/health" ||
    (path === "/v1/setup" && publicSetupEnabled()) ||
    (request.method === "POST" && path === "/v1/sessions") ||
    path.startsWith("/open/") ||
    path.startsWith("/click/")
  ) {
    await publicRateLimit(request, reply, path);
    return;
  }
  await authenticate(request);
  await rateLimit(request, reply);
});

app.addHook("onResponse", async (request, reply) => {
  enqueueTelemetry(request, reply);
});

app.setErrorHandler((error, request, reply) => {
  const err = error as { statusCode?: number; message?: string };
  const zodIssues = (error as { issues?: Array<{ message?: string; path?: Array<string | number> }> }).issues;
  const errorName = error instanceof Error ? error.name : "";
  const isSchemaError = errorName === "ZodError" && Array.isArray(zodIssues);
  const statusCode = isSchemaError ? 400 : typeof err.statusCode === "number" ? err.statusCode : 500;
  const apiError =
    error instanceof ApiError
      ? error
      : isSchemaError
        ? new ApiError("validation_error", 400, zodIssues[0]?.message ?? "Invalid request")
      : new ApiError(statusCode >= 500 ? "internal_error" : "validation_error", statusCode, err.message ?? "Unexpected error");

  reply.status(apiError.statusCode).send({
    name: apiError.name,
    statusCode: apiError.statusCode,
    message: apiError.message,
    request_id: request.request_id
  });
});

app.get("/health", async () => {
  await db.query("select 1");
  await redis.ping();
  return { ok: true, provider: process.env.SES_PROVIDER ?? "fake" };
});

app.get("/v1/setup", async (request) => {
  const tenant = await db.query("select id, name from tenants order by created_at asc limit 1");
  const domain = await db.query("select id, name, status from domains order by created_at asc limit 1");
  const key = await db.query("select id, name, prefix, scope from api_keys where revoked_at is null order by created_at asc limit 1");
  const user = await db.query("select id, email, name from users where deactivated_at is null order by created_at asc limit 1");
  return {
    tenant: tenant.rows[0] ?? null,
    domain: domain.rows[0] ?? null,
    api_key: key.rows[0] ?? null,
    user: user.rows[0] ?? null,
    request_id: request.request_id
  };
});

app.post("/v1/sessions", async (request) => {
  if (!passwordlessSessionsEnabled()) {
    throw new ApiError("forbidden", 403, "Passwordless local sessions are disabled");
  }
  const input = sessionSchema.parse(request.body);
  const apiKey = await validKey(input.api_key);
  if (!apiKey || apiKey.scope !== "full") throw new ApiError("invalid_api_key", 401, "Invalid API key");
  const user = await db.query<{ id: string; email: string; name: string; role: string; permissions: string[] }>(
    `select u.id, u.email, u.name, r.name as role, r.permissions
     from users u
     join memberships m on m.user_id = u.id and m.disabled_at is null
     join roles r on r.id = m.role_id and r.deleted_at is null
     where u.tenant_id = $1 and u.email = $2 and u.deactivated_at is null
     limit 1`,
    [apiKey.tenant_id, input.email]
  );
  if (!user.rows[0]) throw new ApiError("not_found", 404, "User not found");
  const token = `sess_${makeKey().secret}`;
  const row = await db.query(
    `insert into sessions (id, tenant_id, user_id, token_hash, expires_at)
     values ($1, $2, $3, $4, now() + interval '30 days')
     returning id, user_id, expires_at, created_at`,
    [id("sess"), apiKey.tenant_id, user.rows[0].id, hash(token)]
  );
  return { session: { ...row.rows[0], token }, user: user.rows[0], request_id: request.request_id };
});

app.get("/v1/me", async (request) => {
  requireScope(request, "full");
  if (!request.auth!.user_id) {
    return { tenant_id: request.auth!.tenant_id, api_key_id: request.auth!.api_key_id, scope: request.auth!.scope, request_id: request.request_id };
  }
  const row = await db.query(
    `select u.id, u.email, u.name, r.name as role, r.permissions
     from users u
     join memberships m on m.user_id = u.id and m.disabled_at is null
     join roles r on r.id = m.role_id and r.deleted_at is null
     where u.tenant_id = $1 and u.id = $2`,
    [request.auth!.tenant_id, request.auth!.user_id]
  );
  return { user: row.rows[0], session_id: request.auth!.session_id, request_id: request.request_id };
});

app.get("/v1/users", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select id, email, name, created_at, updated_at, deactivated_at
     from users
     where tenant_id = $1
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.post("/v1/users", async (request) => {
  requireScope(request, "full");
  const input = userSchema.parse(request.body);
  const row = await db.query(
    `insert into users (id, tenant_id, email, name)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, email) do update set name = excluded.name, deactivated_at = null, updated_at = now()
     returning id, email, name, created_at, updated_at, deactivated_at`,
    [id("user"), request.auth!.tenant_id, input.email, input.name]
  );
  return { user: row.rows[0], request_id: request.request_id };
});

app.patch("/v1/users/:id", async (request) => {
  requireScope(request, "full");
  const userId = (request.params as { id: string }).id;
  const input = userUpdateSchema.parse(request.body);
  const current = await db.query("select * from users where tenant_id = $1 and id = $2", [request.auth!.tenant_id, userId]);
  if (!current.rows[0]) throw new ApiError("not_found", 404, "User not found");
  const row = await db.query(
    `update users set email = $3, name = $4,
       deactivated_at = case
         when $5::boolean is null then deactivated_at
         when $5 then null
         else coalesce(deactivated_at, now())
       end,
       updated_at = now()
     where tenant_id = $1 and id = $2
     returning id, email, name, created_at, updated_at, deactivated_at`,
    [request.auth!.tenant_id, userId, input.email ?? current.rows[0].email, input.name ?? current.rows[0].name, input.active ?? null]
  );
  return { user: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/users/:id", async (request) => {
  requireScope(request, "full");
  const userId = (request.params as { id: string }).id;
  await db.query("update users set deactivated_at = now(), updated_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    userId
  ]);
  return { deleted: true, id: userId, request_id: request.request_id };
});

app.get("/v1/roles", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select id, name, permissions, created_at, updated_at
     from roles
     where tenant_id = $1 and deleted_at is null
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.post("/v1/roles", async (request) => {
  requireScope(request, "full");
  const input = roleSchema.parse(request.body);
  const row = await db.query(
    `insert into roles (id, tenant_id, name, permissions)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, name) do update set permissions = excluded.permissions, deleted_at = null, updated_at = now()
     returning id, name, permissions, created_at, updated_at`,
    [id("role"), request.auth!.tenant_id, input.name, JSON.stringify(input.permissions)]
  );
  return { role: row.rows[0], request_id: request.request_id };
});

app.patch("/v1/roles/:id", async (request) => {
  requireScope(request, "full");
  const roleId = (request.params as { id: string }).id;
  const input = roleUpdateSchema.parse(request.body);
  const current = await db.query("select * from roles where tenant_id = $1 and id = $2 and deleted_at is null", [
    request.auth!.tenant_id,
    roleId
  ]);
  if (!current.rows[0]) throw new ApiError("not_found", 404, "Role not found");
  const row = await db.query(
    `update roles set name = $3, permissions = $4, updated_at = now()
     where tenant_id = $1 and id = $2
     returning id, name, permissions, created_at, updated_at`,
    [
      request.auth!.tenant_id,
      roleId,
      input.name ?? current.rows[0].name,
      JSON.stringify(input.permissions ?? current.rows[0].permissions)
    ]
  );
  return { role: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/roles/:id", async (request) => {
  requireScope(request, "full");
  const roleId = (request.params as { id: string }).id;
  await db.query("update roles set deleted_at = now(), updated_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    roleId
  ]);
  return { deleted: true, id: roleId, request_id: request.request_id };
});

app.get("/v1/memberships", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select m.id, m.user_id, u.email, u.name, m.role_id, r.name as role, m.created_at, m.updated_at
     from memberships m
     join users u on u.tenant_id = m.tenant_id and u.id = m.user_id
     join roles r on r.tenant_id = m.tenant_id and r.id = m.role_id
     where m.tenant_id = $1 and m.disabled_at is null
       and ($3::timestamptz is null or m.created_at > $3)
       and ($4::timestamptz is null or m.created_at < $4)
     order by m.created_at desc limit $2`
  );
});

app.post("/v1/memberships", async (request) => {
  requireScope(request, "full");
  const input = membershipSchema.parse(request.body);
  const refs = await db.query(
    `select
       exists(select 1 from users where tenant_id = $1 and id = $2 and deactivated_at is null) as user_exists,
       exists(select 1 from roles where tenant_id = $1 and id = $3 and deleted_at is null) as role_exists`,
    [request.auth!.tenant_id, input.user_id, input.role_id]
  );
  if (!refs.rows[0]?.user_exists || !refs.rows[0]?.role_exists) {
    throw new ApiError("not_found", 404, "User or role not found");
  }
  const row = await db.query(
    `insert into memberships (id, tenant_id, user_id, role_id)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, user_id) do update set role_id = excluded.role_id, disabled_at = null, updated_at = now()
     returning id, user_id, role_id, created_at, updated_at`,
    [id("member"), request.auth!.tenant_id, input.user_id, input.role_id]
  );
  return { membership: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/memberships/:id", async (request) => {
  requireScope(request, "full");
  const membershipId = (request.params as { id: string }).id;
  await db.query("update memberships set disabled_at = now(), updated_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    membershipId
  ]);
  return { deleted: true, id: membershipId, request_id: request.request_id };
});

app.get("/v1/sessions", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select s.id, s.user_id, u.email, s.expires_at, s.last_used_at, s.created_at, s.revoked_at
     from sessions s
     join users u on u.id = s.user_id
     where s.tenant_id = $1
       and ($3::timestamptz is null or s.created_at > $3)
       and ($4::timestamptz is null or s.created_at < $4)
     order by s.created_at desc limit $2`
  );
});

app.delete("/v1/sessions/:id", async (request) => {
  requireScope(request, "full");
  const sessionId = (request.params as { id: string }).id;
  await db.query("update sessions set revoked_at = now() where tenant_id = $1 and id = $2", [request.auth!.tenant_id, sessionId]);
  return { deleted: true, id: sessionId, request_id: request.request_id };
});

app.get("/v1/audit-logs", async (request) => {
  requireScope(request, "full");
  await flushTelemetry();
  const query = request.query as { action?: string };
  return pageRows(
    request,
    `select a.id, a.request_id, a.actor_user_id, u.email as actor_email, a.api_key_id, a.session_id,
       a.action, a.target_type, a.target_id, a.data, a.created_at
     from audit_logs a
     left join users u on u.tenant_id = a.tenant_id and u.id = a.actor_user_id
     where a.tenant_id = $1
       and ($3::timestamptz is null or a.created_at > $3)
       and ($4::timestamptz is null or a.created_at < $4)
       and ($5::text is null or a.action like '%' || $5 || '%')
     order by a.created_at desc limit $2`,
    [query.action ?? null]
  );
});

app.post("/v1/api-keys", async (request) => {
  requireScope(request, "full");
  const input = keySchema.parse(request.body);
  const { secret, prefix } = makeKey();
  const row = await db.query(
    `insert into api_keys (id, tenant_id, name, prefix, hash, scope)
     values ($1, $2, $3, $4, $5, $6)
     returning id, name, prefix, scope, created_at`,
    [id("key"), request.auth!.tenant_id, input.name, prefix, keyHash(secret, pepper), input.scope]
  );
  apiKeyCache.clear();
  return { api_key: { ...row.rows[0], secret }, request_id: request.request_id };
});

app.get("/v1/api-keys", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select id, name, prefix, scope, last_used_at, created_at, revoked_at
     from api_keys
     where tenant_id = $1
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.delete("/v1/api-keys/:id", async (request) => {
  requireScope(request, "full");
  const keyId = (request.params as { id: string }).id;
  await db.query("update api_keys set revoked_at = now() where tenant_id = $1 and id = $2", [request.auth!.tenant_id, keyId]);
  apiKeyCache.clear();
  return { deleted: true, id: keyId, request_id: request.request_id };
});

app.post("/v1/domains", async (request) => {
  requireScope(request, "full");
  const input = domainSchema.parse(request.body);
  const records = domainRecords(input.name, input.region);
  const row = await db.query(
    `insert into domains (id, tenant_id, name, region, status, records)
     values ($1, $2, $3, $4, 'pending', $5)
     on conflict (tenant_id, name) do update set region = excluded.region, records = excluded.records, deleted_at = null
     returning id, name, region, status, records, checked_at, created_at`,
    [id("domain"), request.auth!.tenant_id, input.name, input.region, JSON.stringify(records)]
  );
  clearDomainCache(request.auth!.tenant_id);
  return { domain: row.rows[0], request_id: request.request_id };
});

app.get("/v1/domains", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select id, name, region, status, records, checked_at, created_at
     from domains
     where tenant_id = $1 and deleted_at is null
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.get("/v1/domains/:id", async (request) => {
  requireScope(request, "full");
  const domain = await findDomain(request);
  return { domain, request_id: request.request_id };
});

app.patch("/v1/domains/:id", async (request) => {
  requireScope(request, "full");
  const domainId = (request.params as { id: string }).id;
  const input = domainSchema.partial().parse(request.body);
  const current = await findDomain(request);
  const name = input.name ?? current.name;
  const region = input.region ?? current.region;
  const row = await db.query(
    `update domains set name = $3, region = $4, records = $5
     where tenant_id = $1 and id = $2 returning id, name, region, status, records, checked_at, created_at`,
    [request.auth!.tenant_id, domainId, name, region, JSON.stringify(domainRecords(name, region))]
  );
  clearDomainCache(request.auth!.tenant_id);
  return { domain: row.rows[0], request_id: request.request_id };
});

app.post("/v1/domains/:id/verify", async (request) => {
  requireScope(request, "full");
  const domainId = (request.params as { id: string }).id;
  const row = await db.query(
    `update domains set status = 'verified', checked_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning id, name, region, status, records, checked_at, created_at`,
    [request.auth!.tenant_id, domainId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Domain not found");
  clearDomainCache(request.auth!.tenant_id);
  return { domain: row.rows[0], request_id: request.request_id };
});

app.get("/v1/domains/:id/doctor", async (request) => {
  requireScope(request, "full");
  const domain = await findDomain(request);
  return {
    domain: domain.id,
    checks: domain.records.map((record: Record<string, unknown>) => ({
      name: record.name,
      type: record.type,
      expected: record.value,
      status: domain.status === "verified" ? "ok" : "pending"
    })),
    request_id: request.request_id
  };
});

app.delete("/v1/domains/:id", async (request) => {
  requireScope(request, "full");
  const domainId = (request.params as { id: string }).id;
  await db.query("update domains set deleted_at = now() where tenant_id = $1 and id = $2", [request.auth!.tenant_id, domainId]);
  clearDomainCache(request.auth!.tenant_id);
  return { deleted: true, id: domainId, request_id: request.request_id };
});

app.post("/v1/templates", async (request) => {
  requireScope(request, "full");
  const input = templateSchema.parse(request.body);
  return tx(db, async (client) => {
    const template = await client.query(
      `insert into templates (id, tenant_id, name, alias)
       values ($1, $2, $3, $4)
       returning id, name, alias, published_version_id, created_at, updated_at`,
      [id("template"), request.auth!.tenant_id, input.name, input.alias ?? null]
    );
    const version = await client.query(
      `insert into template_versions (id, tenant_id, template_id, subject, html, text, variables, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       returning id, subject, html, text, variables, created_at, published_at`,
      [
        id("version"),
        request.auth!.tenant_id,
        template.rows[0].id,
        input.subject,
        input.html ?? null,
        input.text ?? null,
        JSON.stringify(input.variables)
      ]
    );
    await client.query("update templates set published_version_id = $3, updated_at = now() where tenant_id = $1 and id = $2", [
      request.auth!.tenant_id,
      template.rows[0].id,
      version.rows[0].id
    ]);
    return {
      template: { ...template.rows[0], published_version_id: version.rows[0].id, version: version.rows[0] },
      request_id: request.request_id
    };
  });
});

app.get("/v1/templates", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select t.id, t.name, t.alias, t.published_version_id, t.created_at, t.updated_at,
       v.subject, v.variables
     from templates t
     left join template_versions v on v.id = t.published_version_id
     where t.tenant_id = $1 and t.deleted_at is null
       and ($3::timestamptz is null or t.created_at > $3)
       and ($4::timestamptz is null or t.created_at < $4)
     order by t.created_at desc limit $2`
  );
});

app.get("/v1/templates/:id", async (request) => {
  requireScope(request, "full");
  const template = await findTemplate(request);
  return { template, request_id: request.request_id };
});

app.patch("/v1/templates/:id", async (request) => {
  requireScope(request, "full");
  const templateId = (request.params as { id: string }).id;
  const input = templateUpdateSchema.parse(request.body);
  const current = await findTemplate(request);
  const row = await db.query(
    `update templates set name = $3, alias = $4, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning id, name, alias, published_version_id, created_at, updated_at`,
    [request.auth!.tenant_id, templateId, input.name ?? current.name, input.alias === undefined ? current.alias : input.alias]
  );
  return { template: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/templates/:id", async (request) => {
  requireScope(request, "full");
  const templateId = (request.params as { id: string }).id;
  await db.query("update templates set deleted_at = now(), updated_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    templateId
  ]);
  return { deleted: true, id: templateId, request_id: request.request_id };
});

app.post("/v1/templates/:id/versions", async (request) => {
  requireScope(request, "full");
  const templateId = (request.params as { id: string }).id;
  const input = templateVersionSchema.parse(request.body);
  await findTemplate(request);
  const version = await db.query(
    `insert into template_versions (id, tenant_id, template_id, subject, html, text, variables)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, template_id, subject, html, text, variables, created_at, published_at`,
    [id("version"), request.auth!.tenant_id, templateId, input.subject, input.html ?? null, input.text ?? null, JSON.stringify(input.variables)]
  );
  return { version: version.rows[0], request_id: request.request_id };
});

app.post("/v1/templates/:id/publish", async (request) => {
  requireScope(request, "full");
  const templateId = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as { version_id?: string };
  await findTemplate(request);
  const version = await db.query(
    `select id from template_versions
     where tenant_id = $1 and template_id = $2 and ($3::text is null or id = $3)
     order by created_at desc limit 1`,
    [request.auth!.tenant_id, templateId, body.version_id ?? null]
  );
  if (!version.rows[0]) throw new ApiError("not_found", 404, "Template version not found");
  await db.query("update template_versions set published_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    version.rows[0].id
  ]);
  const template = await db.query(
    `update templates set published_version_id = $3, updated_at = now()
     where tenant_id = $1 and id = $2
     returning id, name, alias, published_version_id, created_at, updated_at`,
    [request.auth!.tenant_id, templateId, version.rows[0].id]
  );
  return { template: template.rows[0], request_id: request.request_id };
});

app.post("/v1/templates/:id/render", async (request) => {
  requireScope(request, "full");
  const input = renderSchema.parse(request.body);
  const template = await findTemplate(request);
  if (!template.version) throw new ApiError("conflict", 409, "Template has no published version");
  return {
    rendered: renderTemplate(template.version, input.variables),
    request_id: request.request_id
  };
});

app.post("/v1/templates/:id/duplicate", async (request) => {
  requireScope(request, "full");
  const source = await findTemplate(request);
  if (!source.version) throw new ApiError("conflict", 409, "Template has no published version");
  const body = (request.body ?? {}) as { name?: string; alias?: string };
  const input = templateSchema.parse({
    name: body.name ?? `${source.name} copy`,
    alias: body.alias,
    subject: source.version.subject,
    html: source.version.html ?? undefined,
    text: source.version.text ?? undefined,
    variables: source.version.variables ?? []
  });
  return tx(db, async (client) => {
    const template = await client.query(
      `insert into templates (id, tenant_id, name, alias)
       values ($1, $2, $3, $4)
       returning id, name, alias, published_version_id, created_at, updated_at`,
      [id("template"), request.auth!.tenant_id, input.name, input.alias ?? null]
    );
    const version = await client.query(
      `insert into template_versions (id, tenant_id, template_id, subject, html, text, variables, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       returning id, subject, html, text, variables, created_at, published_at`,
      [
        id("version"),
        request.auth!.tenant_id,
        template.rows[0].id,
        input.subject,
        input.html ?? null,
        input.text ?? null,
        JSON.stringify(input.variables)
      ]
    );
    await client.query("update templates set published_version_id = $3, updated_at = now() where tenant_id = $1 and id = $2", [
      request.auth!.tenant_id,
      template.rows[0].id,
      version.rows[0].id
    ]);
    return {
      template: { ...template.rows[0], published_version_id: version.rows[0].id, version: version.rows[0] },
      request_id: request.request_id
    };
  });
});

app.post("/v1/contacts", async (request) => {
  requireScope(request, "full");
  const input = contactSchema.parse(request.body);
  const row = await db.query(
    `insert into contacts (id, tenant_id, email, first_name, last_name, properties, unsubscribed_at)
     values ($1, $2, $3, $4, $5, $6, case when $7 then now() else null end)
     on conflict (tenant_id, email) do update set
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       properties = excluded.properties,
       unsubscribed_at = excluded.unsubscribed_at,
       deleted_at = null,
       updated_at = now()
     returning id, email, first_name, last_name, properties, unsubscribed_at, created_at, updated_at`,
    [
      id("contact"),
      request.auth!.tenant_id,
      input.email,
      input.first_name ?? null,
      input.last_name ?? null,
      JSON.stringify(input.properties),
      input.unsubscribed
    ]
  );
  return { contact: row.rows[0], request_id: request.request_id };
});

app.get("/v1/contacts", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select id, email, first_name, last_name, properties, unsubscribed_at, created_at, updated_at
     from contacts
     where tenant_id = $1 and deleted_at is null
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.get("/v1/contacts/:id", async (request) => {
  requireScope(request, "full");
  const contact = await findContact(request);
  return { contact, request_id: request.request_id };
});

app.patch("/v1/contacts/:id", async (request) => {
  requireScope(request, "full");
  const contactId = (request.params as { id: string }).id;
  const input = contactUpdateSchema.parse(request.body);
  const current = await findContact(request);
  const row = await db.query(
    `update contacts set
       first_name = $3,
       last_name = $4,
       properties = $5,
       unsubscribed_at = case when $6::boolean is null then unsubscribed_at when $6 then now() else null end,
       updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning id, email, first_name, last_name, properties, unsubscribed_at, created_at, updated_at`,
    [
      request.auth!.tenant_id,
      contactId,
      input.first_name ?? current.first_name,
      input.last_name ?? current.last_name,
      JSON.stringify(input.properties ?? current.properties ?? {}),
      input.unsubscribed ?? null
    ]
  );
  return { contact: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/contacts/:id", async (request) => {
  requireScope(request, "full");
  const contactId = (request.params as { id: string }).id;
  await db.query("update contacts set deleted_at = now(), updated_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    contactId
  ]);
  return { deleted: true, id: contactId, request_id: request.request_id };
});

app.post("/v1/topics", async (request) => {
  requireScope(request, "full");
  const input = topicSchema.parse(request.body);
  const row = await db.query(
    `insert into topics (id, tenant_id, name, key, default_status)
     values ($1, $2, $3, $4, $5)
     returning id, name, key, default_status, created_at, updated_at`,
    [id("topic"), request.auth!.tenant_id, input.name, input.key ?? slug(input.name), input.default_status]
  );
  return { topic: row.rows[0], request_id: request.request_id };
});

app.get("/v1/topics", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select id, name, key, default_status, created_at, updated_at
     from topics
     where tenant_id = $1 and deleted_at is null
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.get("/v1/topics/:id", async (request) => {
  requireScope(request, "full");
  const topic = await findTopic(request);
  return { topic, request_id: request.request_id };
});

app.patch("/v1/topics/:id", async (request) => {
  requireScope(request, "full");
  const topicId = (request.params as { id: string }).id;
  const input = topicUpdateSchema.parse(request.body);
  const current = await findTopic(request);
  const row = await db.query(
    `update topics set name = $3, key = $4, default_status = $5, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning id, name, key, default_status, created_at, updated_at`,
    [
      request.auth!.tenant_id,
      topicId,
      input.name ?? current.name,
      input.key ?? current.key,
      input.default_status ?? current.default_status
    ]
  );
  return { topic: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/topics/:id", async (request) => {
  requireScope(request, "full");
  const topicId = (request.params as { id: string }).id;
  await db.query("update topics set deleted_at = now(), updated_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    topicId
  ]);
  return { deleted: true, id: topicId, request_id: request.request_id };
});

app.get("/v1/topics/:id/subscriptions", async (request) => {
  requireScope(request, "full");
  const topic = await findTopic(request);
  const paging = page(request);
  const rows = await db.query(
    `select s.id, s.status, s.created_at, s.updated_at,
       c.id as contact_id, c.email, c.first_name, c.last_name
     from topic_subscriptions s
     join contacts c on c.id = s.contact_id
     where s.tenant_id = $1 and s.topic_id = $2 and c.deleted_at is null
       and ($4::timestamptz is null or s.created_at > $4)
       and ($5::timestamptz is null or s.created_at < $5)
     order by s.created_at desc limit $3`,
    [request.auth!.tenant_id, topic.id, paging.fetch, paging.after, paging.before]
  );
  return { ...pageList(rows.rows, paging), request_id: request.request_id };
});

app.post("/v1/topics/:id/subscriptions", async (request) => {
  requireScope(request, "full");
  const topic = await findTopic(request);
  const input = subscriptionSchema.parse(request.body);
  const contact = await upsertContact(request.auth!.tenant_id, input.email);
  const row = await db.query(
    `insert into topic_subscriptions (id, tenant_id, topic_id, contact_id, status)
     values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, topic_id, contact_id)
     do update set status = excluded.status, updated_at = now()
     returning id, topic_id, contact_id, status, created_at, updated_at`,
    [id("sub"), request.auth!.tenant_id, topic.id, contact.id, input.status]
  );
  return { subscription: { ...row.rows[0], email: contact.email }, request_id: request.request_id };
});

app.post("/v1/segments", async (request) => {
  requireScope(request, "full");
  const input = segmentSchema.parse(request.body);
  const row = await db.query(
    `insert into segments (id, tenant_id, name, description)
     values ($1, $2, $3, $4)
     returning id, name, description, created_at, updated_at`,
    [id("segment"), request.auth!.tenant_id, input.name, input.description ?? null]
  );
  return { segment: row.rows[0], request_id: request.request_id };
});

app.get("/v1/segments", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select s.id, s.name, s.description, s.created_at, s.updated_at, count(sc.id)::integer as contacts
     from segments s
     left join segment_contacts sc on sc.segment_id = s.id
     where s.tenant_id = $1 and s.deleted_at is null
       and ($3::timestamptz is null or s.created_at > $3)
       and ($4::timestamptz is null or s.created_at < $4)
     group by s.id
     order by s.created_at desc limit $2`
  );
});

app.get("/v1/segments/:id", async (request) => {
  requireScope(request, "full");
  const segment = await findSegment(request);
  return { segment, request_id: request.request_id };
});

app.patch("/v1/segments/:id", async (request) => {
  requireScope(request, "full");
  const segmentId = (request.params as { id: string }).id;
  const input = segmentUpdateSchema.parse(request.body);
  const current = await findSegment(request);
  const row = await db.query(
    `update segments set name = $3, description = $4, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning id, name, description, created_at, updated_at`,
    [request.auth!.tenant_id, segmentId, input.name ?? current.name, input.description ?? current.description ?? null]
  );
  return { segment: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/segments/:id", async (request) => {
  requireScope(request, "full");
  const segmentId = (request.params as { id: string }).id;
  await db.query("update segments set deleted_at = now(), updated_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    segmentId
  ]);
  return { deleted: true, id: segmentId, request_id: request.request_id };
});

app.get("/v1/segments/:id/contacts", async (request) => {
  requireScope(request, "full");
  const segment = await findSegment(request);
  const paging = page(request);
  const rows = await db.query(
    `select sc.id, sc.created_at, c.id as contact_id, c.email, c.first_name, c.last_name, c.properties
     from segment_contacts sc
     join contacts c on c.id = sc.contact_id
     where sc.tenant_id = $1 and sc.segment_id = $2 and c.deleted_at is null
       and ($4::timestamptz is null or sc.created_at > $4)
       and ($5::timestamptz is null or sc.created_at < $5)
     order by sc.created_at desc limit $3`,
    [request.auth!.tenant_id, segment.id, paging.fetch, paging.after, paging.before]
  );
  return { ...pageList(rows.rows, paging), request_id: request.request_id };
});

app.post("/v1/segments/:id/contacts", async (request) => {
  requireScope(request, "full");
  const segment = await findSegment(request);
  const input = segmentContactSchema.parse(request.body);
  const contact = await upsertContact(request.auth!.tenant_id, input.email);
  const row = await db.query(
    `insert into segment_contacts (id, tenant_id, segment_id, contact_id)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, segment_id, contact_id) do update set segment_id = excluded.segment_id
     returning id, segment_id, contact_id, created_at`,
    [id("member"), request.auth!.tenant_id, segment.id, contact.id]
  );
  return { contact: { ...row.rows[0], email: contact.email }, request_id: request.request_id };
});

app.delete("/v1/segments/:id/contacts/:contact_id", async (request) => {
  requireScope(request, "full");
  const segment = await findSegment(request);
  const contactId = (request.params as { contact_id: string }).contact_id;
  const row = await db.query(
    `delete from segment_contacts
     where tenant_id = $1 and segment_id = $2 and (id = $3 or contact_id = $3)
     returning id`,
    [request.auth!.tenant_id, segment.id, contactId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Segment contact not found");
  return { deleted: true, id: contactId, request_id: request.request_id };
});

app.post("/v1/broadcasts", async (request) => {
  requireScope(request, "full");
  const input = broadcastSchema.parse(request.body);
  const draft = await buildBroadcast(request.auth!.tenant_id, input);
  const row = await db.query(
    `insert into broadcasts (
       id, tenant_id, name, from_email, subject, html, text, template_id, template_version_id,
       variables, topic_id, segment_id
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning id, name, from_email as from, subject, html, text, template_id, template_version_id,
       variables, topic_id, segment_id, status, recipient_count, sent_count, created_at, updated_at, sent_at`,
    [
      id("broadcast"),
      request.auth!.tenant_id,
      input.name,
      input.from,
      draft.subject,
      draft.html ?? null,
      draft.text ?? null,
      draft.template_id,
      draft.template_version_id,
      JSON.stringify(input.variables),
      input.topic_id ?? null,
      input.segment_id ?? null
    ]
  );
  return { broadcast: row.rows[0], request_id: request.request_id };
});

app.get("/v1/broadcasts", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select id, name, from_email as from, subject, topic_id, segment_id, status,
       recipient_count, sent_count, created_at, updated_at, sent_at
     from broadcasts
     where tenant_id = $1 and deleted_at is null
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.get("/v1/broadcasts/:id", async (request) => {
  requireScope(request, "full");
  const broadcast = await findBroadcast(request);
  const recipients = await db.query(
    "select id, contact_id, email_id, email, status, created_at, updated_at from broadcast_recipients where tenant_id = $1 and broadcast_id = $2 order by created_at",
    [request.auth!.tenant_id, broadcast.id]
  );
  return { broadcast: { ...broadcast, recipients: recipients.rows }, request_id: request.request_id };
});

app.patch("/v1/broadcasts/:id", async (request) => {
  requireScope(request, "full");
  const broadcastId = (request.params as { id: string }).id;
  const input = broadcastUpdateSchema.parse(request.body);
  const current = await findBroadcast(request);
  if (current.status !== "draft") throw new ApiError("conflict", 409, "Only draft broadcasts can be updated");
  const draft = await buildBroadcast(request.auth!.tenant_id, {
    from: input.from ?? current.from,
    subject: input.subject ?? current.subject ?? undefined,
    html: input.html ?? current.html ?? undefined,
    text: input.text ?? current.text ?? undefined,
    template: input.template,
    variables: input.variables ?? current.variables ?? {},
    topic_id: input.topic_id ?? current.topic_id ?? undefined,
    segment_id: input.segment_id ?? current.segment_id ?? undefined
  });
  const row = await db.query(
    `update broadcasts set name = $3, from_email = $4, subject = $5, html = $6, text = $7,
       template_id = $8, template_version_id = $9, variables = $10, topic_id = $11, segment_id = $12, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning id, name, from_email as from, subject, html, text, template_id, template_version_id,
       variables, topic_id, segment_id, status, recipient_count, sent_count, created_at, updated_at, sent_at`,
    [
      request.auth!.tenant_id,
      broadcastId,
      input.name ?? current.name,
      input.from ?? current.from,
      draft.subject,
      draft.html ?? null,
      draft.text ?? null,
      draft.template_id,
      draft.template_version_id,
      JSON.stringify(input.variables ?? current.variables ?? {}),
      input.topic_id ?? current.topic_id ?? null,
      input.segment_id ?? current.segment_id ?? null
    ]
  );
  return { broadcast: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/broadcasts/:id", async (request) => {
  requireScope(request, "full");
  const broadcast = await findBroadcast(request);
  if (!["draft", "cancelled"].includes(broadcast.status)) throw new ApiError("conflict", 409, "Only draft broadcasts can be deleted");
  await db.query("update broadcasts set deleted_at = now(), updated_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    broadcast.id
  ]);
  return { deleted: true, id: broadcast.id, request_id: request.request_id };
});

app.post("/v1/broadcasts/:id/send", async (request) => {
  requireScope(request, "full");
  const broadcast = await findBroadcast(request);
  if (broadcast.status !== "draft") throw new ApiError("conflict", 409, "Broadcast is not a draft");
  const recipients = await snapshotBroadcast(request.auth!.tenant_id, broadcast.id);
  await db.query(
    `update broadcasts set status = 'sending', recipient_count = $3, updated_at = now()
     where tenant_id = $1 and id = $2`,
    [request.auth!.tenant_id, broadcast.id, recipients.length]
  );

  let sent = 0;
  for (const recipient of recipients) {
    const response = await acceptEmail(
      request,
      {
        from: broadcast.from,
        to: recipient.email,
        subject: broadcast.subject,
        html: broadcast.html ?? undefined,
        text: broadcast.text ?? undefined,
        tags: { broadcast_id: broadcast.id }
      },
      { idempotency: false }
    );
    await db.query(
      `update broadcast_recipients set email_id = $4, status = 'sent', updated_at = now()
       where tenant_id = $1 and broadcast_id = $2 and id = $3`,
      [request.auth!.tenant_id, broadcast.id, recipient.id, response.email.id]
    );
    sent += 1;
  }

  const row = await db.query(
    `update broadcasts set status = 'sent', sent_count = $3, sent_at = now(), updated_at = now()
     where tenant_id = $1 and id = $2
     returning id, name, from_email as from, subject, topic_id, segment_id, status,
       recipient_count, sent_count, created_at, updated_at, sent_at`,
    [request.auth!.tenant_id, broadcast.id, sent]
  );
  return { broadcast: row.rows[0], request_id: request.request_id };
});

app.post("/v1/broadcasts/:id/pause", async (request) => {
  requireScope(request, "full");
  const broadcast = await findBroadcast(request);
  if (broadcast.status !== "sending") throw new ApiError("conflict", 409, "Only sending broadcasts can be paused");
  const row = await db.query(
    `update broadcasts set status = 'paused', updated_at = now()
     where tenant_id = $1 and id = $2
     returning id, name, from_email as from, subject, topic_id, segment_id, status,
       recipient_count, sent_count, created_at, updated_at, sent_at`,
    [request.auth!.tenant_id, broadcast.id]
  );
  return { broadcast: row.rows[0], request_id: request.request_id };
});

app.post("/v1/broadcasts/:id/resume", async (request) => {
  requireScope(request, "full");
  const broadcast = await findBroadcast(request);
  if (broadcast.status !== "paused") throw new ApiError("conflict", 409, "Only paused broadcasts can be resumed");
  const row = await db.query(
    `update broadcasts set status = 'sending', updated_at = now()
     where tenant_id = $1 and id = $2
     returning id, name, from_email as from, subject, topic_id, segment_id, status,
       recipient_count, sent_count, created_at, updated_at, sent_at`,
    [request.auth!.tenant_id, broadcast.id]
  );
  return { broadcast: row.rows[0], request_id: request.request_id };
});

app.post("/v1/broadcasts/:id/cancel", async (request) => {
  requireScope(request, "full");
  const broadcast = await findBroadcast(request);
  if (broadcast.status === "sent") throw new ApiError("conflict", 409, "Sent broadcasts cannot be cancelled");
  const row = await db.query(
    `update broadcasts set status = 'cancelled', updated_at = now()
     where tenant_id = $1 and id = $2
     returning id, name, from_email as from, subject, topic_id, segment_id, status,
       recipient_count, sent_count, created_at, updated_at, sent_at`,
    [request.auth!.tenant_id, broadcast.id]
  );
  return { broadcast: row.rows[0], request_id: request.request_id };
});

app.post("/v1/broadcasts/:id/clone", async (request) => {
  requireScope(request, "full");
  const source = await findBroadcast(request);
  const body = (request.body ?? {}) as { name?: string };
  const row = await db.query(
    `insert into broadcasts (
       id, tenant_id, name, from_email, subject, html, text, template_id, template_version_id,
       variables, topic_id, segment_id, status
     )
     select $1, tenant_id, $3, from_email, subject, html, text, template_id, template_version_id,
       variables, topic_id, segment_id, 'draft'
     from broadcasts
     where tenant_id = $2 and id = $4
     returning id, name, from_email as from, subject, topic_id, segment_id, status,
       recipient_count, sent_count, created_at, updated_at, sent_at`,
    [id("broadcast"), request.auth!.tenant_id, body.name ?? `${source.name} copy`, source.id]
  );
  return { broadcast: row.rows[0], request_id: request.request_id };
});

app.post("/v1/events", async (request) => {
  requireScope(request, "full");
  const input = customEventSchema.parse(request.body);
  return createCustomEvent(request, input);
});

app.post("/v1/events/:name", async (request) => {
  requireScope(request, "full");
  const name = (request.params as { name: string }).name;
  const input = customEventSchema.parse({ ...((request.body ?? {}) as Record<string, unknown>), name });
  return createCustomEvent(request, input);
});

app.get("/v1/events", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select id, request_id, name, email, data, created_at
     from custom_events
     where tenant_id = $1 and deleted_at is null
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.get("/v1/events/:id", async (request) => {
  requireScope(request, "full");
  const event = await findCustomEvent(request);
  return { event, request_id: request.request_id };
});

app.patch("/v1/events/:id", async (request) => {
  requireScope(request, "full");
  const eventId = (request.params as { id: string }).id;
  const input = customEventUpdateSchema.parse(request.body);
  const current = await findCustomEvent(request);
  const row = await db.query(
    `update custom_events
     set name = $3, email = $4, data = $5, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning id, request_id, name, email, data, created_at, updated_at`,
    [
      request.auth!.tenant_id,
      eventId,
      input.name ?? current.name,
      input.email === undefined ? current.email : input.email ?? null,
      JSON.stringify(input.data ?? current.data ?? {})
    ]
  );
  return { event: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/events/:id", async (request) => {
  requireScope(request, "full");
  const eventId = (request.params as { id: string }).id;
  const row = await db.query(
    "update custom_events set deleted_at = now(), updated_at = now() where tenant_id = $1 and id = $2 and deleted_at is null returning id",
    [request.auth!.tenant_id, eventId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Event not found");
  return { deleted: true, id: eventId, request_id: request.request_id };
});

app.post("/v1/automations", async (request) => {
  requireScope(request, "full");
  const input = automationSchema.parse(request.body);
  const row = await db.query(
    `insert into automations (id, tenant_id, name, trigger, steps)
     values ($1, $2, $3, $4, $5)
     returning id, name, trigger, steps, enabled, created_at, updated_at`,
    [id("automation"), request.auth!.tenant_id, input.name, input.trigger, JSON.stringify(input.steps)]
  );
  return { automation: row.rows[0], request_id: request.request_id };
});

app.get("/v1/automations", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select id, name, trigger, steps, enabled, created_at, updated_at
     from automations
     where tenant_id = $1 and deleted_at is null
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.get("/v1/automations/:id", async (request) => {
  requireScope(request, "full");
  const automation = await findAutomation(request);
  return { automation, request_id: request.request_id };
});

app.patch("/v1/automations/:id", async (request) => {
  requireScope(request, "full");
  const automationId = (request.params as { id: string }).id;
  const input = automationUpdateSchema.parse(request.body);
  const current = await findAutomation(request);
  const row = await db.query(
    `update automations set name = $3, trigger = $4, steps = $5, enabled = $6, updated_at = now()
     where tenant_id = $1 and id = $2 and deleted_at is null
     returning id, name, trigger, steps, enabled, created_at, updated_at`,
    [
      request.auth!.tenant_id,
      automationId,
      input.name ?? current.name,
      input.trigger ?? current.trigger,
      JSON.stringify(input.steps ?? current.steps),
      input.enabled ?? current.enabled
    ]
  );
  return { automation: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/automations/:id", async (request) => {
  requireScope(request, "full");
  const automationId = (request.params as { id: string }).id;
  await db.query("update automations set deleted_at = now(), updated_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    automationId
  ]);
  return { deleted: true, id: automationId, request_id: request.request_id };
});

app.post("/v1/automations/:id/stop", async (request) => {
  requireScope(request, "full");
  const automation = await findAutomation(request);
  await tx(db, async (client) => {
    await client.query("update automations set enabled = false, updated_at = now() where tenant_id = $1 and id = $2", [
      request.auth!.tenant_id,
      automation.id
    ]);
    await client.query(
      `update automation_runs
       set state = 'stopped', resume_at = null, wait_event = null, updated_at = now()
       where tenant_id = $1 and automation_id = $2 and state in ('ready', 'running', 'waiting')`,
      [request.auth!.tenant_id, automation.id]
    );
  });
  return { stopped: true, id: automation.id, request_id: request.request_id };
});

app.get("/v1/automations/:id/runs", async (request) => {
  requireScope(request, "full");
  const automation = await findAutomation(request);
  const paging = page(request);
  const rows = await db.query(
    `select r.id, r.event_id, e.name as event_name, e.email, r.state, r.next_step_index, r.resume_at, r.wait_event,
       r.error, r.created_at, r.updated_at
     from automation_runs r
     join custom_events e on e.id = r.event_id
     where r.tenant_id = $1 and r.automation_id = $2
       and ($4::timestamptz is null or r.created_at > $4)
       and ($5::timestamptz is null or r.created_at < $5)
     order by r.created_at desc limit $3`,
    [request.auth!.tenant_id, automation.id, paging.fetch, paging.after, paging.before]
  );
  return { ...pageList(rows.rows, paging), request_id: request.request_id };
});

app.get("/v1/automation-runs/:id", async (request) => {
  requireScope(request, "full");
  const runId = (request.params as { id: string }).id;
  const run = await db.query(
    `select r.id, r.automation_id, r.event_id, e.name as event_name, e.email, e.data as event_data,
       r.state, r.next_step_index, r.resume_at, r.wait_event, r.error, r.created_at, r.updated_at
     from automation_runs r
     join custom_events e on e.id = r.event_id
     where r.tenant_id = $1 and r.id = $2`,
    [request.auth!.tenant_id, runId]
  );
  if (!run.rows[0]) throw new ApiError("not_found", 404, "Automation run not found");
  const steps = await db.query(
    `select id, step_index, type, state, data, error, created_at
     from automation_steps
     where tenant_id = $1 and run_id = $2
     order by step_index`,
    [request.auth!.tenant_id, runId]
  );
  return { run: { ...run.rows[0], steps: steps.rows }, request_id: request.request_id };
});

app.post("/v1/suppressions", async (request) => {
  requireScope(request, "full");
  const input = suppressionSchema.parse(request.body);
  const row = await db.query(
    `insert into suppressions (id, tenant_id, email, reason)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, email) do update set reason = excluded.reason, removed_at = null
     returning id, email, reason, created_at, removed_at`,
    [id("supp"), request.auth!.tenant_id, input.email, input.reason]
  );
  return { suppression: row.rows[0], request_id: request.request_id };
});

app.get("/v1/suppressions", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select id, email, reason, created_at
     from suppressions
     where tenant_id = $1 and removed_at is null
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.delete("/v1/suppressions/:id", async (request) => {
  requireScope(request, "full");
  const suppressionId = (request.params as { id: string }).id;
  await db.query("update suppressions set removed_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    suppressionId
  ]);
  return { deleted: true, id: suppressionId, request_id: request.request_id };
});

app.get("/v1/email-jobs", async (request) => {
  requireScope(request, "full");
  const query = request.query as { email_id?: string };
  return pageRows(
    request,
    `select j.id, j.email_id, e.subject, j.state, j.attempts, j.available_at, j.locked_at, j.error, j.created_at, j.updated_at
     from send_jobs j
     join emails e on e.tenant_id = j.tenant_id and e.id = j.email_id
     where j.tenant_id = $1
       and ($3::timestamptz is null or j.created_at > $3)
       and ($4::timestamptz is null or j.created_at < $4)
       and ($5::text is null or j.email_id = $5)
     order by j.created_at desc limit $2`,
    [query.email_id ?? null]
  );
});

app.get("/v1/email-jobs/:id", async (request) => {
  requireScope(request, "full");
  const jobId = (request.params as { id: string }).id;
  const row = await db.query(
    `select j.id, j.email_id, e.subject, j.request_id, j.state, j.attempts, j.available_at, j.locked_at, j.error, j.created_at, j.updated_at
     from send_jobs j
     join emails e on e.tenant_id = j.tenant_id and e.id = j.email_id
     where j.tenant_id = $1 and j.id = $2`,
    [request.auth!.tenant_id, jobId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Email job not found");
  return { job: row.rows[0], request_id: request.request_id };
});

app.post("/v1/emails", async (request, reply) => {
  requireSend(request);
  const response = await acceptEmail(request, request.body);
  reply.status(202);
  return response;
});

app.post("/v1/emails/batch", async (request, reply) => {
  requireSend(request);
  const input = batchSchema.parse(request.body);
  const idemKey = idempotencyKey(request);
  const requestHash = stableHash(input);
  const replay = idemKey ? await readIdempotency(request, idemKey, requestHash) : null;
  if (replay) return { ...replay, request_id: request.request_id };

  if (idemKey) {
    await db.query("delete from idempotency_keys where tenant_id = $1 and key = $2 and expires_at <= now()", [
      request.auth!.tenant_id,
      idemKey
    ]);
    const inserted = await db.query(
      `insert into idempotency_keys (id, tenant_id, key, request_hash, state, expires_at)
       values ($1, $2, $3, $4, 'running', now() + interval '24 hours')
       on conflict (tenant_id, key) do nothing`,
      [id("idem"), request.auth!.tenant_id, idemKey, requestHash]
    );
    if (inserted.rowCount === 0) {
      const raced = await readIdempotency(request, idemKey, requestHash);
      if (raced) return { ...raced, request_id: request.request_id };
    }
  }

  const data = [];
  try {
    for (const email of input.emails) {
      data.push((await acceptEmail(request, email, { idempotency: false })).email);
    }
  } catch (error) {
    if (idemKey) {
      await db.query("delete from idempotency_keys where tenant_id = $1 and key = $2 and state = 'running'", [
        request.auth!.tenant_id,
        idemKey
      ]);
    }
    throw error;
  }
  reply.status(202);
  const response = list(data);
  if (idemKey) {
    await db.query("update idempotency_keys set response_json = $3, state = 'done' where tenant_id = $1 and key = $2", [
      request.auth!.tenant_id,
      idemKey,
      JSON.stringify(response)
    ]);
  }
  return { ...response, request_id: request.request_id };
});

app.get("/v1/emails", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select e.id, e.request_id, e.from_email as from, e.subject, e.status, e.provider_message_id, e.created_at, e.updated_at,
       coalesce(json_agg(r.email order by r.created_at) filter (where r.kind = 'to'), '[]') as to
     from emails e
     left join email_recipients r on r.email_id = e.id
     where e.tenant_id = $1
       and ($3::timestamptz is null or e.created_at > $3)
       and ($4::timestamptz is null or e.created_at < $4)
     group by e.id
     order by e.created_at desc
     limit $2`
  );
});

app.get("/v1/emails/:id", async (request) => {
  requireScope(request, "full");
  const emailId = (request.params as { id: string }).id;
  const email = await db.query("select * from emails where tenant_id = $1 and id = $2", [request.auth!.tenant_id, emailId]);
  if (!email.rows[0]) throw new ApiError("not_found", 404, "Email not found");
  const recipients = await db.query(
    "select id, email, kind, status, created_at from email_recipients where tenant_id = $1 and email_id = $2 order by created_at",
    [request.auth!.tenant_id, emailId]
  );
  const attachments = await db.query(
    "select id, filename, content_type, size_bytes, content_id, created_at from email_attachments where tenant_id = $1 and email_id = $2 order by created_at",
    [request.auth!.tenant_id, emailId]
  );
  const events = await db.query("select id, type, data, created_at from email_events where tenant_id = $1 and email_id = $2 order by created_at", [
    request.auth!.tenant_id,
    emailId
  ]);
  return { email: { ...email.rows[0], recipients: recipients.rows, attachments: attachments.rows, events: events.rows }, request_id: request.request_id };
});

app.get("/v1/emails/:id/attachments", async (request) => {
  requireScope(request, "full");
  const emailId = (request.params as { id: string }).id;
  await findEmail(request, emailId);
  const paging = page(request);
  const rows = await db.query(
    `select id, filename, content_type, size_bytes, content_id, created_at
     from email_attachments
     where tenant_id = $1 and email_id = $2
       and ($4::timestamptz is null or created_at > $4)
       and ($5::timestamptz is null or created_at < $5)
     order by created_at desc limit $3`,
    [request.auth!.tenant_id, emailId, paging.fetch, paging.after, paging.before]
  );
  return { ...pageList(rows.rows, paging), request_id: request.request_id };
});

app.get("/v1/emails/:id/attachments/:attachment_id", async (request) => {
  requireScope(request, "full");
  const { id: emailId, attachment_id: attachmentId } = request.params as { id: string; attachment_id: string };
  await findEmail(request, emailId);
  const row = await db.query(
    `select id, filename, content_type, size_bytes, content_id, disposition, content_hash, storage_key, created_at
     from email_attachments
     where tenant_id = $1 and email_id = $2 and id = $3`,
    [request.auth!.tenant_id, emailId, attachmentId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Attachment not found");
  const content = (await readFile(blobPath(row.rows[0].storage_key))).toString("base64");
  return { attachment: { ...row.rows[0], content }, request_id: request.request_id };
});

app.get("/v1/emails/:id/events", async (request) => {
  requireScope(request, "full");
  const emailId = (request.params as { id: string }).id;
  const email = await db.query("select id from emails where tenant_id = $1 and id = $2", [request.auth!.tenant_id, emailId]);
  if (!email.rows[0]) throw new ApiError("not_found", 404, "Email not found");
  const paging = page(request);
  const events = await db.query(
    `select id, request_id, type, data, created_at
     from email_events
     where tenant_id = $1 and email_id = $2
       and ($4::timestamptz is null or created_at > $4)
       and ($5::timestamptz is null or created_at < $5)
     order by created_at asc
     limit $3`,
    [request.auth!.tenant_id, emailId, paging.fetch, paging.after, paging.before]
  );
  return { ...pageList(events.rows, paging), request_id: request.request_id };
});

app.patch("/v1/emails/:id", async (request) => {
  requireSend(request);
  const emailId = (request.params as { id: string }).id;
  const input = emailUpdateSchema.parse(request.body);
  const row = await tx(db, async (client) => {
    const current = await client.query<{
      id: string;
      subject: string;
      html: string | null;
      text: string | null;
      headers: Record<string, string>;
      tags: Record<string, string>;
      status: string;
      scheduled_at: string | null;
    }>(
      `select id, subject, html, text, headers, tags, status, scheduled_at
       from emails
       where tenant_id = $1 and id = $2
       for update`,
      [request.auth!.tenant_id, emailId]
    );
    const email = current.rows[0];
    if (!email) throw new ApiError("not_found", 404, "Email not found");
    if (!["queued", "scheduled"].includes(email.status)) throw new ApiError("conflict", 409, "Email cannot be updated after dispatch");
    const runningJob = await client.query(
      "select id from send_jobs where tenant_id = $1 and email_id = $2 and state = 'running' limit 1",
      [request.auth!.tenant_id, emailId]
    );
    if (runningJob.rows[0]) throw new ApiError("conflict", 409, "Email dispatch is already running");

    const scheduledAt =
      input.scheduled_at === undefined ? (email.scheduled_at ? new Date(email.scheduled_at) : null) : input.scheduled_at ? new Date(input.scheduled_at) : null;
    const nextStatus = scheduledAt && scheduledAt.getTime() > Date.now() ? "scheduled" : "queued";
    const html = input.html === undefined ? email.html : input.html;
    const text = input.text === undefined ? email.text : input.text;
    if (!html && !text) throw new ApiError("validation_error", 400, "html or text is required");

    const updated = await client.query(
      `update emails
       set subject = $3, html = $4, text = $5, headers = $6, tags = $7,
         scheduled_at = $8, status = $9, updated_at = now()
       where tenant_id = $1 and id = $2
       returning id, request_id, from_email as from, subject, html, text, headers, tags, status, scheduled_at, created_at, updated_at`,
      [
        request.auth!.tenant_id,
        emailId,
        input.subject ?? email.subject,
        html,
        text,
        JSON.stringify(input.headers ?? email.headers ?? {}),
        JSON.stringify(input.tags ?? email.tags ?? {}),
        scheduledAt,
        nextStatus
      ]
    );
    await client.query(
      `update send_jobs
       set state = 'ready', available_at = coalesce($3::timestamptz, now()), updated_at = now()
       where tenant_id = $1 and email_id = $2 and state in ('ready', 'failed')`,
      [request.auth!.tenant_id, emailId, nextStatus === "scheduled" ? scheduledAt : null]
    );
    if (nextStatus === "scheduled") {
      const event = await appendEvent(client, {
        tenantId: request.auth!.tenant_id,
        requestId: request.request_id,
        emailId,
        type: "email.scheduled",
        providerEventId: `${emailId}:rescheduled:${Date.now()}`,
        data: { scheduled_at: scheduledAt?.toISOString() }
      });
      if (event) await fanoutEvent(client, event);
    }
    return updated.rows[0];
  });
  return { email: row, request_id: request.request_id };
});

app.post("/v1/emails/:id/cancel", async (request) => {
  requireSend(request);
  const emailId = (request.params as { id: string }).id;
  const row = await db.query(
    `update emails set status = 'cancelled', updated_at = now()
     where tenant_id = $1 and id = $2 and status in ('queued', 'scheduled')
     returning id, status`,
    [request.auth!.tenant_id, emailId]
  );
  await db.query("update send_jobs set state = 'cancelled' where tenant_id = $1 and email_id = $2 and state = 'ready'", [
    request.auth!.tenant_id,
    emailId
  ]);
  if (!row.rows[0]) throw new ApiError("conflict", 409, "Email cannot be cancelled");
  return { email: row.rows[0], request_id: request.request_id };
});

app.post("/v1/emails/:id/retry", async (request) => {
  requireSend(request);
  const emailId = (request.params as { id: string }).id;
  const email = await db.query(
    "select id, status, request_id from emails where tenant_id = $1 and id = $2",
    [request.auth!.tenant_id, emailId]
  );
  if (!email.rows[0]) throw new ApiError("not_found", 404, "Email not found");
  if (["queued", "scheduled", "sent", "delivered"].includes(email.rows[0].status)) {
    throw new ApiError("conflict", 409, "Email does not need retry");
  }
  const row = await db.query(
    `insert into send_jobs (id, tenant_id, email_id, request_id, state, available_at)
     values ($1, $2, $3, $4, 'ready', now())
     returning id, email_id, state, available_at, created_at`,
    [id("job"), request.auth!.tenant_id, emailId, request.request_id]
  );
  await db.query("update emails set status = 'queued', updated_at = now() where tenant_id = $1 and id = $2", [
    request.auth!.tenant_id,
    emailId
  ]);
  return { job: row.rows[0], request_id: request.request_id };
});

app.post("/v1/webhooks", async (request) => {
  requireScope(request, "full");
  const input = webhookSchema.parse(request.body);
  const url = await webhookUrl(input.url);
  const secret = randomBytes(32).toString("base64url");
  const row = await db.query(
    `insert into webhooks (id, tenant_id, url, events, secret)
     values ($1, $2, $3, $4, $5)
     returning id, url, events, enabled, created_at`,
    [id("webhook"), request.auth!.tenant_id, url, JSON.stringify(input.events), secret]
  );
  return { webhook: { ...row.rows[0], secret }, request_id: request.request_id };
});

app.get("/v1/webhooks", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select w.id, w.url, w.events, w.enabled, h.state as health, h.consecutive_failures, w.created_at, w.updated_at
     from webhooks w
     left join webhook_endpoint_health h on h.webhook_id = w.id
     where w.tenant_id = $1
       and ($3::timestamptz is null or w.created_at > $3)
       and ($4::timestamptz is null or w.created_at < $4)
     order by w.created_at desc limit $2`
  );
});

app.get("/v1/webhooks/:id", async (request) => {
  requireScope(request, "full");
  const webhookId = (request.params as { id: string }).id;
  const row = await db.query(
    `select w.id, w.url, w.events, w.enabled, h.state as health, h.consecutive_failures, h.last_status, h.last_error,
       w.created_at, w.updated_at
     from webhooks w
     left join webhook_endpoint_health h on h.webhook_id = w.id
     where w.tenant_id = $1 and w.id = $2`,
    [request.auth!.tenant_id, webhookId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Webhook not found");
  return { webhook: row.rows[0], request_id: request.request_id };
});

app.patch("/v1/webhooks/:id", async (request) => {
  requireScope(request, "full");
  const webhookId = (request.params as { id: string }).id;
  const body = request.body as { url?: string; events?: string[]; enabled?: boolean };
  const url = body.url ? await webhookUrl(body.url) : undefined;
  if (body.events && (!Array.isArray(body.events) || body.events.length === 0)) {
    throw new ApiError("validation_error", 400, "events must be a non-empty array");
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new ApiError("validation_error", 400, "enabled must be a boolean");
  }
  const current = await db.query("select * from webhooks where tenant_id = $1 and id = $2", [request.auth!.tenant_id, webhookId]);
  if (!current.rows[0]) throw new ApiError("not_found", 404, "Webhook not found");
  const row = await db.query(
    `update webhooks set url = $3, events = $4, enabled = $5, updated_at = now()
     where tenant_id = $1 and id = $2
     returning id, url, events, enabled, created_at, updated_at`,
    [
      request.auth!.tenant_id,
      webhookId,
      url ?? current.rows[0].url,
      JSON.stringify(body.events ?? current.rows[0].events),
      body.enabled ?? current.rows[0].enabled
    ]
  );
  return { webhook: row.rows[0], request_id: request.request_id };
});

app.delete("/v1/webhooks/:id", async (request) => {
  requireScope(request, "full");
  const webhookId = (request.params as { id: string }).id;
  await db.query("delete from webhooks where tenant_id = $1 and id = $2", [request.auth!.tenant_id, webhookId]);
  return { deleted: true, id: webhookId, request_id: request.request_id };
});

app.get("/v1/webhooks/:id/attempts", async (request) => {
  requireScope(request, "full");
  const webhookId = (request.params as { id: string }).id;
  const paging = page(request);
  const rows = await db.query(
    `select id, event_id, state, attempt, available_at, status, latency_ms, error, response, created_at, updated_at
     from webhook_attempts
     where tenant_id = $1 and webhook_id = $2
       and ($4::timestamptz is null or created_at > $4)
       and ($5::timestamptz is null or created_at < $5)
     order by created_at desc limit $3`,
    [request.auth!.tenant_id, webhookId, paging.fetch, paging.after, paging.before]
  );
  return { ...pageList(rows.rows, paging), request_id: request.request_id };
});

app.post("/v1/webhooks/:id/replay", async (request) => {
  requireScope(request, "full");
  const webhookId = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as { event_id?: string; attempt_id?: string };
  const row = await db.query(
    body.attempt_id
      ? `select e.* from webhook_attempts a
         join email_events e on e.id = a.event_id
         join webhooks w on w.tenant_id = a.tenant_id and w.id = a.webhook_id
         where a.tenant_id = $1 and a.webhook_id = $2 and a.id = $3 and w.enabled = true and w.events ? e.type
         limit 1`
      : body.event_id
        ? `select e.* from email_events e
           join webhooks w on w.tenant_id = e.tenant_id
           where w.id = $2 and w.tenant_id = $1 and e.id = $3 and w.enabled = true and w.events ? e.type
           limit 1`
        : `select e.* from webhook_attempts a
           join email_events e on e.id = a.event_id
           join webhooks w on w.tenant_id = a.tenant_id and w.id = a.webhook_id
           where a.tenant_id = $1 and a.webhook_id = $2 and a.state = 'failed' and w.enabled = true and w.events ? e.type
           order by a.created_at desc limit 1`,
    [request.auth!.tenant_id, webhookId, body.attempt_id ?? body.event_id ?? null]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "No event to replay");
  const attempt = await db.query(
    `insert into webhook_attempts (id, tenant_id, request_id, webhook_id, event_id, state)
     values ($1, $2, $3, $4, $5, 'queued')
     returning id`,
    [id("attempt"), request.auth!.tenant_id, row.rows[0].request_id ?? request.request_id, webhookId, row.rows[0].id]
  );
  await db.query(
    `insert into webhook_replays (id, tenant_id, webhook_id, event_id, attempt_id, request_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [id("replay"), request.auth!.tenant_id, webhookId, row.rows[0].id, attempt.rows[0].id, request.request_id]
  );
  return { queued: true, event_id: row.rows[0].id, request_id: request.request_id };
});

app.post("/v1/webhooks/test", async (request) => {
  requireScope(request, "full");
  const eventId = id("event");
  const row = await db.query(
    `insert into email_events (id, tenant_id, request_id, type, data)
     values ($1, $2, $3, 'email.sent', $4)
     returning id, request_id, type, data, created_at`,
    [eventId, request.auth!.tenant_id, request.request_id, JSON.stringify({ test: true })]
  );
  await db.query(
    `insert into webhook_attempts (id, tenant_id, request_id, webhook_id, event_id, state)
     select 'attempt_' || md5(random()::text || clock_timestamp()::text || id), tenant_id, $3, id, $2, 'queued'
     from webhooks where tenant_id = $1 and enabled = true and events ? 'email.sent'`,
    [request.auth!.tenant_id, eventId, request.request_id]
  );
  return { event: row.rows[0], request_id: request.request_id };
});

app.post("/v1/received-emails/simulate", async (request) => {
  requireScope(request, "full");
  const input = inboundSchema.parse(request.body);
  return tx(db, async (client) => {
    const row = await client.query(
      `insert into received_emails (id, tenant_id, request_id, from_email, subject, html, text, headers, raw)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id, request_id, from_email as from, subject, html, text, headers, created_at`,
      [
        id("recv"),
        request.auth!.tenant_id,
        request.request_id,
        input.from,
        input.subject,
        input.html ?? null,
        input.text ?? null,
        JSON.stringify(input.headers),
        JSON.stringify(rawInbound(input))
      ]
    );
    const recipients = [
      ...toArray(input.to).map((email) => ({ email, kind: "to" })),
      ...toArray(input.cc).map((email) => ({ email, kind: "cc" })),
      ...toArray(input.bcc).map((email) => ({ email, kind: "bcc" }))
    ];
    if (recipients.length > 50) throw new ApiError("too_many_recipients", 400, "A received email can have at most 50 recipients");
    const attachments = prepareAttachments(request.auth!.tenant_id, row.rows[0].id, input.attachments, "received");
    await client.query(
      `insert into received_recipients (id, tenant_id, received_email_id, email, kind)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])`,
      [
        recipients.map(() => id("rr")),
        recipients.map(() => request.auth!.tenant_id),
        recipients.map(() => row.rows[0].id),
        recipients.map((recipient) => recipient.email),
        recipients.map((recipient) => recipient.kind)
      ]
    );
    for (const attachment of attachments) {
      await writeBlob(attachment.storage_key, attachment.bytes);
    }
    if (attachments.length > 0) {
      await client.query(
        `insert into received_attachments (id, tenant_id, received_email_id, filename, content_type, size_bytes, content_hash, storage_key)
         select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::integer[], $7::text[], $8::text[])`,
        [
          attachments.map((attachment) => attachment.id),
          attachments.map(() => request.auth!.tenant_id),
          attachments.map(() => row.rows[0].id),
          attachments.map((attachment) => attachment.filename),
          attachments.map((attachment) => attachment.content_type),
          attachments.map((attachment) => attachment.size_bytes),
          attachments.map((attachment) => attachment.content_hash),
          attachments.map((attachment) => attachment.storage_key)
        ]
      );
    }
    const event = await appendEvent(client, {
      tenantId: request.auth!.tenant_id,
      requestId: request.request_id,
      emailId: null,
      type: "email.received",
      providerEventId: `${row.rows[0].id}:received`,
      data: {
        received_email_id: row.rows[0].id,
        from: input.from,
        to: recipients.filter((recipient) => recipient.kind === "to").map((recipient) => recipient.email),
        cc: recipients.filter((recipient) => recipient.kind === "cc").map((recipient) => recipient.email),
        bcc: recipients.filter((recipient) => recipient.kind === "bcc").map((recipient) => recipient.email),
        subject: input.subject,
        attachments: attachments.length
      }
    });
    if (event) await fanoutEvent(client, event);
    return {
      received_email: {
        ...row.rows[0],
        to: recipients.filter((recipient) => recipient.kind === "to").map((recipient) => recipient.email),
        cc: recipients.filter((recipient) => recipient.kind === "cc").map((recipient) => recipient.email),
        bcc: recipients.filter((recipient) => recipient.kind === "bcc").map((recipient) => recipient.email)
      },
      request_id: request.request_id
    };
  });
});

app.get("/v1/received-emails", async (request) => {
  requireScope(request, "full");
  return pageRows(
    request,
    `select m.id, m.request_id, m.from_email as from, m.subject, m.created_at,
       coalesce(json_agg(r.email order by r.created_at) filter (where r.id is not null), '[]') as to
     from received_emails m
     left join received_recipients r on r.received_email_id = m.id
     where m.tenant_id = $1
       and ($3::timestamptz is null or m.created_at > $3)
       and ($4::timestamptz is null or m.created_at < $4)
     group by m.id
     order by m.created_at desc limit $2`
  );
});

app.get("/v1/received-emails/:id", async (request) => {
  requireScope(request, "full");
  const receivedId = (request.params as { id: string }).id;
  const row = await db.query(
    "select id, request_id, from_email as from, subject, html, text, headers, created_at from received_emails where tenant_id = $1 and id = $2",
    [request.auth!.tenant_id, receivedId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Received email not found");
  const recipients = await db.query(
    "select id, email, kind, created_at from received_recipients where tenant_id = $1 and received_email_id = $2 order by created_at",
    [request.auth!.tenant_id, receivedId]
  );
  const attachments = await db.query(
    "select id, filename, content_type, size_bytes, created_at from received_attachments where tenant_id = $1 and received_email_id = $2 order by created_at",
    [request.auth!.tenant_id, receivedId]
  );
  return { received_email: { ...row.rows[0], recipients: recipients.rows, attachments: attachments.rows }, request_id: request.request_id };
});

app.get("/v1/received-emails/:id/attachments", async (request) => {
  requireScope(request, "full");
  const receivedId = (request.params as { id: string }).id;
  const exists = await db.query("select id from received_emails where tenant_id = $1 and id = $2", [request.auth!.tenant_id, receivedId]);
  if (!exists.rows[0]) throw new ApiError("not_found", 404, "Received email not found");
  const paging = page(request);
  const rows = await db.query(
    `select id, filename, content_type, size_bytes, created_at
     from received_attachments
     where tenant_id = $1 and received_email_id = $2
       and ($4::timestamptz is null or created_at > $4)
       and ($5::timestamptz is null or created_at < $5)
     order by created_at desc limit $3`,
    [request.auth!.tenant_id, receivedId, paging.fetch, paging.after, paging.before]
  );
  return { ...pageList(rows.rows, paging), request_id: request.request_id };
});

app.get("/v1/received-emails/:id/attachments/:attachment_id", async (request) => {
  requireScope(request, "full");
  const { id: receivedId, attachment_id: attachmentId } = request.params as { id: string; attachment_id: string };
  const row = await db.query(
    `select id, filename, content_type, size_bytes, content_hash, storage_key, created_at
     from received_attachments
     where tenant_id = $1 and received_email_id = $2 and id = $3`,
    [request.auth!.tenant_id, receivedId, attachmentId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Received attachment not found");
  const content = (await readFile(blobPath(row.rows[0].storage_key))).toString("base64");
  return { attachment: { ...row.rows[0], content }, request_id: request.request_id };
});

app.get("/open/:token.gif", async (request, reply) => {
  const token = (request.params as { token: string }).token;
  const row = await useTrackingToken(token, "open", request.request_id, {
    user_agent: request.headers["user-agent"]?.toString() ?? null,
    ip: request.ip
  });
  if (!row) throw new ApiError("not_found", 404, "Tracking token not found");
  reply.header("content-type", "image/gif");
  reply.header("cache-control", "no-store");
  return Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
});

app.get("/click/:token", async (request, reply) => {
  const token = (request.params as { token: string }).token;
  const row = await useTrackingToken(token, "click", request.request_id, {
    user_agent: request.headers["user-agent"]?.toString() ?? null,
    ip: request.ip
  });
  if (!row?.url) throw new ApiError("not_found", 404, "Tracking token not found");
  reply.redirect(row.url);
});

app.get("/v1/system", async (request) => {
  requireScope(request, "full");
  await flushTelemetry();
  const [jobs, attempts, runs, logs, health] = await Promise.all([
    db.query("select state, count(*)::integer as count from send_jobs where tenant_id = $1 group by state order by state", [request.auth!.tenant_id]),
    db.query("select state, count(*)::integer as count from webhook_attempts where tenant_id = $1 group by state order by state", [
      request.auth!.tenant_id
    ]),
    db.query("select state, count(*)::integer as count from automation_runs where tenant_id = $1 group by state order by state", [
      request.auth!.tenant_id
    ]),
    db.query(
      "select count(*)::integer as count, coalesce(max(created_at), now()) as last_seen_at from logs where tenant_id = $1",
      [request.auth!.tenant_id]
    ),
    db.query(
      `select count(*) filter (where enabled)::integer as enabled_webhooks,
        count(*) filter (where not enabled)::integer as disabled_webhooks
       from webhooks where tenant_id = $1`,
      [request.auth!.tenant_id]
    )
  ]);
  const backlog = Object.fromEntries(jobs.rows.map((row) => [row.state, row.count]));
  const webhook_attempts = Object.fromEntries(attempts.rows.map((row) => [row.state, row.count]));
  const automation_runs = Object.fromEntries(runs.rows.map((row) => [row.state, row.count]));
  return {
    ok: true,
    provider: process.env.SES_PROVIDER ?? "fake",
    worker: { backlog, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5) },
    webhooks: { attempts: webhook_attempts, ...health.rows[0] },
    automations: automation_runs,
    logs: logs.rows[0],
    request_id: request.request_id
  };
});

app.get("/v1/usage", async (request) => {
  requireScope(request, "full");
  await flushTelemetry();
  return pageRows(
    request,
    `select id, name, period, value::bigint::text as value, updated_at
     from usage_counters
     where tenant_id = $1
       and ($3::timestamptz is null or updated_at > $3)
       and ($4::timestamptz is null or updated_at < $4)
     order by updated_at desc limit $2`
  );
});

app.get("/v1/timeline", async (request) => {
  requireScope(request, "full");
  await flushTelemetry();
  return pageRows(
    request,
    `select kind, id, request_id, name, summary, created_at
     from (
       select 'email' as kind, id, tenant_id, request_id, status as name, subject as summary, created_at from emails
       union all
       select 'email_event' as kind, id, tenant_id, request_id, type as name, coalesce(email_id, '') as summary, created_at from email_events
       union all
       select 'custom_event' as kind, id, tenant_id, request_id, name, coalesce(email, '') as summary, created_at from custom_events where deleted_at is null
       union all
       select 'received_email' as kind, id, tenant_id, request_id, 'email.received' as name, subject as summary, created_at from received_emails
       union all
       select 'webhook_attempt' as kind, id, tenant_id, request_id, state as name, webhook_id as summary, created_at from webhook_attempts
       union all
       select 'automation_run' as kind, id, tenant_id, null as request_id, state as name, automation_id as summary, created_at from automation_runs
       union all
       select 'api_log' as kind, id, tenant_id, request_id, method || ' ' || status::text as name, path as summary, created_at from logs
     ) items
     where tenant_id = $1
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`
  );
});

app.get("/v1/logs", async (request) => {
  requireScope(request, "full");
  await flushTelemetry();
  const query = request.query as { path?: string; status?: string };
  return pageRows(
    request,
    `select id, request_id, user_agent, method, path, status, latency_ms, api_key_id, error, created_at
     from logs
     where tenant_id = $1
       and ($5::text is null or path like '%' || $5 || '%')
       and ($6::integer is null or status = $6)
       and ($3::timestamptz is null or created_at > $3)
       and ($4::timestamptz is null or created_at < $4)
     order by created_at desc limit $2`,
    [query.path ?? null, query.status ? Number(query.status) : null]
  );
});

app.get("/v1/logs/export", async (request) => {
  requireScope(request, "full");
  await flushTelemetry();
  const rows = await db.query(
    `select id, request_id, user_agent, method, path, status, latency_ms, api_key_id, error, created_at
     from logs
     where tenant_id = $1
     order by created_at desc limit 1000`,
    [request.auth!.tenant_id]
  );
  return { exported_at: new Date().toISOString(), logs: rows.rows, request_id: request.request_id };
});

app.get("/v1/logs/:id", async (request) => {
  requireScope(request, "full");
  await flushTelemetry();
  const logId = (request.params as { id: string }).id;
  const row = await db.query("select * from logs where tenant_id = $1 and id = $2", [request.auth!.tenant_id, logId]);
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Log not found");
  return { log: row.rows[0], request_id: request.request_id };
});

async function acceptEmail(request: FastifyRequest, input: unknown, options: { idempotency?: boolean } = {}) {
  const parsed = sendSchema.parse(input);
  const idemKey = options.idempotency === false ? undefined : idempotencyKey(request);
  const requestHash = idemKey ? stableHash(parsed) : null;
  const scheduledAt = parsed.scheduled_at ? new Date(parsed.scheduled_at) : null;
  const isScheduled = scheduledAt !== null && scheduledAt.getTime() > Date.now();
  const initialStatus = isScheduled ? "scheduled" : "queued";

  return tx(db, async (client) => {
    if (idemKey) {
      await client.query("delete from idempotency_keys where tenant_id = $1 and key = $2 and expires_at <= now()", [
        request.auth!.tenant_id,
        idemKey
      ]);
      const inserted = await client.query(
        `insert into idempotency_keys (id, tenant_id, key, request_hash, state, expires_at)
         values ($1, $2, $3, $4, 'running', now() + interval '24 hours')
         on conflict (tenant_id, key) do nothing
         returning id`,
        [id("idem"), request.auth!.tenant_id, idemKey, requestHash]
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query(
          "select request_hash, response_json, state from idempotency_keys where tenant_id = $1 and key = $2 and expires_at > now() for update",
          [request.auth!.tenant_id, idemKey]
        );
        if (existing.rows[0]?.request_hash !== requestHash) {
          throw new ApiError("idempotency_conflict", 409, "Idempotency key was used with a different payload");
        }
        if (existing.rows[0]?.state === "running") {
          throw new ApiError("idempotency_conflict", 409, "Idempotency request is still in flight");
        }
        if (existing.rows[0]?.response_json) return { ...existing.rows[0].response_json, request_id: request.request_id };
      }
    }

    const domain = parsed.from.split("@")[1];
    if (!(await verifiedDomain(client, request.auth!.tenant_id, domain))) throw new ApiError("invalid_sender", 400, "Sender domain is not verified");

    let subject = parsed.subject;
    let html = parsed.html;
    let text = parsed.text;
    let templateId: string | null = null;
    let templateVersionId: string | null = null;

    if (parsed.template) {
      const template = await publishedTemplate(client, request.auth!.tenant_id, parsed.template);
      const rendered = renderTemplate(template, parsed.variables ?? {});
      subject = subject ?? rendered.subject;
      html = html ?? rendered.html;
      text = text ?? rendered.text;
      templateId = template.template_id;
      templateVersionId = template.id;
    }

    if (!subject || (!html && !text)) throw new ApiError("validation_error", 400, "subject and content are required");

    const recipients = [
      ...toArray(parsed.to).map((email) => ({ email, kind: "to" })),
      ...toArray(parsed.cc).map((email) => ({ email, kind: "cc" })),
      ...toArray(parsed.bcc).map((email) => ({ email, kind: "bcc" }))
    ];
    if (recipients.length > 50) throw new ApiError("too_many_recipients", 400, "An email can have at most 50 recipients");

    const suppressed = await client.query(
      `select email from suppressions where tenant_id = $1 and email = any($2) and removed_at is null
       union
       select email from contacts where tenant_id = $1 and email = any($2) and deleted_at is null and unsubscribed_at is not null`,
      [request.auth!.tenant_id, recipients.map((recipient) => recipient.email)]
    );
    if ((suppressed.rowCount ?? 0) > 0) throw new ApiError("suppressed", 400, `Recipient is suppressed: ${suppressed.rows[0].email}`);

    const emailId = id("email");
    const tracking = html ? prepareTracking(html, publicUrl) : { html, tokens: [] };
    html = tracking.html ?? html;
    const attachments = prepareAttachments(request.auth!.tenant_id, emailId, parsed.attachments ?? [], "attachments");

    const email = await client.query(
      `insert into emails (
        id, tenant_id, request_id, idempotency_key, from_email, subject, html, text,
        template_id, template_version_id, headers, tags, status, scheduled_at
      )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       returning id, request_id, from_email as from, subject, status, scheduled_at, created_at`,
      [
        emailId,
        request.auth!.tenant_id,
        request.request_id,
        idemKey ?? null,
        parsed.from,
        subject,
        html ?? null,
        text ?? null,
        templateId,
        templateVersionId,
        JSON.stringify(parsed.headers ?? {}),
        JSON.stringify(parsed.tags ?? {}),
        initialStatus,
        scheduledAt
      ]
    );

    for (const attachment of attachments) {
      await writeBlob(attachment.storage_key, attachment.bytes);
    }
    if (attachments.length > 0) {
      await client.query(
        `insert into email_attachments (
          id, tenant_id, email_id, filename, content_type, content_id, disposition, size_bytes, content_hash, storage_key
        )
         select * from unnest(
          $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
          $6::text[], $7::text[], $8::integer[], $9::text[], $10::text[]
        )`,
        [
          attachments.map((attachment) => attachment.id),
          attachments.map(() => request.auth!.tenant_id),
          attachments.map(() => emailId),
          attachments.map((attachment) => attachment.filename),
          attachments.map((attachment) => attachment.content_type),
          attachments.map((attachment) => attachment.content_id ?? null),
          attachments.map((attachment) => attachment.disposition),
          attachments.map((attachment) => attachment.size_bytes),
          attachments.map((attachment) => attachment.content_hash),
          attachments.map((attachment) => attachment.storage_key)
        ]
      );
    }

    await client.query(
      `insert into email_recipients (id, tenant_id, email_id, email, kind)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])`,
      [
        recipients.map(() => id("rcpt")),
        recipients.map(() => request.auth!.tenant_id),
        recipients.map(() => emailId),
        recipients.map((recipient) => recipient.email),
        recipients.map((recipient) => recipient.kind)
      ]
    );

    if (tracking.tokens.length > 0) {
      await client.query(
        `insert into tracking_tokens (token, tenant_id, email_id, kind, url)
         select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])`,
        [
          tracking.tokens.map((token) => token.token),
          tracking.tokens.map(() => request.auth!.tenant_id),
          tracking.tokens.map(() => emailId),
          tracking.tokens.map((token) => token.kind),
          tracking.tokens.map((token) => token.url ?? null)
        ]
      );
    }

    await client.query(
      `insert into send_jobs (id, tenant_id, email_id, request_id, available_at)
       values ($1, $2, $3, $4, coalesce($5::timestamptz, now()))`,
      [id("job"), request.auth!.tenant_id, emailId, request.request_id, isScheduled ? scheduledAt : null]
    );

    if (isScheduled) {
      const event = await client.query(
        `insert into email_events (id, tenant_id, request_id, email_id, type, provider_event_id, data)
         values ($1, $2, $3, $4, 'email.scheduled', $5, $6)
         returning id`,
        [
          id("event"),
          request.auth!.tenant_id,
          request.request_id,
          emailId,
          `${emailId}:scheduled`,
          JSON.stringify({ scheduled_at: parsed.scheduled_at })
        ]
      );
      await client.query(
        `insert into webhook_attempts (id, tenant_id, request_id, webhook_id, event_id, state)
         select 'attempt_' || md5(random()::text || clock_timestamp()::text || id), tenant_id, $3, id, $4, 'queued'
         from webhooks where tenant_id = $1 and enabled = true and events ? $2`,
        [request.auth!.tenant_id, "email.scheduled", request.request_id, event.rows[0].id]
      );
    }

    const response = { email: { ...email.rows[0], to: recipients.filter((r) => r.kind === "to").map((r) => r.email) } };
    if (idemKey) {
      await client.query(
        "update idempotency_keys set response_json = $3, state = 'done' where tenant_id = $1 and key = $2",
        [request.auth!.tenant_id, idemKey, JSON.stringify(response)]
      );
    }
    return { ...response, request_id: request.request_id };
  });
}

async function readIdempotency(request: FastifyRequest, idemKey: string, requestHash: string) {
  const existing = await db.query(
    "select request_hash, response_json, state from idempotency_keys where tenant_id = $1 and key = $2 and expires_at > now()",
    [request.auth!.tenant_id, idemKey]
  );
  if (!existing.rows[0]) return null;
  if (existing.rows[0].request_hash !== requestHash) {
    throw new ApiError("idempotency_conflict", 409, "Idempotency key was used with a different payload");
  }
  if (existing.rows[0].state === "running") {
    throw new ApiError("idempotency_conflict", 409, "Idempotency request is still in flight");
  }
  return existing.rows[0].response_json;
}

async function findTemplate(request: FastifyRequest) {
  const templateId = (request.params as { id: string }).id;
  const row = await db.query(
    `select t.id, t.name, t.alias, t.published_version_id, t.created_at, t.updated_at,
       case when v.id is null then null else jsonb_build_object(
         'id', v.id,
         'template_id', v.template_id,
         'subject', v.subject,
         'html', v.html,
         'text', v.text,
         'variables', v.variables,
         'created_at', v.created_at,
         'published_at', v.published_at
       ) end as version
     from templates t
     left join template_versions v on v.id = t.published_version_id
     where t.tenant_id = $1 and t.id = $2 and t.deleted_at is null`,
    [request.auth!.tenant_id, templateId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Template not found");
  return row.rows[0];
}

async function publishedTemplate(
  client: Pick<typeof db, "query">,
  tenantId: string,
  ref: string
): Promise<{ id: string; template_id: string; subject: string; html?: string | null; text?: string | null; variables: string[] }> {
  const row = await client.query(
    `select v.id, v.template_id, v.subject, v.html, v.text, v.variables
     from templates t
     join template_versions v on v.id = t.published_version_id
     where t.tenant_id = $1 and t.deleted_at is null and (t.id = $2 or t.alias = $2 or t.name = $2)
     limit 1`,
    [tenantId, ref]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Published template not found");
  return row.rows[0];
}

async function findContact(request: FastifyRequest) {
  const contactId = (request.params as { id: string }).id;
  const row = await db.query(
    `select id, email, first_name, last_name, properties, unsubscribed_at, created_at, updated_at
     from contacts
     where tenant_id = $1 and id = $2 and deleted_at is null`,
    [request.auth!.tenant_id, contactId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Contact not found");
  return row.rows[0];
}

async function upsertContact(tenantId: string, email: string) {
  const row = await db.query<{ id: string; email: string }>(
    `insert into contacts (id, tenant_id, email, properties)
     values ($1, $2, $3, '{}')
     on conflict (tenant_id, email) do update set deleted_at = null, updated_at = now()
     returning id, email`,
    [id("contact"), tenantId, email]
  );
  return row.rows[0];
}

async function findTopic(request: FastifyRequest) {
  const topicId = (request.params as { id: string }).id;
  const row = await db.query(
    `select id, name, key, default_status, created_at, updated_at
     from topics
     where tenant_id = $1 and id = $2 and deleted_at is null`,
    [request.auth!.tenant_id, topicId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Topic not found");
  return row.rows[0];
}

async function findSegment(request: FastifyRequest) {
  const segmentId = (request.params as { id: string }).id;
  const row = await db.query(
    `select id, name, description, created_at, updated_at
     from segments
     where tenant_id = $1 and id = $2 and deleted_at is null`,
    [request.auth!.tenant_id, segmentId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Segment not found");
  return row.rows[0];
}

async function findBroadcast(request: FastifyRequest) {
  const broadcastId = (request.params as { id: string }).id;
  const row = await db.query<{
    id: string;
    name: string;
    from: string;
    subject: string | null;
    html: string | null;
    text: string | null;
    variables: Record<string, unknown>;
    topic_id: string | null;
    segment_id: string | null;
    status: string;
    recipient_count: number;
    sent_count: number;
    created_at: string;
    updated_at: string;
    sent_at: string | null;
  }>(
    `select id, name, from_email as from, subject, html, text, variables, topic_id, segment_id,
       status, recipient_count, sent_count, created_at, updated_at, sent_at
     from broadcasts
     where tenant_id = $1 and id = $2 and deleted_at is null`,
    [request.auth!.tenant_id, broadcastId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Broadcast not found");
  return row.rows[0];
}

async function buildBroadcast(
  tenantId: string,
  input: {
    from: string;
    subject?: string | null;
    html?: string | null;
    text?: string | null;
    template?: string;
    variables?: Record<string, unknown>;
    topic_id?: string | null;
    segment_id?: string | null;
  }
) {
  if (input.topic_id) {
    const topic = await db.query("select id from topics where tenant_id = $1 and id = $2 and deleted_at is null", [tenantId, input.topic_id]);
    if (!topic.rows[0]) throw new ApiError("not_found", 404, "Topic not found");
  }
  if (input.segment_id) {
    const segment = await db.query("select id from segments where tenant_id = $1 and id = $2 and deleted_at is null", [
      tenantId,
      input.segment_id
    ]);
    if (!segment.rows[0]) throw new ApiError("not_found", 404, "Segment not found");
  }

  let subject = input.subject ?? undefined;
  let html = input.html ?? undefined;
  let text = input.text ?? undefined;
  let templateId: string | null = null;
  let templateVersionId: string | null = null;
  if (input.template) {
    const template = await publishedTemplate(db, tenantId, input.template);
    const rendered = renderTemplate(template, input.variables ?? {});
    subject = subject ?? rendered.subject;
    html = html ?? rendered.html ?? undefined;
    text = text ?? rendered.text ?? undefined;
    templateId = template.template_id;
    templateVersionId = template.id;
  }
  if (!subject || (!html && !text)) throw new ApiError("validation_error", 400, "subject and content are required");
  return { subject, html, text, template_id: templateId, template_version_id: templateVersionId };
}

async function snapshotBroadcast(tenantId: string, broadcastId: string) {
  return tx(db, async (client) => {
    const broadcast = await client.query<{ topic_id: string | null; segment_id: string | null }>(
      "select topic_id, segment_id from broadcasts where tenant_id = $1 and id = $2 for update",
      [tenantId, broadcastId]
    );
    if (!broadcast.rows[0]) throw new ApiError("not_found", 404, "Broadcast not found");
    const rows = await client.query<{ contact_id: string; email: string }>(
      `select c.id as contact_id, c.email
       from contacts c
       left join topics t on t.tenant_id = c.tenant_id and t.id = $3 and t.deleted_at is null
       left join topic_subscriptions s on s.tenant_id = c.tenant_id and s.topic_id = t.id and s.contact_id = c.id
       where c.tenant_id = $1
         and c.deleted_at is null
         and c.unsubscribed_at is null
         and not exists (
           select 1 from suppressions sup
           where sup.tenant_id = c.tenant_id and sup.email = c.email and sup.removed_at is null
         )
         and (
           $2::text is null
           or exists (
             select 1 from segment_contacts sc
             where sc.tenant_id = c.tenant_id and sc.segment_id = $2 and sc.contact_id = c.id
           )
         )
         and (
           $3::text is null
           or (t.default_status = 'subscribed' and coalesce(s.status, 'subscribed') = 'subscribed')
           or (t.default_status = 'unsubscribed' and s.status = 'subscribed')
         )
       order by c.created_at`,
      [tenantId, broadcast.rows[0].segment_id, broadcast.rows[0].topic_id]
    );
    if (rows.rows.length === 0) return [];
    const inserted = await client.query<{ id: string; email: string }>(
      `insert into broadcast_recipients (id, tenant_id, broadcast_id, contact_id, email, status)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       on conflict (tenant_id, broadcast_id, contact_id)
       do update set email = excluded.email, status = 'queued', updated_at = now()
       returning id, email`,
      [
        rows.rows.map(() => id("br")),
        rows.rows.map(() => tenantId),
        rows.rows.map(() => broadcastId),
        rows.rows.map((row) => row.contact_id),
        rows.rows.map((row) => row.email),
        rows.rows.map(() => "queued")
      ]
    );
    return inserted.rows;
  });
}

type AutomationStep =
  | { type: "send_email"; from: string; to?: string; template: string; variables?: Record<string, unknown> }
  | { type: "update_contact"; email?: string; properties?: Record<string, unknown>; unsubscribed?: boolean }
  | { type: "add_to_segment"; segment_id: string; email?: string }
  | { type: "delay"; seconds: number }
  | { type: "wait"; event: string; timeout_seconds?: number };

async function createCustomEvent(
  request: FastifyRequest,
  input: { name: string; email?: string; data: Record<string, unknown> }
) {
  const created = await tx(db, async (client) => {
    const event = await client.query<{
      id: string;
      request_id: string;
      name: string;
      email: string | null;
      data: Record<string, unknown>;
      created_at: string;
    }>(
      `insert into custom_events (id, tenant_id, request_id, name, email, data)
       values ($1, $2, $3, $4, $5, $6)
       returning id, request_id, name, email, data, created_at`,
      [id("ce"), request.auth!.tenant_id, request.request_id, input.name, input.email ?? null, JSON.stringify(input.data)]
    );
    const automations = await client.query<{ id: string }>(
      `select id from automations
       where tenant_id = $1 and trigger = $2 and enabled = true and deleted_at is null
       order by created_at`,
      [request.auth!.tenant_id, input.name]
    );
    const runs = [];
    for (const automation of automations.rows) {
      const run = await client.query<{ id: string }>(
        `insert into automation_runs (id, tenant_id, automation_id, event_id, state)
         values ($1, $2, $3, $4, 'ready')
         returning id`,
        [id("run"), request.auth!.tenant_id, automation.id, event.rows[0].id]
      );
      runs.push(run.rows[0]);
    }

    const waiting = await client.query<{ id: string }>(
      `select r.id
       from automation_runs r
       join custom_events started on started.id = r.event_id
       where r.tenant_id = $1 and r.state = 'waiting' and r.wait_event = $2
         and (started.email is null or started.email = $3)
       order by r.updated_at, r.id
       for update of r skip locked`,
      [request.auth!.tenant_id, input.name, input.email ?? null]
    );
    const resumed = waiting.rows;
    if (resumed.length > 0) {
      await client.query(
        `update automation_runs
         set state = 'running', resume_at = null, wait_event = null, updated_at = now()
         where tenant_id = $1 and id = any($2)`,
        [request.auth!.tenant_id, resumed.map((run) => run.id)]
      );
      await client.query(
        `update automation_steps s
         set state = 'done',
           data = s.data || jsonb_build_object('event_id', $3::text, 'resumed_at', now())
         from automation_runs r
         where s.tenant_id = $1 and s.run_id = r.id and r.id = any($2)
           and s.state = 'waiting' and s.step_index = r.next_step_index - 1`,
        [request.auth!.tenant_id, resumed.map((run) => run.id), event.rows[0].id]
      );
    }

    return { event: event.rows[0], runs, resumed };
  });

  for (const run of created.runs) {
    await runAutomation(request, run.id);
  }
  for (const run of created.resumed) {
    await runAutomation(request, run.id);
  }

  const runs = await db.query(
    `select id, automation_id, event_id, state, next_step_index, resume_at, wait_event, error, created_at, updated_at
     from automation_runs
     where tenant_id = $1 and event_id = $2
     order by created_at`,
    [request.auth!.tenant_id, created.event.id]
  );
  const resumedRuns = created.resumed.length
    ? await db.query(
        `select id, automation_id, event_id, state, next_step_index, resume_at, wait_event, error, created_at, updated_at
         from automation_runs
         where tenant_id = $1 and id = any($2)
         order by updated_at`,
        [request.auth!.tenant_id, created.resumed.map((run) => run.id)]
      )
    : { rows: [] };
  return { event: created.event, runs: runs.rows, resumed_runs: resumedRuns.rows, request_id: request.request_id };
}

async function findCustomEvent(request: FastifyRequest) {
  const eventId = (request.params as { id: string }).id;
  const row = await db.query(
    `select id, request_id, name, email, data, created_at, updated_at
     from custom_events
     where tenant_id = $1 and id = $2 and deleted_at is null`,
    [request.auth!.tenant_id, eventId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Event not found");
  return row.rows[0];
}

async function findAutomation(request: FastifyRequest) {
  const automationId = (request.params as { id: string }).id;
  const row = await db.query<{
    id: string;
    name: string;
    trigger: string;
    steps: AutomationStep[];
    enabled: boolean;
    created_at: string;
    updated_at: string;
  }>(
    `select id, name, trigger, steps, enabled, created_at, updated_at
     from automations
     where tenant_id = $1 and id = $2 and deleted_at is null`,
    [request.auth!.tenant_id, automationId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Automation not found");
  return row.rows[0];
}

async function runAutomation(request: FastifyRequest, runId: string) {
  try {
    const run = await db.query<{
      id: string;
      tenant_id: string;
      automation_id: string;
      event_id: string;
      steps: AutomationStep[];
      event_name: string;
      email: string | null;
      data: Record<string, unknown>;
      state: string;
      next_step_index: number;
    }>(
      `select r.id, r.tenant_id, r.automation_id, r.event_id, r.state, r.next_step_index, a.steps,
         e.name as event_name, e.email, e.data
       from automation_runs r
       join automations a on a.id = r.automation_id
       join custom_events e on e.id = r.event_id
       where r.tenant_id = $1 and r.id = $2`,
      [request.auth!.tenant_id, runId]
    );
    const current = run.rows[0];
    if (!current) throw new ApiError("not_found", 404, "Automation run not found");
    if (current.state === "done" || current.state === "failed") return;
    await db.query(
      `update automation_runs
       set state = 'running', resume_at = null, wait_event = null, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [request.auth!.tenant_id, runId]
    );
    if (current.next_step_index > 0) {
      await db.query(
        `update automation_steps
         set state = 'done', data = data || jsonb_build_object('resumed_at', now())
         where tenant_id = $1 and run_id = $2 and step_index = $3 and state = 'waiting'`,
        [request.auth!.tenant_id, runId, current.next_step_index - 1]
      );
    }

    for (let index = current.next_step_index; index < current.steps.length; index += 1) {
      const step = current.steps[index];
      if (step.type === "delay" || step.type === "wait") {
        await pauseAutomation(request, current, index, step);
        return;
      }
      try {
        const data = await executeAutomationStep(request, current, step);
        await db.query(
          `insert into automation_steps (id, tenant_id, run_id, step_index, type, state, data)
           values ($1, $2, $3, $4, $5, 'done', $6)`,
          [id("step"), request.auth!.tenant_id, runId, index, step.type, JSON.stringify(data)]
        );
        await db.query("update automation_runs set next_step_index = $3, updated_at = now() where tenant_id = $1 and id = $2", [
          request.auth!.tenant_id,
          runId,
          index + 1
        ]);
      } catch (error) {
        await db.query(
          `insert into automation_steps (id, tenant_id, run_id, step_index, type, state, data, error)
           values ($1, $2, $3, $4, $5, 'failed', '{}', $6)`,
          [id("step"), request.auth!.tenant_id, runId, index, step.type, error instanceof Error ? error.message : String(error)]
        );
        throw error;
      }
    }

    await db.query(
      `update automation_runs
       set state = 'done', next_step_index = $3, resume_at = null, wait_event = null, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [request.auth!.tenant_id, runId, current.steps.length]
    );
  } catch (error) {
    await db.query("update automation_runs set state = 'failed', error = $3, updated_at = now() where tenant_id = $1 and id = $2", [
      request.auth!.tenant_id,
      runId,
      error instanceof Error ? error.message : String(error)
    ]);
  }
}

async function pauseAutomation(
  request: FastifyRequest,
  run: { id: string },
  index: number,
  step: Extract<AutomationStep, { type: "delay" | "wait" }>
) {
  const resumeAt =
    step.type === "delay"
      ? new Date(Date.now() + step.seconds * 1_000)
      : step.timeout_seconds
        ? new Date(Date.now() + step.timeout_seconds * 1_000)
        : null;
  const data =
    step.type === "delay"
      ? { seconds: step.seconds, resume_at: resumeAt?.toISOString() }
      : { event: step.event, timeout_at: resumeAt?.toISOString() };

  await tx(db, async (client) => {
    await client.query(
      `insert into automation_steps (id, tenant_id, run_id, step_index, type, state, data)
       values ($1, $2, $3, $4, $5, 'waiting', $6)`,
      [id("step"), request.auth!.tenant_id, run.id, index, step.type, JSON.stringify(data)]
    );
    await client.query(
      `update automation_runs
       set state = 'waiting', next_step_index = $3, resume_at = $4, wait_event = $5, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [request.auth!.tenant_id, run.id, index + 1, resumeAt, step.type === "wait" ? step.event : null]
    );
  });
}

async function executeAutomationStep(
  request: FastifyRequest,
  run: { id: string; automation_id: string; event_id: string; email: string | null; data: Record<string, unknown> },
  step: AutomationStep
) {
  if (step.type === "send_email") {
    const to = step.to ?? run.email;
    if (!to) throw new ApiError("validation_error", 400, "send_email step needs a recipient");
    const variables = { ...run.data, event: run.data, email: run.email, ...(step.variables ?? {}) };
    const response = await acceptEmail(
      request,
      {
        from: step.from,
        to,
        template: step.template,
        variables,
        tags: { automation_id: run.automation_id, automation_run_id: run.id, event_id: run.event_id }
      },
      { idempotency: false }
    );
    return { email_id: response.email.id };
  }

  if (step.type === "update_contact") {
    const email = step.email ?? run.email;
    if (!email) throw new ApiError("validation_error", 400, "update_contact step needs an email");
    const contact = await upsertContact(request.auth!.tenant_id, email);
    const row = await db.query(
      `update contacts set
         properties = properties || $3::jsonb,
         unsubscribed_at = case
           when $4::boolean is null then unsubscribed_at
           when $4 then coalesce(unsubscribed_at, now())
           else null
         end,
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning id, email, properties, unsubscribed_at`,
      [request.auth!.tenant_id, contact.id, JSON.stringify(step.properties ?? {}), step.unsubscribed ?? null]
    );
    return { contact_id: row.rows[0].id, email: row.rows[0].email };
  }

  if (step.type === "add_to_segment") {
    const email = step.email ?? run.email;
    if (!email) throw new ApiError("validation_error", 400, "add_to_segment step needs an email");
    const segment = await db.query("select id from segments where tenant_id = $1 and id = $2 and deleted_at is null", [
      request.auth!.tenant_id,
      step.segment_id
    ]);
    if (!segment.rows[0]) throw new ApiError("not_found", 404, "Segment not found");
    const contact = await upsertContact(request.auth!.tenant_id, email);
    await db.query(
      `insert into segment_contacts (id, tenant_id, segment_id, contact_id)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, segment_id, contact_id) do nothing`,
      [id("member"), request.auth!.tenant_id, step.segment_id, contact.id]
    );
    return { segment_id: step.segment_id, contact_id: contact.id, email };
  }

  throw new ApiError("validation_error", 400, `Unsupported automation step: ${step.type}`);
}

async function findEmail(request: FastifyRequest, emailId: string) {
  const row = await db.query("select id from emails where tenant_id = $1 and id = $2", [request.auth!.tenant_id, emailId]);
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Email not found");
  return row.rows[0];
}

type StoredAttachment = {
  id: string;
  filename: string;
  content_type: string;
  content_id?: string;
  disposition: "attachment" | "inline";
  size_bytes: number;
  content_hash: string;
  storage_key: string;
  bytes: Buffer;
};

function prepareAttachments(
  tenantId: string,
  ownerId: string,
  attachments: Array<{ filename: string; content: string; content_type?: string; content_id?: string; disposition?: "attachment" | "inline" }>,
  kind: "attachments" | "received"
) {
  let total = 0;
  return attachments.map((attachment) => {
    const bytes = decodeAttachment(attachment.content);
    total += Buffer.byteLength(attachment.content, "utf8");
    if (total > 40 * 1024 * 1024) throw new ApiError("invalid_attachment", 400, "Attachments exceed 40 MB after base64 encoding");
    const attachmentId = id(kind === "received" ? "ratt" : "att");
    return {
      id: attachmentId,
      filename: attachment.filename,
      content_type: attachment.content_type ?? "application/octet-stream",
      content_id: attachment.content_id,
      disposition: attachment.disposition ?? "attachment",
      size_bytes: bytes.byteLength,
      content_hash: hash(bytes.toString("base64")),
      storage_key: `${kind}/${tenantId}/${ownerId}/${attachmentId}`,
      bytes
    } satisfies StoredAttachment;
  });
}

function decodeAttachment(content: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content) || content.length % 4 !== 0) {
    throw new ApiError("invalid_attachment", 400, "Attachment content must be base64");
  }
  const bytes = Buffer.from(content, "base64");
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== content.replace(/=+$/, "")) {
    throw new ApiError("invalid_attachment", 400, "Attachment content must be base64");
  }
  return bytes;
}

async function writeBlob(storageKey: string, bytes: Buffer) {
  const path = blobPath(storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function blobPath(storageKey: string) {
  if (!/^[a-z]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(storageKey)) {
    throw new ApiError("invalid_storage_key", 400, "Invalid storage key");
  }
  const root = resolve(storageRoot);
  const path = resolve(root, storageKey);
  const child = relative(root, path);
  if (child.startsWith("..") || child === "" || child.startsWith("/")) {
    throw new ApiError("invalid_storage_key", 400, "Invalid storage key");
  }
  return path;
}

async function useTrackingToken(token: string, kind: "open" | "click", requestIdValue: string, data: Record<string, unknown>) {
  return tx(db, async (client) => {
    const row = await client.query<{
      token: string;
      tenant_id: string;
      email_id: string;
      recipient_id: string | null;
      kind: "open" | "click";
      url: string | null;
      used_at: string | null;
    }>(
      "select token, tenant_id, email_id, recipient_id, kind, url, used_at from tracking_tokens where token = $1 and kind = $2",
      [token, kind]
    );
    const tracking = row.rows[0];
    if (!tracking) return null;
    if (tracking.used_at) return tracking;
    const claimed = await client.query("update tracking_tokens set used_at = now() where token = $1 and used_at is null returning token", [token]);
    if (claimed.rowCount === 0) return tracking;
    const event = await appendEvent(client, {
      tenantId: tracking.tenant_id,
      requestId: requestIdValue,
      emailId: tracking.email_id,
      recipientId: tracking.recipient_id,
      type: kind === "open" ? "email.opened" : "email.clicked",
      providerEventId: `${token}:${kind}`,
      data: { ...data, url: tracking.url, token }
    });
    if (event) await fanoutEvent(client, event);
    return tracking;
  });
}

async function appendEvent(
  client: Pick<typeof db, "query">,
  input: {
    tenantId: string;
    requestId: string;
    emailId: string | null;
    recipientId?: string | null;
    type: string;
    providerEventId: string;
    data: Record<string, unknown>;
  }
) {
  const row = await client.query<{
    id: string;
    tenant_id: string;
    request_id: string | null;
    email_id: string | null;
    type: string;
    data: Record<string, unknown>;
  }>(
    `insert into email_events (id, tenant_id, request_id, email_id, recipient_id, type, provider_event_id, data)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (provider_event_id) do nothing
     returning id, tenant_id, request_id, email_id, type, data`,
    [
      id("event"),
      input.tenantId,
      input.requestId,
      input.emailId,
      input.recipientId ?? null,
      input.type,
      input.providerEventId,
      JSON.stringify(input.data)
    ]
  );
  const event = row.rows[0];
  if (!event) return null;

  if (input.emailId) {
    const status = statusForEvent(input.type);
    if (status) {
      await client.query(
        `update emails set status = $3, updated_at = now()
         where tenant_id = $1 and id = $2
           and status not in ('bounced', 'complained', 'failed', 'cancelled')`,
        [input.tenantId, input.emailId, status]
      );
    }
  }

  return event;
}

async function fanoutEvent(
  client: Pick<typeof db, "query">,
  event: { id: string; tenant_id: string; request_id: string | null; type: string }
) {
  await client.query(
    `insert into webhook_attempts (id, tenant_id, request_id, webhook_id, event_id, state)
     select 'attempt_' || md5(random()::text || clock_timestamp()::text || id), tenant_id, $3, id, $4, 'queued'
     from webhooks
     where tenant_id = $1 and enabled = true and events ? $2`,
    [event.tenant_id, event.type, event.request_id, event.id]
  );
}

function statusForEvent(type: string) {
  switch (type) {
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
    default:
      return null;
  }
}

async function authenticate(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new ApiError("missing_api_key", 401, "Missing API key");
  const secret = header.slice("Bearer ".length).trim();
  if (secret.startsWith("sess_")) {
    const session = await db.query(
      `select s.id, s.tenant_id, s.user_id, s.last_used_at, k.id as api_key_id, r.permissions
       from sessions s
       join memberships m on m.tenant_id = s.tenant_id and m.user_id = s.user_id and m.disabled_at is null
       join roles r on r.tenant_id = s.tenant_id and r.id = m.role_id and r.deleted_at is null
       join api_keys k on k.tenant_id = s.tenant_id and k.revoked_at is null and k.scope = 'full'
       where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
       order by k.created_at asc
       limit 1`,
      [hash(secret)]
    );
    if (!session.rows[0]) throw new ApiError("invalid_session", 401, "Invalid session");
    request.auth = {
      tenant_id: session.rows[0].tenant_id,
      api_key_id: session.rows[0].api_key_id,
      scope: "full",
      user_id: session.rows[0].user_id,
      session_id: session.rows[0].id,
      permissions: session.rows[0].permissions ?? []
    };
    const lastUsed = session.rows[0].last_used_at ? new Date(session.rows[0].last_used_at).getTime() : 0;
    if (Date.now() - lastUsed > 60_000) await db.query("update sessions set last_used_at = now() where id = $1", [session.rows[0].id]);
    return;
  }

  const apiKey = await validKey(secret);
  if (!apiKey) throw new ApiError("invalid_api_key", 401, "Invalid API key");
  request.auth = { tenant_id: apiKey.tenant_id, api_key_id: apiKey.id, scope: apiKey.scope };
  const lastUsed = apiKey.last_used_at ? new Date(apiKey.last_used_at).getTime() : 0;
  if (Date.now() - lastUsed > 60_000) {
    await db.query("update api_keys set last_used_at = now() where id = $1", [apiKey.id]);
    apiKey.last_used_at = new Date().toISOString();
  }
}

async function validKey(secret: string) {
  const prefix = secret.slice(0, 12);
  const expected = keyHash(secret, pepper);
  const cached = apiKeyCache.get(prefix);
  if (cached && cached.expires_at > Date.now()) {
    return safeEqualHex(cached.row.hash, expected) ? cached.row : null;
  }
  const row = await db.query<ApiKeyRow>(
    "select id, tenant_id, hash, scope, last_used_at from api_keys where prefix = $1 and revoked_at is null limit 1",
    [prefix]
  );
  const apiKey = row.rows[0];
  if (!apiKey || !safeEqualHex(apiKey.hash, expected)) return null;
  apiKeyCache.set(prefix, { row: apiKey, expires_at: Date.now() + authCacheTtlMs });
  return apiKey;
}

async function rateLimit(request: FastifyRequest, reply: FastifyReply) {
  const route = request.routeOptions.url ?? request.url.split("?")[0];
  const key = `rate:${request.auth!.tenant_id}:${request.auth!.api_key_id}:${route}:${Math.floor(Date.now() / 1000)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 2);
  const limitValue = Number(process.env.RATE_LIMIT_PER_SECOND ?? 5);
  reply.header("ratelimit-limit", String(limitValue));
  reply.header("ratelimit-remaining", String(Math.max(0, limitValue - count)));
  reply.header("ratelimit-reset", "1");
  if (count > limitValue) {
    reply.header("retry-after", "1");
    throw new ApiError("rate_limit_exceeded", 429, "Rate limit exceeded");
  }
}

function requireScope(request: FastifyRequest, scope: "full") {
  if (!request.auth) throw new ApiError("missing_api_key", 401, "Missing API key");
  if (scope === "full" && request.auth.scope !== "full") throw new ApiError("forbidden", 403, "Full access key required");
  if (scope === "full" && request.auth.user_id && !(request.auth.permissions ?? []).includes("full")) {
    throw new ApiError("forbidden", 403, "Full permission required");
  }
}

function requireSend(request: FastifyRequest) {
  if (!request.auth) throw new ApiError("missing_api_key", 401, "Missing API key");
  if (!["full", "send"].includes(request.auth.scope)) throw new ApiError("forbidden", 403, "Sending key required");
}

function limit(request: FastifyRequest) {
  const query = request.query as { limit?: string | number };
  const value = Number(query?.limit ?? 20);
  return Math.min(100, Math.max(1, Number.isFinite(value) ? value : 20));
}

function page(request: FastifyRequest) {
  const query = request.query as { limit?: string | number; after?: string; before?: string };
  return {
    limit: limit(request),
    fetch: limit(request) + 1,
    after: cursor(query.after),
    before: cursor(query.before)
  };
}

function pageList<T>(rows: T[], paging: { limit: number }) {
  return list(rows.slice(0, paging.limit), rows.length > paging.limit);
}

async function pageRows(request: FastifyRequest, sql: string, values: unknown[] = []) {
  const paging = page(request);
  const rows = await db.query(sql, [request.auth!.tenant_id, paging.fetch, paging.after, paging.before, ...values]);
  return { ...pageList(rows.rows, paging), request_id: request.request_id };
}

function idempotencyKey(request: FastifyRequest) {
  const key = request.headers["idempotency-key"]?.toString();
  if (!key) return undefined;
  if (key.length < 1 || key.length > 256) throw new ApiError("invalid_idempotency_key", 400, "Idempotency key must be 1-256 characters");
  return key;
}

function cursor(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError("invalid_cursor", 400, "Cursor must be an ISO timestamp");
  return date.toISOString();
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || id("topic")
  );
}

async function incrementUsage(tenantId: string | null, name: string, amount: number) {
  const period = new Date().toISOString().slice(0, 10);
  await db.query(
    `insert into usage_counters (id, tenant_id, name, period, value)
     values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, name, period)
     do update set value = usage_counters.value + excluded.value, updated_at = now()`,
    [id("usage"), tenantId, name, period, amount]
  );
}

function enqueueTelemetry(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.auth;
  logQueue.push({
    id: id("log"),
    tenant_id: auth?.tenant_id ?? null,
    request_id: request.request_id,
    user_agent: request.headers["user-agent"]?.toString() ?? null,
    method: request.method,
    path: request.url,
    status: reply.statusCode,
    latency_ms: Math.max(0, Date.now() - request.started_at),
    api_key_id: auth?.api_key_id ?? null
  });
  if (auth) addUsageDelta(auth.tenant_id, "api_requests", 1);

  if (auth && reply.statusCode < 400 && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    auditQueue.push({
      id: id("audit"),
      tenant_id: auth.tenant_id,
      request_id: request.request_id,
      actor_user_id: auth.user_id ?? null,
      api_key_id: auth.api_key_id,
      session_id: auth.session_id ?? null,
      action: `${request.method} ${request.routeOptions.url ?? request.url.split("?")[0]}`,
      data: { path: request.url, status: reply.statusCode }
    });
  }

  if (logQueue.length >= 100 || auditQueue.length >= 100 || usageDeltas.size >= 25) void flushTelemetry();
}

function addUsageDelta(tenantId: string, name: string, amount: number) {
  const key = `${tenantId}:${name}`;
  const current = usageDeltas.get(key);
  if (current) {
    current.amount += amount;
  } else {
    usageDeltas.set(key, { tenant_id: tenantId, name, amount });
  }
}

async function flushTelemetry() {
  if (telemetryFlushPromise) return telemetryFlushPromise;
  telemetryFlushPromise = flushTelemetryNow().finally(() => {
    telemetryFlushPromise = null;
  });
  return telemetryFlushPromise;
}

async function flushTelemetryNow() {
  while (logQueue.length > 0 || auditQueue.length > 0 || usageDeltas.size > 0) {
      const logs = logQueue.splice(0, 500);
      const audits = auditQueue.splice(0, 500);
      const usage = Array.from(usageDeltas.values());
      usageDeltas.clear();

      try {
        await tx(db, async (client) => {
          if (logs.length > 0) {
            await client.query(
              `insert into logs (id, tenant_id, request_id, user_agent, method, path, status, latency_ms, api_key_id)
               select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::integer[], $8::integer[], $9::text[])`,
              [
                logs.map((log) => log.id),
                logs.map((log) => log.tenant_id),
                logs.map((log) => log.request_id),
                logs.map((log) => log.user_agent),
                logs.map((log) => log.method),
                logs.map((log) => log.path),
                logs.map((log) => log.status),
                logs.map((log) => log.latency_ms),
                logs.map((log) => log.api_key_id)
              ]
            );
          }

          if (audits.length > 0) {
            await client.query(
              `insert into audit_logs (id, tenant_id, request_id, actor_user_id, api_key_id, session_id, action, data)
               select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::jsonb[])`,
              [
                audits.map((audit) => audit.id),
                audits.map((audit) => audit.tenant_id),
                audits.map((audit) => audit.request_id),
                audits.map((audit) => audit.actor_user_id),
                audits.map((audit) => audit.api_key_id),
                audits.map((audit) => audit.session_id),
                audits.map((audit) => audit.action),
                audits.map((audit) => JSON.stringify(audit.data))
              ]
            );
          }

          if (usage.length > 0) {
            const period = new Date().toISOString().slice(0, 10);
            await client.query(
              `insert into usage_counters (id, tenant_id, name, period, value)
               select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::integer[])
               on conflict (tenant_id, name, period)
               do update set value = usage_counters.value + excluded.value, updated_at = now()`,
              [
                usage.map(() => id("usage")),
                usage.map((row) => row.tenant_id),
                usage.map((row) => row.name),
                usage.map(() => period),
                usage.map((row) => row.amount)
              ]
            );
          }
        });
      } catch (error) {
        logQueue.unshift(...logs);
        auditQueue.unshift(...audits);
        for (const row of usage) addUsageDelta(row.tenant_id, row.name, row.amount);
        app.log.warn({ error }, "failed to flush telemetry");
        break;
      }
  }
}

function securityHeaders(reply: FastifyReply) {
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}

function allowedOrigin(origin?: string) {
  if (!origin) return true;
  const allowed = new Set(
    (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return allowed.has(origin);
}

function safeRequestId(value?: string) {
  if (value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return value;
  return requestId();
}

function publicSetupEnabled() {
  return (process.env.ALLOW_PUBLIC_SETUP ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true";
}

function passwordlessSessionsEnabled() {
  return (process.env.ALLOW_PASSWORDLESS_SESSIONS ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true";
}

async function publicRateLimit(request: FastifyRequest, reply: FastifyReply, route: string) {
  const limitValue = route === "/v1/sessions" ? Number(process.env.AUTH_RATE_LIMIT_PER_SECOND ?? 5) : Number(process.env.PUBLIC_RATE_LIMIT_PER_SECOND ?? 50);
  const key = `rate:public:${route}:${request.ip}:${Math.floor(Date.now() / 1000)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 2);
  reply.header("ratelimit-limit", String(limitValue));
  reply.header("ratelimit-remaining", String(Math.max(0, limitValue - count)));
  reply.header("ratelimit-reset", "1");
  if (count > limitValue) {
    reply.header("retry-after", "1");
    throw new ApiError("rate_limit_exceeded", 429, "Rate limit exceeded");
  }
}

async function verifiedDomain(client: Pick<typeof db, "query">, tenantId: string, domain: string) {
  const key = `${tenantId}:${domain}`;
  const cached = domainCache.get(key);
  if (cached && cached > Date.now()) return true;
  const verified = await client.query(
    "select id from domains where tenant_id = $1 and name = $2 and status = 'verified' and deleted_at is null",
    [tenantId, domain]
  );
  if (verified.rowCount === 0) return false;
  domainCache.set(key, Date.now() + domainCacheTtlMs);
  return true;
}

function clearDomainCache(tenantId: string) {
  for (const key of domainCache.keys()) {
    if (key.startsWith(`${tenantId}:`)) domainCache.delete(key);
  }
}

function safeEqualHex(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function webhookUrl(value: string) {
  try {
    return await normalizeWebhookUrl(value, {
      requireHttps: process.env.NODE_ENV === "production",
      allowPrivate: privateWebhookTargetsEnabled()
    });
  } catch (error) {
    throw new ApiError("validation_error", 400, error instanceof Error ? error.message : "Invalid webhook URL");
  }
}

function privateWebhookTargetsEnabled() {
  return (process.env.ALLOW_PRIVATE_WEBHOOKS ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true";
}

function rawInbound(input: { attachments?: Array<Record<string, unknown>>; [key: string]: unknown }) {
  return {
    ...input,
    attachments: (input.attachments ?? []).map((attachment) => {
      const { content, ...meta } = attachment;
      return {
        ...meta,
        content_hash: typeof content === "string" ? hash(content) : null,
        content_bytes: typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0
      };
    })
  };
}

function assertProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  const forbidden = new Set([
    "dev-pepper-change-before-deploy",
    "sk_local_dispatch_dev_key_change_before_deploy",
    "dev-secret-change-before-deploy"
  ]);
  for (const [name, value] of Object.entries({
    API_KEY_PEPPER: process.env.API_KEY_PEPPER,
    DISPATCH_API_KEY: process.env.DISPATCH_API_KEY,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET
  })) {
    if (value && forbidden.has(value)) throw new Error(`${name} must be changed before production`);
  }
  if ((process.env.SES_PROVIDER ?? "fake") === "fake" && process.env.ALLOW_FAKE_PROVIDER !== "true") {
    throw new Error("Fake provider is disabled in production");
  }
}

async function findDomain(request: FastifyRequest) {
  const domainId = (request.params as { id: string }).id;
  const row = await db.query(
    "select id, name, region, status, records, checked_at, created_at from domains where tenant_id = $1 and id = $2 and deleted_at is null",
    [request.auth!.tenant_id, domainId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Domain not found");
  return row.rows[0];
}

function domainRecords(name: string, region: string) {
  return [
    { type: "TXT", name, value: "v=spf1 include:amazonses.com ~all", status: "pending" },
    { type: "CNAME", name: `dkim1._domainkey.${name}`, value: `dkim1.${region}.amazonses.com`, status: "pending" },
    { type: "MX", name: `send.${name}`, value: `10 feedback-smtp.${region}.amazonses.com`, status: "pending" },
    { type: "CNAME", name: `links.${name}`, value: process.env.TRACKING_DOMAIN ?? "links.localhost", status: "pending" }
  ];
}

const port = Number(process.env.PORT ?? 3100);
const host = process.env.API_HOST ?? process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
await app.listen({ port, host });
