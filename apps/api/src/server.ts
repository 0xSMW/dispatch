import "@dispatchmail/core/env";
import cors from "@fastify/cors";
import { ConfirmSubscriptionCommand, SNSClient } from "@aws-sdk/client-sns";
import MessageValidator from "sns-validator";
import { waitUntil } from "@vercel/functions";
import { awsCredentials } from "@dispatchmail/core";
import { applySesEvent, mapSesEvent, type SesEvent } from "../../worker/src/events.js";
import { countHit as postgresCountHit, postgresSignins, pruneCounters } from "./counters.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  ApiError,
  brandContext,
  brandSchema,
  brandTextColor,
  type BrandRecord,
  batchEnvelopeSchema,
  domainSchema,
  domainUpdateSchema,
  emailUpdateSchema,
  decrypt,
  encrypt,
  encrypted,
  type EventType,
  hash,
  id,
  inboundSchema,
  keyHash,
  keySchema,
  keyUpdateSchema,
  list,
  makeWebhookSecret,
  makeKey,
  normalizeWebhookUrl,
  renderSchema,
  renderTemplate,
  requestId,
  requireSecret,
  assertRealProvider,
  requireUrl,
  shareSchema,
  stableHash,
  templateSchema,
  templateUpdateSchema,
  templateVersionSchema,
  toArray,
  webhookDeliveryStatus,
  webhookSchema,
  webhookUpdateSchema,
} from "@dispatchmail/core";
import {
  acceptBatch,
  acceptEmail,
  appendEvent,
  applyHtmlFormat,
  attachmentsFromInbound,
  claimIdempotency,
  clearBrandCache,
  emailDetail,
  emit,
  ingestReceived,
  connect,
  fanoutEvent,
  findBy,
  incrementUsage,
  emailMetrics,
  paginate,
  parseMetricsQuery,
  addTemplateVersion,
  createTemplate,
  loadBrand,
  listTemplateVersions,
  publishTemplate,
  publishedTemplate,
  retrackEmail,
  replaceUnsubscribe,
  subscriptionLinks,
  textFromHtml,
  templateDetail,
  templateFrom,
  templateSelect,
  updateTemplateMeta,
  type TemplateRecord,
  type TemplateWrite,
  softDelete,
  tx,
  upsertContact,
  type AcceptEmailContext,
  type PagingParams,
} from "@dispatchmail/db";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { checkRecords, createIdentity, createSesProvider, deleteIdentity, dnsRecords, nodeResolvers, publishRoute53, route53Client, sesClient } from "@dispatchmail/provider-ses";
import { contentDisposition, createStorage, readSignedFile, signedUrlTtl } from "@dispatchmail/storage";
import { registerAudience } from "./audience.js";
import { registerAutomations } from "./automations.js";
import { registerEvents } from "./events.js";
import { emailWhere, type EmailQuery } from "./emails.js";
import { domainWhere, receivedWhere, templateWhere, type DomainQuery, type ReceivedQuery, type TemplateQuery } from "./filters.js";
import { registerImports } from "./imports.js";
import { registerInsights } from "./insights.js";
import { registerLinks } from "./links.js";
import { permitted, presentKey, readOnly, registerPlatform, type KeyRow } from "./platform.js";
import { rateKey, rateLimitValue, sessionRateKey, sessionRateLimitValue, signins } from "./rate.js";
import { registerBroadcasts } from "./broadcasts.js";
import { registerUnsubscribe } from "./unsubscribe.js";
import {
  installLibraryTemplate,
  libraryEntry,
  listLibrary,
  loadLibrary,
  previewLibrary,
} from "./library.js";
import { hideLinks, hostOnly, jsonbParams, logBodies, logWhere, presentLog, responseText, type LogQuery, type StoredLog } from "./logs.js";
import { presentDomain, presentEmail, presentWebhook, type DomainRow, type EmailRow, type WebhookRecord } from "./present.js";
import {
  listWebhookEvents,
  presentStoredWebhook,
  queueWebhookReplay,
  rotateWebhookSecret,
  webhookEventAttempts,
  webhookEventDetail,
} from "./webhooks.js";
import { presentTemplate, presentVersion, templateContentChanged } from "./templates.js";
import { scheduleAt, withSchedule } from "./schedule.js";
import { loadSharedEmail, readShareToken, shareExpiry, shareToken } from "./share.js";

type Auth = {
  tenant_id: string;
  api_key_id: string;
  scope: "full" | "send";
  domain_name?: string | null;
  user_id?: string;
  session_id?: string;
  permissions?: string[];
};

declare module "fastify" {
  interface FastifyRequest {
    request_id: string;
    started_at: number;
    auth?: Auth;
    response_text?: string | null;
  }
}

type ApiKeyRow = {
  id: string;
  tenant_id: string;
  hash: string;
  scope: "full" | "send";
  domain_id: string | null;
  domain_name: string | null;
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
  request_body: unknown;
  response_body: unknown;
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
const vercelRuntime = process.env.WORKER_RUNTIME === "vercel";
const postgresCounters = process.env.COUNTER_BACKEND === "postgres";
const redis = postgresCounters ? null : new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const pepper = requireSecret("API_KEY_PEPPER");
const storage = createStorage();
const appSecret = requireSecret("APP_SECRET");
const publicUrl = requireUrl("PUBLIC_URL", "http://localhost:3100");
const appUrl = requireUrl("APP_URL", "http://localhost:5173");
const bodyLimit = Number(process.env.MAX_BODY_BYTES ?? 50 * 1024 * 1024);
const authCacheTtlMs = Number(process.env.AUTH_CACHE_TTL_MS ?? 5_000);
const domainCacheTtlMs = Number(process.env.DOMAIN_CACHE_TTL_MS ?? 5_000);
// Sealed tokens in paths (/unsubscribe/:token, /shared/:token) run past Fastify's default 100 characters.
const app = Fastify({
  // The request log must not hold the tokens in public URLs: a token is the whole credential there.
  logger: {
    serializers: {
      req(request: { method?: string; url?: string }) {
        return { method: request.method, url: redactPath(request.url ?? "") };
      },
    },
  },
  bodyLimit,
  maxParamLength: 1024,
  // Behind a load balancer the client address is in X-Forwarded-For. TRUST_PROXY says how far
  // to trust it: a hop count ("1"), or a list of proxy addresses or ranges. Unset, the socket
  // address is used, which behind a proxy is the proxy itself and puts every caller of the
  // public routes into one rate-limit bucket.
  trustProxy: trustProxy(),
});
const apiKeyCache = new Map<string, { row: ApiKeyRow; expires_at: number }>();
const domainCache = new Map<string, number>();
const logQueue: LogRecord[] = [];
const auditQueue: AuditRecord[] = [];
const usageDeltas = new Map<
  string,
  { tenant_id: string; name: string; amount: number }
>();
let telemetryFlushPromise: Promise<void> | null = null;

assertProductionConfig();

await app.register(cors, {
  origin(origin, callback) {
    callback(null, allowedOrigin(origin));
  },
  allowedHeaders: [
    "authorization",
    "content-type",
    "idempotency-key",
    "x-batch-validation",
    "x-request-id",
  ],
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
});

const telemetryTimer = vercelRuntime ? null : setInterval(
  () => {
    void flushTelemetry();
  },
  Number(process.env.TELEMETRY_FLUSH_MS ?? 100),
);
telemetryTimer?.unref();

app.addHook("onRequest", async (request, reply) => {
  request.started_at = Date.now();
  request.request_id = safeRequestId(
    request.headers["x-request-id"]?.toString(),
  );
  securityHeaders(reply);
  reply.header("x-request-id", request.request_id);
  if (!request.headers["user-agent"])
    reply.header("dispatch-warning", "missing_user_agent");
});

app.addHook("preHandler", async (request, reply) => {
  const path = request.url.split("?")[0];
  if (path === "/internal/reconcile" || path === "/internal/events") return;
  if (
    request.url === "/health" ||
    // Public setup lets a caller with no key ask whether the install is seeded. A caller who
    // sends a key is authenticated as usual and gets their own tenant.
    (path === "/setup" && publicSetupEnabled() && !request.headers.authorization) ||
    (request.method === "POST" && path === "/sessions") ||
    path.startsWith("/open/") ||
    path.startsWith("/click/") ||
    path.startsWith("/files/") ||
    path.startsWith("/shared/") ||
    path.startsWith("/unsubscribe/")
  ) {
    // Keyed on the route pattern. Keyed on the path, every token in /unsubscribe/:token or
    // /click/:token would get its own bucket and the limit would never apply.
    await publicRateLimit(request, reply, request.routeOptions.url ?? path);
    return;
  }
  await authenticate(request);
  await rateLimit(request, reply);

  const routeScope =
    (request.routeOptions.config as { scope?: string } | undefined)?.scope ??
    "full";
  // A dashboard user's role decides what they may call. A read-only role gets GET routes and
  // its own account, and nothing that sends mail. A role with neither full nor read gets nothing.
  const allowed = !request.auth!.user_id || permitted(request.auth!.permissions ?? [], request.method, request.routeOptions.url ?? path);
  if (routeScope === "full") {
    if (request.auth!.scope !== "full") {
      throw new ApiError("restricted_api_key", 401, "Full access key required");
    }
    if (!allowed) throw new ApiError("forbidden", 403, "Full permission required");
  } else if (routeScope === "send") {
    if (!["full", "send"].includes(request.auth!.scope)) {
      throw new ApiError("forbidden", 403, "Sending key required");
    }
    if (!allowed) throw new ApiError("forbidden", 403, "Full permission required");
  }
});

app.addHook("preSerialization", async (request, reply, payload) => {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    !Buffer.isBuffer(payload) &&
    !(payload instanceof Readable) &&
    !("request_id" in (payload as Record<string, unknown>))
  ) {
    (payload as Record<string, unknown>).request_id = request.request_id;
  }
  return payload;
});

app.addHook("onSend", async (request, reply, payload) => {
  if (vercelRuntime && reply.statusCode < 400 && ["POST", "PATCH", "DELETE"].includes(request.method) && !request.url.startsWith("/internal/")) {
    const { wakeWorker } = await import("./workflows/worker.js");
    await wakeWorker();
  }
  request.response_text = responseText(payload);
  return payload;
});

app.addHook("onResponse", async (request, reply) => {
  enqueueTelemetry(request, reply);
  if (vercelRuntime) waitUntil(flushTelemetry());
});

app.setErrorHandler((error, request, reply) => {
  const err = error as { statusCode?: number; message?: string };
  const zodIssues = (
    error as {
      issues?: Array<{ message?: string; path?: Array<string | number> }>;
    }
  ).issues;
  const errorName = error instanceof Error ? error.name : "";
  const isSchemaError = errorName === "ZodError" && Array.isArray(zodIssues);
  // Postgres unique violation: two writers raced past the same existence check.
  const isDuplicate = (error as { code?: string }).code === "23505";
  const statusCode = isSchemaError
    ? 400
    : isDuplicate
      ? 409
      : typeof err.statusCode === "number"
        ? err.statusCode
        : 500;
  // Driver and runtime messages name tables, columns, and hosts. Log them, return a fixed message.
  if (!(error instanceof ApiError) && !isSchemaError && statusCode >= 500) {
    request.log.error({ err: error }, "request failed");
  }
  // The first issue is the message. Every issue, with its path into the body, is listed beside
  // it so a form can put each one on the right field.
  const issues = isSchemaError
    ? zodIssues.map((issue) => ({ path: (issue.path ?? []).join("."), message: issue.message ?? "Invalid value" }))
    : undefined;
  const apiError =
    error instanceof ApiError
      ? error
      : isSchemaError
        ? new ApiError(
            "validation_error",
            400,
            zodIssues[0]?.message ?? "Invalid request",
          )
        : isDuplicate
          ? new ApiError("validation_error", 409, "A record with these values already exists")
          : statusCode >= 500
            ? new ApiError("application_error", statusCode, "Unexpected error")
            : new ApiError("validation_error", statusCode, err.message ?? "Invalid request");

  reply.status(apiError.statusCode).send({
    name: apiError.name,
    statusCode: apiError.statusCode,
    message: apiError.message,
    ...(issues ? { path: issues[0]?.path ?? "", issues } : {}),
    request_id: request.request_id,
  });
});

app.get("/health", async () => {
  await db.query("select 1");
  if (redis) await redis.ping();
  return { ok: true, provider: process.env.SES_PROVIDER ?? "fake" };
});


app.get("/internal/reconcile", async (request) => {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const credential = Buffer.from(supplied);
  if (!secret || credential.length !== expected.length || !timingSafeEqual(credential, expected)) {
    throw new ApiError("forbidden", 403, "Invalid cron credential");
  }
  const { wakeWorker } = await import("./workflows/worker.js");
  await wakeWorker();
  if (postgresCounters) await pruneCounters(db);
  return { ok: true };
});

// SNS sends application/json or text/plain depending on subscription configuration.
app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => {
  try { done(null, JSON.parse(String(body))); }
  catch { done(new ApiError("validation_error", 400, "Invalid notification JSON")); }
});
const snsValidator = new MessageValidator();
app.post("/internal/events", async (request) => {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("validation_error", 400, "Invalid notification");
  const notification = body as Record<string, unknown>;
  if (!process.env.SNS_TOPIC_ARN || notification.TopicArn !== process.env.SNS_TOPIC_ARN) throw new ApiError("forbidden", 403, "Unexpected notification topic");
  await new Promise<void>((resolve, reject) => snsValidator.validate(notification, (error) => error ? reject(new ApiError("forbidden", 403, "Invalid notification signature")) : resolve()));
  if (notification.Type === "SubscriptionConfirmation") {
    if (typeof notification.Token !== "string") throw new ApiError("validation_error", 400, "Missing subscription token");
    const sns = new SNSClient({ region: process.env.AWS_REGION ?? "us-west-2", credentials: awsCredentials() });
    await sns.send(new ConfirmSubscriptionCommand({ TopicArn: process.env.SNS_TOPIC_ARN, Token: notification.Token }));
    return { ok: true };
  }
  if (notification.Type !== "Notification" || typeof notification.Message !== "string") throw new ApiError("validation_error", 400, "Unsupported notification");
  let event: SesEvent;
  try { event = JSON.parse(notification.Message); }
  catch { throw new ApiError("validation_error", 400, "Invalid event JSON"); }
  try {
    if (!event || typeof event !== "object" || Array.isArray(event) || !mapSesEvent(event)) throw new Error("Invalid event");
  } catch { throw new ApiError("validation_error", 400, "Invalid SES event"); }
  try {
    const applied = await tx(db, (client) => applySesEvent(client, event));
    if (!applied) throw new ApiError("validation_error", 400, "Unmatched SES event");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    request.log.error(error);
    throw new ApiError("application_error", 503, "Event processing unavailable; retry notification");
  }
  const { wakeWorker } = await import("./workflows/worker.js");
  await wakeWorker();
  return { ok: true };
});

registerPlatform(app, {
  db,
  paging,
  flushTelemetry,
  validKey,
  sessionsEnabled: passwordlessSessionsEnabled,
  signins: postgresCounters ? postgresSignins(db) : signins(redis!),
  quota: sendingQuota,
});

app.post("/api-keys", async (request) => {
  const input = keySchema.parse(request.body);
  if (input.domain_id) {
    await findBy(db, "domains", request.auth!.tenant_id, input.domain_id, {
      errorMessage: "Domain not found",
    });
  }
  const { secret, prefix } = makeKey();
  const row = await db.query(
    `insert into api_keys (id, tenant_id, name, prefix, hash, scope, domain_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      id("key"),
      request.auth!.tenant_id,
      input.name,
      prefix,
      keyHash(secret, pepper),
      input.scope,
      input.domain_id,
      // Known only for a key made in the dashboard, where a person is signed in.
      request.auth!.user_id ?? null,
    ],
  );
  apiKeyCache.clear();
  return { id: row.rows[0].id, object: "api_key", token: secret };
});

app.get("/api-keys", async (request) => {
  const page = await paginate<Omit<KeyRow, "total_uses">>(
    db,
    {
      table: "api_keys",
      tenantId: request.auth!.tenant_id,
      deletedCol: null,
      where: "revoked_at is null",
      select:
        "id, name, prefix, scope, domain_id, created_at, last_used_at, created_by, (select u.email from users u where u.id = api_keys.created_by) as creator",
    },
    paging(request),
  );
  // The masked token and the permission are on each row so a list can show them. Use counts
  // stay on the detail route, which has to scan the logs for them.
  return {
    ...page,
    data: page.data.map((row) => {
      const { total_uses: _uses, ...key } = presentKey({ ...row, total_uses: 0 });
      return key;
    }),
  };
});

app.get("/api-keys/:id", async (request) => {
  await flushTelemetry();
  const row = await db.query<KeyRow>(
    `select k.id, k.name, k.prefix, k.scope, k.domain_id, k.created_at, k.last_used_at, k.created_by,
       (select u.email from users u where u.id = k.created_by) as creator,
       (select count(*) from logs l where l.tenant_id = k.tenant_id and l.api_key_id = k.id)::integer as total_uses
     from api_keys k
     where k.tenant_id = $1 and k.id = $2 and k.revoked_at is null`,
    [request.auth!.tenant_id, (request.params as { id: string }).id],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "API key not found");
  return presentKey(row.rows[0]);
});

app.patch("/api-keys/:id", async (request) => {
  const keyId = (request.params as { id: string }).id;
  const input = keyUpdateSchema.parse(request.body);
  const row = await db.query(
    `update api_keys set name = $3
     where tenant_id = $1 and id = $2 and revoked_at is null
     returning id`,
    [request.auth!.tenant_id, keyId, input.name],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "API key not found");
  apiKeyCache.clear();
  return { object: "api_key", id: keyId };
});

app.delete("/api-keys/:id", async (request) => {
  const keyId = (request.params as { id: string }).id;
  const row = await db.query(
    "update api_keys set revoked_at = now() where tenant_id = $1 and id = $2 and revoked_at is null returning id",
    [request.auth!.tenant_id, keyId],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "API key not found");
  apiKeyCache.clear();
  return { object: "api_key", id: keyId, deleted: true };
});

const domainColumns =
  "id, name, region, status, records, checked_at, created_at, return_path, open_tracking, click_tracking, tracking_subdomain, tls, sending, receiving, dns_provider";

app.post("/domains", async (request) => {
  const input = domainSchema.parse(request.body);
  const existing = await db.query(
    "select id from domains where tenant_id = $1 and name = $2 and deleted_at is null",
    [request.auth!.tenant_id, input.name],
  );
  if (existing.rows[0]) {
    throw new ApiError("validation_error", 403, "This domain has already been added");
  }
  const tokens = await identityTokens(input.name, input.region, input.custom_return_path);
  const records = domainRecords(input.name, input.region, tokens, {
    returnPath: input.custom_return_path,
    trackingSubdomain: input.tracking_subdomain,
    receiving: input.capabilities.receiving === "enabled",
  });
  const row = await db.query<DomainRow>(
    `insert into domains (
       id, tenant_id, name, region, status, records, dkim_tokens,
       return_path, open_tracking, click_tracking, tracking_subdomain, tls, sending, receiving
     )
     values ($1, $2, $3, $4, 'not_started', $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (tenant_id, name) do update set
       region = excluded.region,
       status = 'not_started',
       checked_at = null,
       verify_started_at = null,
       created_at = now(),
       records = excluded.records,
       dkim_tokens = excluded.dkim_tokens,
       return_path = excluded.return_path,
       open_tracking = excluded.open_tracking,
       click_tracking = excluded.click_tracking,
       tracking_subdomain = excluded.tracking_subdomain,
       tls = excluded.tls,
       sending = excluded.sending,
       receiving = excluded.receiving,
       deleted_at = null,
       updated_at = now()
     where domains.deleted_at is not null
     returning ${domainColumns}`,
    [
      id("domain"),
      request.auth!.tenant_id,
      input.name,
      input.region,
      JSON.stringify(records),
      JSON.stringify(tokens),
      input.custom_return_path,
      input.open_tracking,
      input.click_tracking,
      input.tracking_subdomain ?? "links",
      input.tls,
      input.capabilities.sending,
      input.capabilities.receiving,
    ],
  );
  // No row means a concurrent request created the same live domain between the check and the insert.
  if (!row.rows[0]) {
    throw new ApiError("validation_error", 403, "This domain has already been added");
  }
  await emitChange(request, "domain.created", row.rows[0].id, {
    id: row.rows[0].id,
    name: row.rows[0].name,
    status: row.rows[0].status,
  });
  clearDomainCache(request.auth!.tenant_id);
  return presentDomain(row.rows[0]);
});

app.get("/domains", async (request) => {
  const filters = domainWhere(request.query as DomainQuery);
  const page = await paginate<DomainRow>(
    db,
    {
      table: "domains",
      tenantId: request.auth!.tenant_id,
      select: domainColumns,
      deletedCol: "deleted_at",
      where: filters.where,
      params: filters.params,
    },
    paging(request),
  );
  return { ...page, data: page.data.map((row) => presentDomain(row)) };
});

app.get("/domains/:id", async (request) => {
  const domain = await findBy<DomainRow>(
    db,
    "domains",
    request.auth!.tenant_id,
    (request.params as { id: string }).id,
    { select: domainColumns },
  );
  return presentDomain(domain);
});

app.patch("/domains/:id", async (request) => {
  const domainId = (request.params as { id: string }).id;
  const input = domainUpdateSchema.parse(request.body);
  const current = await findBy<DomainRow & { dkim_tokens: string[] | null }>(db, "domains", request.auth!.tenant_id, domainId, {
    select: `${domainColumns}, dkim_tokens`,
  });
  const sending = input.capabilities?.sending ?? current.sending ?? "enabled";
  const receiving = input.capabilities?.receiving ?? current.receiving ?? "disabled";
  if (sending !== "enabled" && receiving !== "enabled") {
    throw new ApiError("validation_error", 422, "enable sending or receiving");
  }
  // The SES identity already exists. Creating it again fails, so rebuild the records from the stored DKIM tokens.
  const tokens = current.dkim_tokens ?? [];
  const records = keepRecordStatus(
    current.records ?? [],
    domainRecords(current.name, current.region, tokens, {
      returnPath: current.return_path ?? "send",
      trackingSubdomain: input.tracking_subdomain ?? current.tracking_subdomain ?? "links",
      receiving: receiving === "enabled",
    }),
  );
  const row = await db.query<DomainRow>(
    `update domains set
       records = $3,
       open_tracking = $4,
       click_tracking = $5,
       tracking_subdomain = $6,
       tls = $7,
       sending = $8,
       receiving = $9,
       updated_at = now()
     where tenant_id = $1 and id = $2
     returning ${domainColumns}`,
    [
      request.auth!.tenant_id,
      domainId,
      JSON.stringify(records),
      input.open_tracking ?? current.open_tracking ?? false,
      input.click_tracking ?? current.click_tracking ?? false,
      input.tracking_subdomain ?? current.tracking_subdomain ?? "links",
      input.tls ?? current.tls ?? "opportunistic",
      sending,
      receiving,
    ],
  );
  await emitChange(request, "domain.updated", domainId, {
    id: row.rows[0].id,
    name: row.rows[0].name,
    status: row.rows[0].status,
  });
  clearDomainCache(request.auth!.tenant_id);
  return presentDomain(row.rows[0]);
});

app.post("/domains/:id/verify", async (request) => {
  const domainId = (request.params as { id: string }).id;
  const live = (process.env.SES_PROVIDER ?? "fake") === "ses";
  const row = await tx(db, async (client) => {
    const updated = await client.query(
      live
        ? `update domains set status = 'pending', checked_at = now(), verify_started_at = coalesce(verify_started_at, now())
           where tenant_id = $1 and id = $2 and deleted_at is null
           returning id, name, region, status, records, checked_at, created_at`
        : `update domains set status = 'verified', checked_at = now()
           where tenant_id = $1 and id = $2 and deleted_at is null
           returning id, name, region, status, records, checked_at, created_at`,
      [request.auth!.tenant_id, domainId],
    );
    if (!updated.rows[0]) throw new ApiError("not_found", 404, "Domain not found");
    await emit(client, {
      tenantId: request.auth!.tenant_id,
      requestId: request.request_id,
      type: "domain.updated",
      resourceId: domainId,
      data: { id: domainId, status: updated.rows[0].status },
    });
    return updated.rows[0];
  });
  clearDomainCache(request.auth!.tenant_id);
  return { object: "domain", id: domainId };
});

app.get("/domains/:id/doctor", async (request) => {
  const domain = await findBy<{
    id: string;
    status: string;
    records: Array<{ record: "DKIM" | "SPF" | "DMARC" | "Tracking" | "Receiving MX"; name: string; type: "CNAME" | "TXT" | "MX"; value: string; status: string; ttl: string; priority?: number }>;
  }>(
    db,
    "domains",
    request.auth!.tenant_id,
    (request.params as { id: string }).id,
  );
  const checks = await checkRecords(domain.records ?? [], nodeResolvers);
  return { domain: domain.id, checks };
});

app.post("/domains/:id/publish-route53", async (request) => {
  const domain = await findBy<{ id: string; name: string; records: Array<{ record: "DKIM" | "SPF" | "DMARC" | "Tracking" | "Receiving MX"; name: string; type: "CNAME" | "TXT" | "MX"; value: string; status: string; ttl: string; priority?: number }> }>(
    db,
    "domains",
    request.auth!.tenant_id,
    (request.params as { id: string }).id,
  );
  return publishRoute53(route53Client(), { name: domain.name, records: domain.records ?? [] });
});

app.delete("/domains/:id", async (request) => {
  const domainId = (request.params as { id: string }).id;
  const domain = await findBy<{ name: string; region: string }>(db, "domains", request.auth!.tenant_id, domainId);
  if ((process.env.SES_PROVIDER ?? "fake") === "ses") {
    await deleteIdentity(sesClient(domain.region), domain.name);
  }
  const removed = await softDelete(db, "domains", request.auth!.tenant_id, domainId);
  if (removed.rowCount) await emitChange(request, "domain.deleted", domainId, { id: domainId });
  clearDomainCache(request.auth!.tenant_id);
  return { object: "domain", id: domainId, deleted: true };
});

app.post("/templates", async (request) => {
  const input = templateSchema.parse(request.body);
  const row = await tx(db, (client) => createTemplate(client, request.auth!.tenant_id, input));
  return presentTemplate(row);
});

app.get("/templates", async (request) => {
  const filters = templateWhere(request.query as TemplateQuery);
  const page = await paginate<TemplateRecord>(
    db,
    {
      table: templateFrom,
      tenantId: request.auth!.tenant_id,
      tenantCol: "t.tenant_id",
      createdCol: "t.created_at",
      idCol: "t.id",
      deletedCol: "t.deleted_at",
      where: filters.where,
      params: filters.params,
      select: templateSelect,
    },
    paging(request),
  );
  return { ...page, data: page.data.map(presentTemplate) };
});

app.get("/templates/:id", async (request) => {
  const row = await templateDetail(db, request.auth!.tenant_id, (request.params as { id: string }).id);
  return presentTemplate(row);
});

app.patch("/templates/:id", async (request) => {
  const input = templateUpdateSchema.parse(request.body ?? {});
  const tenantId = request.auth!.tenant_id;
  const current = await templateDetail(db, tenantId, (request.params as { id: string }).id);
  if (templateContentChanged(input) || input.publish || input.name !== undefined || input.alias !== undefined || input.track !== undefined) {
    await tx(db, async (client) => {
      if (templateContentChanged(input)) {
        const next: TemplateWrite = {
          name: input.name ?? current.name,
          from: input.from !== undefined ? input.from : current.from_address,
          reply_to: input.reply_to !== undefined ? (input.reply_to ?? []) : (current.reply_to ?? []),
          subject: input.subject !== undefined ? input.subject : current.subject,
          html: input.html !== undefined ? input.html : current.html,
          text: input.text !== undefined ? input.text : current.text,
          variables: input.variables !== undefined ? input.variables : (current.variables ?? []),
          source: input.source,
          publish: input.publish,
        };
        // An edit to a template whose latest version was never published changes that version.
        await addTemplateVersion(client, tenantId, current.id, next, { reuseDraft: true });
      } else if (input.publish) {
        await publishTemplate(client, tenantId, current.id);
      }
      if (input.track !== undefined) {
        await client.query(
          "update templates set track = $3, updated_at = now() where tenant_id = $1 and id = $2",
          [tenantId, current.id, input.track],
        );
      }
      if (input.name !== undefined || input.alias !== undefined) {
        await updateTemplateMeta(client, tenantId, current.id, { name: input.name, alias: input.alias });
      }
    });
  }
  return presentTemplate(await templateDetail(db, tenantId, current.id));
});

app.delete("/templates/:id", async (request) => {
  const template = await templateDetail(db, request.auth!.tenant_id, (request.params as { id: string }).id);
  await softDelete(db, "templates", request.auth!.tenant_id, template.id);
  return { object: "template", id: template.id, deleted: true };
});

app.post("/templates/:id/versions", async (request) => {
  const input = templateVersionSchema.parse(request.body);
  const template = await templateDetail(db, request.auth!.tenant_id, (request.params as { id: string }).id);
  const row = await tx(db, (client) => addTemplateVersion(client, request.auth!.tenant_id, template.id, {
    name: template.name,
    from: input.from,
    reply_to: input.reply_to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    variables: input.variables,
    source: input.source,
    track: input.track,
  }));
  return presentTemplate(row);
});

app.get("/templates/:id/versions", async (request) => {
  const template = await templateDetail(db, request.auth!.tenant_id, (request.params as { id: string }).id);
  const versions = await listTemplateVersions(db, request.auth!.tenant_id, template.id);
  return { object: "list", has_more: false, data: versions.map(presentVersion) };
});

app.post("/templates/:id/publish", async (request) => {
  const body = (request.body ?? {}) as { version_id?: string };
  const row = await tx(db, (client) => publishTemplate(
    client,
    request.auth!.tenant_id,
    (request.params as { id: string }).id,
    body.version_id,
  ));
  return presentTemplate(row);
});

app.get("/template-library", async () => {
  return listLibrary(await loadLibrary());
});

app.get("/template-library/:slug", async (request) => {
  const entry = libraryEntry(await loadLibrary(), (request.params as { slug: string }).slug);
  return previewLibrary(entry, await previewBrand(request.auth!.tenant_id));
});

app.post("/template-library/:slug/install", async (request) => {
  const library = await loadLibrary();
  // One transaction: a failure between the template row and its version leaves nothing behind.
  return tx(db, (client) =>
    installLibraryTemplate(client, request.auth!.tenant_id, library, (request.params as { slug: string }).slug),
  );
});

// `variables` holds the reserved template names exactly as a preview render fills them, so the
// dashboard's own preview does not have to repeat the fallback rules.
app.get("/brand", async (request) => {
  return { ...presentBrand(await tenantBrand(request.auth!.tenant_id)), variables: await previewBrand(request.auth!.tenant_id) };
});

app.patch("/brand", async (request) => {
  const input = brandSchema.parse(request.body ?? {});
  const current = await tenantBrand(request.auth!.tenant_id);
  const next: BrandRecord = { ...current };
  for (const [key, value] of Object.entries(input)) {
    if (value === null) delete next[key as keyof BrandRecord];
    else (next as Record<string, unknown>)[key] = value;
  }
  await db.query("update tenants set brand = $2 where id = $1", [request.auth!.tenant_id, JSON.stringify(next)]);
  clearBrandCache(request.auth!.tenant_id);
  return { ...presentBrand(next), variables: await previewBrand(request.auth!.tenant_id) };
});

app.post("/templates/:id/render", async (request) => {
  const input = renderSchema.parse(request.body ?? {});
  const ref = (request.params as { id: string }).id;
  if (input.draft) {
    const latest = await templateDetail(db, request.auth!.tenant_id, ref);
    return { rendered: renderTemplate(latest, input.variables, await previewBrand(request.auth!.tenant_id)) };
  }
  try {
    const template = await publishedTemplate(db, request.auth!.tenant_id, ref);
    const context = await previewBrand(request.auth!.tenant_id);
    return { rendered: renderTemplate(template, input.variables, context) };
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode !== 404) throw error;
    await templateDetail(db, request.auth!.tenant_id, ref);
    throw new ApiError("conflict", 409, "Template has no published version");
  }
});

app.post("/templates/:id/duplicate", async (request) => {
  const source = await templateDetail(db, request.auth!.tenant_id, (request.params as { id: string }).id);
  const raw = (request.body ?? {}) as { name?: string };
  const body = templateUpdateSchema.pick({ name: true }).parse(raw.name === undefined ? {} : { name: raw.name });
  const row = await tx(db, (client) => createTemplate(client, request.auth!.tenant_id, {
    name: body.name ?? `${source.name} (Copy)`,
    from: source.from_address,
    reply_to: source.reply_to ?? [],
    subject: source.subject,
    html: source.html,
    text: source.text,
    variables: source.variables ?? [],
    track: source.track ?? true,
    source: source.source ?? undefined,
  }));
  return presentTemplate(row);
});

registerAudience(app, { db, paging, emitChange, slug });
registerImports(app, { db, storage, paging });
registerInsights(app, { db });
registerLinks(app);

registerBroadcasts(app, { db, paging });
registerUnsubscribe(app, { db, secret: appSecret });

registerAutomations(app, { db, paging });
registerEvents(app, { db, paging });

app.post(
  "/emails",
  { config: { scope: "send" } },
  async (request, reply) => {
    const response = await acceptEmail(db, request.body, emailContext(request), {
      prepare: withSchedule,
      publicUrl,
      unsubscribe: { secret: appSecret, appUrl, publicUrl },
      storeAttachment: writeBlob,
    });
    reply.status(200);
    return { id: response.email.id, ...(response.emails ? { emails: response.emails } : {}) };
  },
);

app.post(
  "/emails/batch",
  { config: { scope: "send" } },
  async (request, reply) => {
    // Only the list's shape is checked here. Each email is validated as it is accepted, so
    // permissive mode can queue the valid ones and report the others by index.
    const emails = batchEnvelopeSchema.parse(request.body);
    const header = request.headers["x-batch-validation"]?.toString();
    if (header && header !== "strict" && header !== "permissive") {
      throw new ApiError("validation_error", 400, "x-batch-validation must be strict or permissive");
    }
    const response = await acceptBatch(db, emails, emailContext(request), {
      validation: header === "permissive" ? "permissive" : "strict",
      prepare: withSchedule,
      publicUrl,
      unsubscribe: { secret: appSecret, appUrl, publicUrl },
      storeAttachment: writeBlob,
    });
    reply.status(200);
    return response;
  },
);

app.get("/emails", async (request) => {
  const filters = emailWhere(request.query as EmailQuery);
  const page = await paginate<EmailRow & { to: string[]; cc: string[]; bcc: string[] }>(
    db,
    "emails e left join email_recipients r on r.email_id = e.id",
    request.auth!.tenant_id,
    paging(request),
    {
      tenantCol: "e.tenant_id",
      createdCol: "e.created_at",
      idCol: "e.id",
      where: filters.where,
      params: filters.params,
      groupBy: "e.id",
      select: `e.id, e.message_id, e.from_email, e.from_name, e.subject, e.reply_to, e.status, e.scheduled_at, e.tags, e.created_at,
        coalesce(json_agg(r.email order by r.created_at) filter (where r.kind = 'to'), '[]') as to,
        coalesce(json_agg(r.email order by r.created_at) filter (where r.kind = 'cc'), '[]') as cc,
        coalesce(json_agg(r.email order by r.created_at) filter (where r.kind = 'bcc'), '[]') as bcc`,
    },
  );
  return {
    ...page,
    data: page.data.map((row) =>
      presentEmail({
        ...row,
        recipients: [
          ...(row.to ?? []).map((email) => ({ email, kind: "to" })),
          ...(row.cc ?? []).map((email) => ({ email, kind: "cc" })),
          ...(row.bcc ?? []).map((email) => ({ email, kind: "bcc" })),
        ],
      }),
    ),
  };
});

app.get("/emails/metrics", async (request) => {
  const input = parseMetricsQuery((request.query ?? {}) as Record<string, unknown>);
  return emailMetrics(db, request.auth!.tenant_id, input);
});

app.get("/emails/:id", async (request) => {
  const emailId = (request.params as { id: string }).id;
  const email = await emailDetail(db, request.auth!.tenant_id, emailId);
  const shown = presentEmail(email as unknown as EmailRow);
  // The stored copy carries the recipient's unsubscribe, click, and open links, which act
  // without a session. A read-only user sees the email without them.
  return readOnly(request.auth) ? { ...shown, html: hideLinks(shown.html), text: hideLinks(shown.text) } : shown;
});

app.get("/emails/:id/attachments", async (request) => {
  const emailId = (request.params as { id: string }).id;
  await findBy(db, "emails", request.auth!.tenant_id, emailId, {
    errorMessage: "Email not found",
  });
  const page = await paginate<AttachmentRow>(
    db,
    "email_attachments",
    request.auth!.tenant_id,
    paging(request),
    {
      where: "email_id = $2",
      params: [emailId],
      select: "id, filename, content_type, disposition, size_bytes, content_id, storage_key, created_at",
    },
  );
  return { ...page, data: await Promise.all(page.data.map((row) => signedAttachment(row, urlTtl(request)))) };
});

app.get("/emails/:id/attachments/:attachment_id", async (request) => {
  const { id: emailId, attachment_id: attachmentId } = request.params as {
    id: string;
    attachment_id: string;
  };
  await findBy(db, "emails", request.auth!.tenant_id, emailId, {
    errorMessage: "Email not found",
  });
  const row = await db.query<AttachmentRow>(
    `select id, filename, content_type, size_bytes, content_id, disposition, storage_key, created_at
     from email_attachments
     where tenant_id = $1 and email_id = $2 and id = $3`,
    [request.auth!.tenant_id, emailId, attachmentId],
  );
  if (!row.rows[0])
    throw new ApiError("not_found", 404, "Attachment not found");
  return signedAttachment(row.rows[0], urlTtl(request));
});

app.get("/files/*", async (request, reply) => {
  const token = (request.params as { "*": string })["*"];
  const file = await readSignedFile(token, storage, appSecret);
  reply.header("content-type", "application/octet-stream");
  reply.header("content-disposition", contentDisposition(file.filename));
  return file.bytes;
});

app.get("/emails/:id/events", async (request) => {
  const emailId = (request.params as { id: string }).id;
  await findBy(db, "emails", request.auth!.tenant_id, emailId, {
    errorMessage: "Email not found",
  });
  return paginate(
    db,
    "email_events",
    request.auth!.tenant_id,
    paging(request),
    {
      where: "email_id = $2",
      params: [emailId],
      orderDirection: "asc",
      select: "id, request_id, type, data, created_at",
    },
  );
});

app.patch("/emails/:id", { config: { scope: "send" } }, async (request) => {
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
      from_email: string;
      topic_id: string | null;
      contact_id: string | null;
      broadcast_id: string | null;
    }>(
      `select id, subject, html, text, headers, tags, status, scheduled_at, from_email, topic_id, contact_id, broadcast_id
       from emails
       where tenant_id = $1 and id = $2
       for update`,
      [request.auth!.tenant_id, emailId],
    );
    const email = current.rows[0];
    if (!email) throw new ApiError("not_found", 404, "Email not found");
    assertKeyDomain(request, email.from_email);
    if (!["queued", "scheduled"].includes(email.status))
      throw new ApiError(
        "conflict",
        409,
        "Email cannot be updated after dispatch",
      );
    const runningJob = await client.query(
      "select id from send_jobs where tenant_id = $1 and email_id = $2 and state = 'running' limit 1",
      [request.auth!.tenant_id, emailId],
    );
    if (runningJob.rows[0])
      throw new ApiError("conflict", 409, "Email dispatch is already running");

    const scheduledAt =
      input.scheduled_at === undefined
        ? email.scheduled_at
          ? new Date(email.scheduled_at)
          : null
        : scheduleAt(input.scheduled_at);
    const nextStatus =
      scheduledAt && scheduledAt.getTime() > Date.now()
        ? "scheduled"
        : "queued";
    let html = input.html === undefined ? email.html : input.html;
    let headers = input.headers ?? email.headers ?? {};
    let context: Record<string, unknown> = {};
    if (email.topic_id) {
      const recipient = await client.query<{ email: string }>(
        "select email from email_recipients where tenant_id = $1 and email_id = $2 order by created_at, id limit 1",
        [request.auth!.tenant_id, emailId],
      );
      if (!recipient.rows[0]) throw new ApiError("validation_error", 422, "Marketing email needs a recipient");
      const links = subscriptionLinks({
        tenantId: request.auth!.tenant_id, emailId, contactId: email.contact_id,
        email: recipient.rows[0].email, topicId: email.topic_id, broadcastId: email.broadcast_id,
        secret: appSecret, appUrl, publicUrl,
      });
      context = links.context;
      html = replaceUnsubscribe(html, context) ?? null;
      headers = {
        ...Object.fromEntries(Object.entries(headers).filter(([key]) => !["list-unsubscribe", "list-unsubscribe-post"].includes(key.toLowerCase()))),
        ...links.headers,
      };
    }
    const htmlChanged = input.html !== undefined && input.html !== email.html;
    // New HTML with no new text gets its text rebuilt, so the two parts of the message agree.
    let text = input.text !== undefined ? input.text : htmlChanged && html ? textFromHtml(html) : email.text;
    if (email.topic_id) text = replaceUnsubscribe(text, context) ?? null;
    if (!html && !text)
      throw new ApiError("validation_error", 400, "html or text is required");
    // The worker sends the tracked copy. Left alone, it would still hold the old HTML.
    if (htmlChanged) {
      const tracked = await retrackEmail(client, { tenantId: request.auth!.tenant_id, emailId, html, publicUrl });
      await client.query("update emails set html_tracked = $3 where tenant_id = $1 and id = $2", [
        request.auth!.tenant_id,
        emailId,
        tracked,
      ]);
    }

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
        JSON.stringify(headers),
        JSON.stringify(input.tags ?? email.tags ?? {}),
        scheduledAt,
        nextStatus,
      ],
    );
    await client.query(
      `update send_jobs
       set state = 'ready', available_at = coalesce($3::timestamptz, now()), updated_at = now()
       where tenant_id = $1 and email_id = $2 and state in ('ready', 'failed')`,
      [
        request.auth!.tenant_id,
        emailId,
        nextStatus === "scheduled" ? scheduledAt : null,
      ],
    );
    if (nextStatus === "scheduled") {
      const event = await appendEvent(client, {
        tenantId: request.auth!.tenant_id,
        requestId: request.request_id,
        emailId,
        type: "email.scheduled",
        providerEventId: `${emailId}:rescheduled:${Date.now()}`,
        data: { scheduled_at: scheduledAt?.toISOString() },
      });
      if (event) await fanoutEvent(client, event);
    }
    return updated.rows[0];
  });
  return { object: "email", id: row.id };
});

app.post(
  "/emails/:id/cancel",
  { config: { scope: "send" } },
  async (request) => {
    const emailId = (request.params as { id: string }).id;
    await tx(db, async (client) => {
      const current = await client.query<{ status: string; from_email: string }>(
        "select status, from_email from emails where tenant_id = $1 and id = $2 for update",
        [request.auth!.tenant_id, emailId],
      );
      const email = current.rows[0];
      if (!email) throw new ApiError("not_found", 404, "Email not found");
      assertKeyDomain(request, email.from_email);
      if (!["queued", "scheduled"].includes(email.status)) {
        throw new ApiError("conflict", 409, "Email cannot be cancelled");
      }
      await client.query(
        "update emails set status = 'cancelled', updated_at = now() where tenant_id = $1 and id = $2",
        [request.auth!.tenant_id, emailId],
      );
      await client.query(
        "update send_jobs set state = 'cancelled' where tenant_id = $1 and email_id = $2 and state = 'ready'",
        [request.auth!.tenant_id, emailId],
      );
    });
    return { object: "email", id: emailId };
  },
);

app.post(
  "/emails/:id/retry",
  { config: { scope: "send" } },
  async (request) => {
    const emailId = (request.params as { id: string }).id;
    const job = await tx(db, async (client) => {
      const email = await client.query<{ id: string; status: string; from_email: string }>(
        "select id, status, from_email from emails where tenant_id = $1 and id = $2 for update",
        [request.auth!.tenant_id, emailId],
      );
      if (!email.rows[0]) throw new ApiError("not_found", 404, "Email not found");
      assertKeyDomain(request, email.rows[0].from_email);
      if (
        ["queued", "scheduled", "sent", "delivered"].includes(
          email.rows[0].status,
        )
      ) {
        throw new ApiError("conflict", 409, "Email does not need retry");
      }
      const row = await client.query(
        `insert into send_jobs (id, tenant_id, email_id, request_id, state, available_at)
         values ($1, $2, $3, $4, 'ready', now())
         returning id, email_id, state, available_at, created_at`,
        [id("job"), request.auth!.tenant_id, emailId, request.request_id],
      );
      // A retry sends the message again on purpose, so the earlier provider id is cleared.
      await client.query(
        "update emails set status = 'queued', provider_message_id = null, updated_at = now() where tenant_id = $1 and id = $2",
        [request.auth!.tenant_id, emailId],
      );
      return row.rows[0];
    });
    return { job };
  },
);

app.post("/webhooks", async (request) => {
  const input = webhookSchema.parse(request.body);
  const url = await webhookUrl(input.endpoint ?? "");
  const secret = makeWebhookSecret();
  const row = await db.query(
    `insert into webhooks (id, tenant_id, url, events, secret, enabled)
     values ($1, $2, $3, $4, $5, $6)
     returning id, url, events, enabled, created_at`,
    [
      id("webhook"),
      request.auth!.tenant_id,
      url,
      JSON.stringify(input.events ?? ["email.sent"]),
      encrypt(secret, appSecret),
      input.enabled ?? true,
    ],
  );
  return presentWebhook(row.rows[0], secret);
});

app.get("/webhooks", async (request) => {
  const page = await paginate<{
    id: string;
    url: string;
    events: string[];
    enabled: boolean;
    created_at: string;
  }>(db, "webhooks", request.auth!.tenant_id, paging(request), {
    select: "id, url, events, enabled, created_at",
  });
  return { ...page, data: page.data.map((row) => (readOnly(request.auth) ? viewerWebhook(row) : presentWebhook(row))) };
});

app.post("/webhooks/test", async (request) => {
  const eventId = id("event");
  const row = await db.query(
    `insert into email_events (id, tenant_id, request_id, type, data)
     values ($1, $2, $3, 'email.sent', $4)
     returning id, request_id, type, data, created_at`,
    [
      eventId,
      request.auth!.tenant_id,
      request.request_id,
      JSON.stringify({ test: true }),
    ],
  );
  await db.query(
    `insert into webhook_attempts (id, tenant_id, request_id, webhook_id, event_id, state)
     select 'attempt_' || md5(random()::text || clock_timestamp()::text || id), tenant_id, $3, id, $2, 'queued'
     from webhooks where tenant_id = $1 and enabled = true and events ? 'email.sent'`,
    [request.auth!.tenant_id, eventId, request.request_id],
  );
  return { event: row.rows[0] };
});

app.get("/webhooks/:id", async (request) => {
  const webhook = await findBy<WebhookRecord & { secret: string }>(
    db,
    "webhooks",
    request.auth!.tenant_id,
    (request.params as { id: string }).id,
    {
      select: "id, url, events, enabled, secret, created_at",
      errorMessage: "Webhook not found",
    },
  );
  // The signing secret lets its holder forge deliveries. A read-only user does not see it.
  return readOnly(request.auth) ? viewerWebhook(webhook) : presentStoredWebhook(webhook, appSecret);
});

// A read-only user sees neither the signing secret nor the part of the URL that can hold a credential.
function viewerWebhook(webhook: Parameters<typeof presentWebhook>[0]) {
  const { signing_secret: _secret, ...shown } = presentWebhook(webhook) as ReturnType<typeof presentWebhook> & { signing_secret?: string };
  return { ...shown, endpoint: hostOnly(shown.endpoint) };
}

app.patch("/webhooks/:id", async (request) => {
  const webhookId = (request.params as { id: string }).id;
  const input = webhookUpdateSchema.parse(request.body);
  const current = await findBy<WebhookRecord & { secret: string }>(
    db,
    "webhooks",
    request.auth!.tenant_id,
    webhookId,
    {
      select: "id, url, events, enabled, secret, created_at",
      errorMessage: "Webhook not found",
    },
  );
  const url = input.endpoint ? await webhookUrl(input.endpoint) : current.url;
  const storedSecret = encrypted(current.secret)
    ? current.secret
    : encrypt(current.secret, appSecret);
  const row = await db.query<WebhookRecord & { secret: string }>(
    `update webhooks set url = $3, events = $4, enabled = $5, secret = $6, updated_at = now()
     where tenant_id = $1 and id = $2
     returning id, url, events, enabled, secret, created_at`,
    [
      request.auth!.tenant_id,
      webhookId,
      url,
      JSON.stringify(input.events ?? current.events),
      input.enabled ?? current.enabled,
      storedSecret,
    ],
  );
  // Switching an endpoint back on starts its health record fresh. With the old failing_since in
  // place, the first failure after a fix would disable it again at once.
  if (input.enabled === true && !current.enabled) {
    await db.query("delete from webhook_endpoint_health where tenant_id = $1 and webhook_id = $2", [
      request.auth!.tenant_id,
      webhookId,
    ]);
  }
  return presentStoredWebhook(row.rows[0]!, appSecret);
});

app.delete("/webhooks/:id", async (request) => {
  const webhookId = (request.params as { id: string }).id;
  const row = await db.query(
    "delete from webhooks where tenant_id = $1 and id = $2 returning id",
    [request.auth!.tenant_id, webhookId],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Webhook not found");
  return { object: "webhook", id: webhookId, deleted: true };
});

app.post("/webhooks/:id/signing-secret/rotate", async (request) => {
  return rotateWebhookSecret(
    db,
    request.auth!.tenant_id,
    (request.params as { id: string }).id,
    appSecret,
  );
});

app.get("/webhooks/:id/events", async (request) => {
  const webhookId = (request.params as { id: string }).id;
  await findBy(db, "webhooks", request.auth!.tenant_id, webhookId, {
    errorMessage: "Webhook not found",
  });
  const query = request.query as { limit?: string; after?: string; before?: string };
  return listWebhookEvents(db, request.auth!.tenant_id, webhookId, {
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
    after: query.after || undefined,
    before: query.before || undefined,
  });
});

app.get("/webhooks/:id/events/:event_id", async (request) => {
  const params = request.params as { id: string; event_id: string };
  await findBy(db, "webhooks", request.auth!.tenant_id, params.id, {
    errorMessage: "Webhook not found",
  });
  return webhookEventDetail(db, request.auth!.tenant_id, params.id, params.event_id);
});

app.get("/webhooks/:id/events/:event_id/attempts", async (request) => {
  const params = request.params as { id: string; event_id: string };
  await findBy(db, "webhooks", request.auth!.tenant_id, params.id, {
    errorMessage: "Webhook not found",
  });
  return webhookEventAttempts(db, request.auth!.tenant_id, params.id, params.event_id);
});

app.post("/webhooks/:id/events/:event_id/replay", async (request) => {
  const params = request.params as { id: string; event_id: string };
  await findBy(db, "webhooks", request.auth!.tenant_id, params.id, {
    errorMessage: "Webhook not found",
  });
  return queueWebhookReplay(db, {
    tenantId: request.auth!.tenant_id,
    webhookId: params.id,
    eventId: params.event_id,
    requestId: request.request_id,
  });
});

app.post("/emails/receiving/simulate", async (request) => {
  const input = inboundSchema.parse(request.body);
  const received = await tx(db, (client) =>
    ingestReceived(client, {
      tenantId: request.auth!.tenant_id,
      requestId: request.request_id,
      from: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: input.headers,
      raw: rawInbound(input),
      attachments: attachmentsFromInbound(input.attachments),
      storeAttachment: (key, bytes) => storage.put(key, bytes),
    }),
  );
  return presentReceived(received);
});

app.get("/emails/receiving", async (request) => {
  const filters = receivedWhere(request.query as ReceivedQuery);
  return paginate(
    db,
    "received_emails m left join received_recipients r on r.received_email_id = m.id",
    request.auth!.tenant_id,
    paging(request),
    {
      tenantCol: "m.tenant_id",
      createdCol: "m.created_at",
      idCol: "m.id",
      where: filters.where,
      params: filters.params,
      groupBy: "m.id",
      select: `m.id, m.message_id, m.from_email as from, m.subject, m.reply_to, m.created_at,
        coalesce(json_agg(r.email order by r.created_at) filter (where r.kind = 'to'), '[]') as to,
        coalesce(json_agg(r.email order by r.created_at) filter (where r.kind = 'cc'), '[]') as cc,
        coalesce(json_agg(r.email order by r.created_at) filter (where r.kind = 'bcc'), '[]') as bcc`,
    },
  );
});

app.get("/emails/receiving/:id", async (request) => {
  const receivedId = (request.params as { id: string }).id;
  const format = (request.query as { html_format?: string }).html_format;
  const row = await findBy<Record<string, unknown>>(
    db,
    "received_emails",
    request.auth!.tenant_id,
    receivedId,
    {
      select: "id, request_id, from_email as from, subject, html, text, headers, message_id, reply_to, authentication, raw_key, created_at",
      errorMessage: "Received email not found",
    },
  );
  const recipients = await db.query<{ id: string; email: string; kind: string; created_at: string }>(
    "select id, email, kind, created_at from received_recipients where tenant_id = $1 and received_email_id = $2 order by created_at",
    [request.auth!.tenant_id, receivedId],
  );
  const attachments = await db.query<AttachmentRow & { bytes?: Buffer }>(
    "select id, filename, content_type, size_bytes, content_id, storage_key, created_at from received_attachments where tenant_id = $1 and received_email_id = $2 order by created_at",
    [request.auth!.tenant_id, receivedId],
  );
  const withBytes = [];
  for (const attachment of attachments.rows) {
    if (format === "cid" || !attachment.content_id) {
      withBytes.push(attachment);
      continue;
    }
    withBytes.push({ ...attachment, bytes: await storage.get(attachment.storage_key) });
  }
  const signed = await Promise.all(attachments.rows.map((attachment) => signedAttachment(attachment, urlTtl(request))));
  const raw = row.raw_key
    ? await storage.url(String(row.raw_key), { filename: "message.eml", expiresIn: urlTtl(request) })
    : null;
  return presentReceived({
    ...row,
    html: applyHtmlFormat(row.html as string | null, format, withBytes),
    to: recipients.rows.filter((recipient) => recipient.kind === "to").map((recipient) => recipient.email),
    cc: recipients.rows.filter((recipient) => recipient.kind === "cc").map((recipient) => recipient.email),
    bcc: recipients.rows.filter((recipient) => recipient.kind === "bcc").map((recipient) => recipient.email),
    received_for: recipients.rows.filter((recipient) => recipient.kind === "to").map((recipient) => recipient.email),
    recipients: recipients.rows,
    attachments: signed,
    raw,
  });
});

app.get("/emails/receiving/:id/attachments", async (request) => {
  const receivedId = (request.params as { id: string }).id;
  await findBy(db, "received_emails", request.auth!.tenant_id, receivedId, {
    errorMessage: "Received email not found",
  });
  const page = await paginate<AttachmentRow>(
    db,
    "received_attachments",
    request.auth!.tenant_id,
    paging(request),
    {
      where: "received_email_id = $2",
      params: [receivedId],
      select: "id, filename, content_type, size_bytes, content_id, storage_key, created_at",
    },
  );
  return { ...page, data: await Promise.all(page.data.map((row) => signedAttachment(row, urlTtl(request)))) };
});

app.get("/emails/receiving/:id/attachments/:attachment_id", async (request) => {
  const { id: receivedId, attachment_id: attachmentId } = request.params as {
    id: string;
    attachment_id: string;
  };
  const row = await db.query<AttachmentRow>(
    `select id, filename, content_type, size_bytes, content_id, storage_key, created_at
     from received_attachments
     where tenant_id = $1 and received_email_id = $2 and id = $3`,
    [request.auth!.tenant_id, receivedId, attachmentId],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Received attachment not found");
  return signedAttachment(row.rows[0], urlTtl(request));
});

app.post("/emails/:id/share", async (request) => {
  const emailId = (request.params as { id: string }).id;
  const body = shareSchema.parse(request.body ?? {});
  const sent = await db.query(
    "select id from emails where tenant_id = $1 and id = $2",
    [request.auth!.tenant_id, emailId],
  );
  let kind: "sent" | "received" = "sent";
  if (!sent.rows[0]) {
    const received = await db.query(
      "select id from received_emails where tenant_id = $1 and id = $2",
      [request.auth!.tenant_id, emailId],
    );
    if (!received.rows[0]) throw new ApiError("not_found", 404, "Email not found");
    kind = "received";
  }
  const exp = shareExpiry(body.expires_in);
  const token = shareToken(
    { tenantId: request.auth!.tenant_id, emailId, kind, exp },
    appSecret,
  );
  const base = (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
  return { object: "email", id: emailId, url: `${base}/shared?token=${encodeURIComponent(token)}` };
});

app.get("/shared/:token", async (request) => {
  const payload = readShareToken((request.params as { token: string }).token, appSecret);
  if (!payload) throw new ApiError("not_found", 404, "Email not found");
  const email = await loadSharedEmail(db, payload);
  if (!email) throw new ApiError("not_found", 404, "Email not found");
  return email;
});

app.get("/open/:token.gif", async (request, reply) => {
  const token = (request.params as { token: string }).token;
  const row = await useTrackingToken(token, "open", request.request_id, {
    user_agent: request.headers["user-agent"]?.toString() ?? null,
    ip: request.ip,
  });
  if (!row) throw new ApiError("not_found", 404, "Tracking token not found");
  reply.header("content-type", "image/gif");
  reply.header("cache-control", "no-store");
  return Buffer.from(
    "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
    "base64",
  );
});

app.get("/click/:token", async (request, reply) => {
  const token = (request.params as { token: string }).token;
  const row = await useTrackingToken(token, "click", request.request_id, {
    user_agent: request.headers["user-agent"]?.toString() ?? null,
    ip: request.ip,
  });
  if (!row?.url)
    throw new ApiError("not_found", 404, "Tracking token not found");
  reply.redirect(row.url);
});

const logColumns = "id, created_at, path, method, status, user_agent";

app.get("/logs", async (request) => {
  await flushTelemetry();
  const filters = logWhere(request.query as LogQuery);
  const page = await paginate<StoredLog>(db, "logs", request.auth!.tenant_id, paging(request), {
    where: filters.where,
    params: filters.params,
    select: logColumns,
  });
  return { ...page, data: page.data.map((row) => presentLog(row)) };
});

app.get("/logs/export", async (request) => {
  await flushTelemetry();
  const rows = await db.query<StoredLog>(
    `select ${logColumns}
     from logs
     where tenant_id = $1
     order by created_at desc limit 1000`,
    [request.auth!.tenant_id],
  );
  return { exported_at: new Date().toISOString(), logs: rows.rows.map((row) => presentLog(row)) };
});

app.get("/logs/:id", async (request) => {
  await flushTelemetry();
  const log = await findBy<StoredLog>(
    db,
    "logs",
    request.auth!.tenant_id,
    (request.params as { id: string }).id,
    {
      select: `${logColumns}, request_body, response_body`,
      errorMessage: "Log not found",
    },
  );
  return presentLog(log, true, readOnly(request.auth));
});

type AttachmentRow = {
  id: string;
  filename: string;
  content_type: string;
  disposition?: string | null;
  size_bytes: number;
  content_id?: string | null;
  storage_key: string;
  created_at?: string;
};

// A signed link works without a session. A read-only user's links last five minutes, long
// enough to open the file and short enough not to outlive a removed account by much.
function urlTtl(request: FastifyRequest) {
  return readOnly(request.auth) ? 5 * 60 : signedUrlTtl;
}

async function signedAttachment(row: AttachmentRow, expiresIn = signedUrlTtl) {
  const signed = await storage.url(row.storage_key, { filename: row.filename, expiresIn });
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    content_disposition: row.disposition ?? "attachment",
    size: row.size_bytes,
    content_id: row.content_id ?? null,
    download_url: signed.download_url,
    expires_at: signed.expires_at,
    created_at: row.created_at,
  };
}

// Storage keys and content hashes are internal. An attachment is described the way the
// attachment routes describe it.
function presentReceived(row: Record<string, unknown>) {
  const { raw_key: _rawKey, ...rest } = row;
  const attachments = Array.isArray(rest.attachments)
    ? rest.attachments.map((attachment: Record<string, unknown>) => {
        const { storage_key: _key, content_hash: _hash, size_bytes: size, ...shown } = attachment;
        return size === undefined ? shown : { ...shown, size };
      })
    : rest.attachments;
  return { object: "email" as const, ...rest, attachments };
}

async function writeBlob(storageKey: string, bytes: Buffer) {
  await storage.put(storageKey, bytes);
}

async function useTrackingToken(
  token: string,
  kind: "open" | "click",
  requestIdValue: string,
  data: Record<string, unknown>,
) {
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
      [token, kind],
    );
    const tracking = row.rows[0];
    if (!tracking) return null;
    const timestamp = new Date().toISOString();
    const event = await appendEvent(client, {
      tenantId: tracking.tenant_id,
      requestId: requestIdValue,
      emailId: tracking.email_id,
      recipientId: tracking.recipient_id,
      type: kind === "open" ? "email.opened" : "email.clicked",
      providerEventId: `${token}:${kind}:${Date.now()}`,
      data:
        kind === "click"
          ? {
              click: {
                ipAddress: data.ip ?? null,
                link: tracking.url,
                timestamp,
                userAgent: data.user_agent ?? null,
              },
            }
          : { ...data, url: tracking.url, token },
    });
    if (event) await fanoutEvent(client, event);
    return tracking;
  });
}

async function authenticate(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer "))
    throw new ApiError("missing_api_key", 401, "Missing API key");
  const secret = header.slice("Bearer ".length).trim();
  if (secret.startsWith("sess_")) {
    const session = await db.query(
      // The key is only a label for the request log. A session does not depend on one: revoking
      // the tenant's last full-access key used to sign every user out.
      `select s.id, s.tenant_id, s.user_id, s.last_used_at, k.id as api_key_id, r.permissions
       from sessions s
       join users u on u.tenant_id = s.tenant_id and u.id = s.user_id and u.deactivated_at is null
       join memberships m on m.tenant_id = s.tenant_id and m.user_id = s.user_id and m.disabled_at is null
       join roles r on r.tenant_id = s.tenant_id and r.id = m.role_id and r.deleted_at is null
       left join lateral (
         select id from api_keys
         where tenant_id = s.tenant_id and revoked_at is null and scope = 'full'
         order by created_at asc limit 1
       ) k on true
       where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
       limit 1`,
      [hash(secret)],
    );
    if (!session.rows[0])
      throw new ApiError("invalid_session", 401, "Invalid session");
    request.auth = {
      tenant_id: session.rows[0].tenant_id,
      api_key_id: session.rows[0].api_key_id,
      scope: "full",
      user_id: session.rows[0].user_id,
      session_id: session.rows[0].id,
      permissions: session.rows[0].permissions ?? [],
    };
    const lastUsed = session.rows[0].last_used_at
      ? new Date(session.rows[0].last_used_at).getTime()
      : 0;
    if (Date.now() - lastUsed > 60_000)
      await db.query("update sessions set last_used_at = now() where id = $1", [
        session.rows[0].id,
      ]);
    return;
  }

  const apiKey = await validKey(secret);
  if (!apiKey) throw new ApiError("invalid_api_key", 403, "Invalid API key");
  request.auth = {
    tenant_id: apiKey.tenant_id,
    api_key_id: apiKey.id,
    scope: apiKey.scope,
    domain_name: apiKey.domain_name,
  };
  const lastUsed = apiKey.last_used_at
    ? new Date(apiKey.last_used_at).getTime()
    : 0;
  if (Date.now() - lastUsed > 60_000) {
    await db.query("update api_keys set last_used_at = now() where id = $1", [
      apiKey.id,
    ]);
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
    `select k.id, k.tenant_id, k.hash, k.scope, k.last_used_at, k.domain_id, d.name as domain_name
     from api_keys k
     left join domains d on d.id = k.domain_id and d.tenant_id = k.tenant_id
     where k.prefix = $1 and k.revoked_at is null
     limit 1`,
    [prefix],
  );
  const apiKey = row.rows[0];
  if (!apiKey || !safeEqualHex(apiKey.hash, expected)) return null;
  apiKeyCache.set(prefix, {
    row: apiKey,
    expires_at: Date.now() + authCacheTtlMs,
  });
  return apiKey;
}

// Counts a request and sets the key's expiry in one round trip, so a process that stops between
// the two cannot leave a key behind with no expiry.
async function countHit(key: string) {
  if (postgresCounters) return postgresCountHit(db, key);
  const results = await redis!.multi().incr(key).expire(key, 2).exec();
  const count = Number(results?.[0]?.[1] ?? 0);
  if (!Number.isFinite(count) || count < 1) throw new Error("rate limit counter unavailable");
  return count;
}

function trustProxy(value = process.env.TRUST_PROXY) {
  if (!value) return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

// /unsubscribe/<token>, /shared/<token>, /files/<token>, /open/<token>.gif, /click/<token>
function redactPath(url: string) {
  return url.replace(/^\/(unsubscribe|shared|files|open|click)\/[^?]+/, "/$1/[token]");
}

async function rateLimit(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.auth!;
  // API keys share one bucket per tenant. A dashboard session has its own, per user.
  const session = auth.session_id && auth.user_id;
  const key = session ? sessionRateKey(auth.tenant_id, auth.user_id!) : rateKey(auth.tenant_id);
  const count = await countHit(key);
  const limitValue = session ? sessionRateLimitValue() : rateLimitValue();
  reply.header("ratelimit-limit", String(limitValue));
  reply.header("ratelimit-remaining", String(Math.max(0, limitValue - count)));
  reply.header("ratelimit-reset", "1");
  if (count > limitValue) {
    reply.header("retry-after", "1");
    throw new ApiError("rate_limit_exceeded", 429, "Rate limit exceeded");
  }
}

// A key restricted to one domain may only change emails sent from that domain.
function assertKeyDomain(request: FastifyRequest, fromEmail: string) {
  const allowed = request.auth?.domain_name;
  if (allowed && fromEmail.split("@")[1]?.toLowerCase() !== allowed.toLowerCase()) {
    throw new ApiError("not_found", 404, "Email not found");
  }
}

// A settings change rebuilds the record list. Records that did not change keep the status the
// verification poller gave them.
function keepRecordStatus<T extends { name: string; type: string; value: string; status: string }>(
  current: Array<{ name: string; type: string; value: string; status?: string }>,
  next: T[],
) {
  const known = new Map(current.map((record) => [`${record.type}:${record.name}:${record.value}`, record.status]));
  return next.map((record) => ({ ...record, status: known.get(`${record.type}:${record.name}:${record.value}`) ?? record.status }));
}

function requireSend(request: FastifyRequest) {
  if (!request.auth)
    throw new ApiError("missing_api_key", 401, "Missing API key");
  if (!["full", "send"].includes(request.auth.scope))
    throw new ApiError("forbidden", 403, "Sending key required");
}

function emailContext(request: FastifyRequest): AcceptEmailContext {
  return {
    tenant_id: request.auth!.tenant_id,
    api_key_id: request.auth!.api_key_id,
    request_id: request.request_id,
    idempotency_key: idempotencyKey(request),
    domain_name: request.auth!.domain_name,
  };
}

function paging(request: FastifyRequest): PagingParams {
  const query = (request.query ?? {}) as {
    limit?: string | number;
    after?: string;
    before?: string;
  };
  return {
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
    after: query.after || undefined,
    before: query.before || undefined,
  };
}

function idempotencyKey(request: FastifyRequest) {
  const key = request.headers["idempotency-key"]?.toString();
  if (!key) return undefined;
  if (key.length < 1 || key.length > 256)
    throw new ApiError(
      "invalid_idempotency_key",
      400,
      "Idempotency key must be 1-256 characters",
    );
  return key;
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

function enqueueTelemetry(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.auth;
  const bodies = logBodies({
    method: request.method,
    route: request.routeOptions.url,
    body: request.body,
    responseText: request.response_text ?? null,
  });
  logQueue.push({
    id: id("log"),
    tenant_id: auth?.tenant_id ?? null,
    request_id: request.request_id,
    user_agent: request.headers["user-agent"]?.toString() ?? null,
    method: request.method,
    path: redactPath(request.url),
    status: reply.statusCode,
    latency_ms: Math.max(0, Date.now() - request.started_at),
    api_key_id: auth?.api_key_id ?? null,
    request_body: bodies.request_body,
    response_body: bodies.response_body,
  });
  if (auth) addUsageDelta(auth.tenant_id, "api_requests", 1);

  if (
    auth &&
    reply.statusCode < 400 &&
    !["GET", "HEAD", "OPTIONS"].includes(request.method)
  ) {
    auditQueue.push({
      id: id("audit"),
      tenant_id: auth.tenant_id,
      request_id: request.request_id,
      actor_user_id: auth.user_id ?? null,
      api_key_id: auth.api_key_id,
      session_id: auth.session_id ?? null,
      action: `${request.method} ${request.routeOptions.url ?? request.url.split("?")[0]}`,
      data: { path: redactPath(request.url), status: reply.statusCode },
    });
  }

  if (
    logQueue.length >= 100 ||
    auditQueue.length >= 100 ||
    usageDeltas.size >= 25
  )
    void flushTelemetry();
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

async function tenantBrand(tenantId: string) {
  const row = await db.query<{ brand: BrandRecord | null }>("select brand from tenants where id = $1", [tenantId]);
  return row.rows[0]?.brand ?? {};
}

function presentBrand(brand: BrandRecord) {
  return { object: "brand" as const, ...brand, text_color: brandTextColor(brand.color || "#18181b") };
}

async function renderBrand(tenantId: string, from?: string | null) {
  const brand = await loadBrand(db, tenantId);
  return brandContext(brand.brand, { tenantName: brand.name, domain: brand.domain, from });
}

// A preview has no sender and a new tenant has no brand yet. A real send always has both, so the
// preview fills the two values a send would supply with samples instead of failing.
async function previewBrand(tenantId: string) {
  const brand = await loadBrand(db, tenantId);
  const domain = brand.domain ?? "example.com";
  return brandContext(brand.brand, { tenantName: brand.name, domain, from: `support@${domain}` });
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
            `insert into logs (id, tenant_id, request_id, user_agent, method, path, status, latency_ms, api_key_id, request_body, response_body)
               select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::integer[], $8::integer[], $9::text[], $10::jsonb[], $11::jsonb[])`,
            [
              logs.map((log) => log.id),
              logs.map((log) => log.tenant_id),
              logs.map((log) => log.request_id),
              logs.map((log) => log.user_agent),
              logs.map((log) => log.method),
              logs.map((log) => log.path),
              logs.map((log) => log.status),
              logs.map((log) => log.latency_ms),
              logs.map((log) => log.api_key_id),
              jsonbParams(logs.map((log) => log.request_body)),
              jsonbParams(logs.map((log) => log.response_body)),
            ],
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
              audits.map((audit) => JSON.stringify(audit.data)),
            ],
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
              usage.map((row) => row.amount),
            ],
          );
        }
      });
    } catch (error) {
      logQueue.unshift(...logs);
      auditQueue.unshift(...audits);
      for (const row of usage)
        addUsageDelta(row.tenant_id, row.name, row.amount);
      app.log.warn({ err: error }, "failed to flush telemetry");
      break;
    }
  }
}

function securityHeaders(reply: FastifyReply) {
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  reply.header(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=()",
  );
  reply.header(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
}

function allowedOrigin(origin?: string) {
  if (!origin) return true;
  const allowed = new Set(
    (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return allowed.has(origin);
}

function safeRequestId(value?: string) {
  if (value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return value;
  return requestId();
}

function publicSetupEnabled() {
  return (
    (process.env.ALLOW_PUBLIC_SETUP ??
      (process.env.NODE_ENV === "production" ? "false" : "true")) === "true"
  );
}

function passwordlessSessionsEnabled() {
  return (
    (process.env.ALLOW_PASSWORDLESS_SESSIONS ??
      (process.env.NODE_ENV === "production" ? "false" : "true")) === "true"
  );
}

async function publicRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
) {
  const limitValue =
    route === "/sessions"
      ? Number(process.env.AUTH_RATE_LIMIT_PER_SECOND ?? 5)
      : Number(process.env.PUBLIC_RATE_LIMIT_PER_SECOND ?? 50);
  const key = `rate:public:${route}:${request.ip}:${Math.floor(Date.now() / 1000)}`;
  const count = await countHit(key);
  reply.header("ratelimit-limit", String(limitValue));
  reply.header("ratelimit-remaining", String(Math.max(0, limitValue - count)));
  reply.header("ratelimit-reset", "1");
  if (count > limitValue) {
    reply.header("retry-after", "1");
    throw new ApiError("rate_limit_exceeded", 429, "Rate limit exceeded");
  }
}

async function verifiedDomain(
  client: Pick<typeof db, "query">,
  tenantId: string,
  domain: string,
) {
  const key = `${tenantId}:${domain}`;
  const cached = domainCache.get(key);
  if (cached && cached > Date.now()) return true;
  const verified = await client.query(
    "select id from domains where tenant_id = $1 and name = $2 and status = 'verified' and deleted_at is null",
    [tenantId, domain],
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
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

// A route handler runs once per request, so every change it reports is a new event. The key is
// made here and not from the request ID, which a client may send again on another call.
function emitChange(request: FastifyRequest, type: EventType, resourceId: string, data: Record<string, unknown>) {
  return emit(db, {
    tenantId: request.auth!.tenant_id,
    requestId: request.request_id,
    type,
    resourceId,
    data,
    key: `${resourceId}:${type}:${id("change")}`,
  });
}

async function webhookUrl(value: string) {
  try {
    return await normalizeWebhookUrl(value, {
      requireHttps: process.env.NODE_ENV === "production",
      allowPrivate: privateWebhookTargetsEnabled(),
    });
  } catch (error) {
    throw new ApiError(
      "validation_error",
      400,
      error instanceof Error ? error.message : "Invalid webhook URL",
    );
  }
}

// The fake provider has no account behind it, so it reports the limits it simulates.
async function sendingQuota(region: string) {
  if ((process.env.SES_PROVIDER ?? "fake") !== "ses") {
    return { max_24_hour: 100_000, max_per_second: 100, sent_24_hour: 0, sandbox: false };
  }
  return sesProvider().quota(region);
}

let cachedSesProvider: ReturnType<typeof createSesProvider> | undefined;

function sesProvider() {
  cachedSesProvider ??= createSesProvider();
  return cachedSesProvider;
}

function privateWebhookTargetsEnabled() {
  return (
    (process.env.ALLOW_PRIVATE_WEBHOOKS ??
      (process.env.NODE_ENV === "production" ? "false" : "true")) === "true"
  );
}

function rawInbound(input: {
  attachments?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}) {
  return {
    ...input,
    attachments: (input.attachments ?? []).map((attachment) => {
      const { content, ...meta } = attachment;
      return {
        ...meta,
        content_hash: typeof content === "string" ? hash(content) : null,
        content_bytes:
          typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0,
      };
    }),
  };
}

function assertProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  const forbidden = new Set([
    "dev-pepper-change-before-deploy",
    "sk_local_dispatch_dev_key_change_before_deploy",
    "dev-secret-change-before-deploy",
  ]);
  for (const [name, value] of Object.entries({
    API_KEY_PEPPER: process.env.API_KEY_PEPPER,
    DISPATCH_API_KEY: process.env.DISPATCH_API_KEY,
    APP_SECRET: process.env.APP_SECRET,
  })) {
    if (value && forbidden.has(value))
      throw new Error(`${name} must be changed before production`);
  }
  assertRealProvider();
}

async function identityTokens(name: string, region: string, returnPath = "send") {
  if ((process.env.SES_PROVIDER ?? "fake") === "ses") {
    return createIdentity(sesClient(region), { name, mailFromDomain: `${returnPath}.${name}` });
  }
  return [randomBytes(8).toString("hex"), randomBytes(8).toString("hex"), randomBytes(8).toString("hex")];
}

function domainRecords(
  name: string,
  region: string,
  tokens: string[],
  options: { returnPath?: string; trackingSubdomain?: string; receiving?: boolean } = {},
) {
  return dnsRecords({
    name,
    region,
    tokens,
    returnPath: options.returnPath,
    trackingSubdomain: options.trackingSubdomain,
    trackingHost: process.env.TRACKING_DOMAIN ?? "links.localhost",
    receiving: options.receiving,
  });
}

export async function close() {
  if (telemetryTimer) clearInterval(telemetryTimer);
  await app.close();
  await flushTelemetry();
  redis?.disconnect();
  await db.end();
}

export { app };

if (runningAsEntry()) {
  const port = Number(process.env.PORT ?? 3100);
  const host =
    process.env.API_HOST ??
    process.env.HOST ??
    (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  await app.listen({ port, host });
}

function runningAsEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
