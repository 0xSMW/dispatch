import "@dispatchmail/core/env";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  assertPublicWebhookTarget,
  assertRealProvider,
  publicFetch,
  requireUrl,
  decrypt,
  endpointDisabled,
  EventType,
  formatWebhookPayload,
  id,
  sign,
  requireSecret,
  signWebhook,
  webhookDelay,
  webhookEventData,
  webhookUrl,
} from "@dispatchmail/core";
import {
  connect,
  executeAutomationRun,
  tx,
  type Queryable,
} from "@dispatchmail/db";
import { fakeProvider } from "@dispatchmail/provider-fake";
import { createSesProvider, nodeResolvers, readIdentity, sesClient } from "@dispatchmail/provider-ses";
import { createStorage } from "@dispatchmail/storage";
import { sendBroadcasts } from "./broadcasts.js";
import { deliverJob, handleSendFailure, type Job } from "./deliver.js";
import { verifyDueDomains } from "./domains.js";
import { applySesEvent, consumeOnce, type SesEvent } from "./events.js";
import { applyInbound, type SesReceipt } from "./inbound.js";
import { startImports } from "./imports.js";
import { pruneLogs, pruneLogsIfDue } from "./logs.js";

const db = connect();
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 5);
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 250);
const publicUrl = requireUrl("PUBLIC_URL", "http://localhost:3100");
const appUrl = requireUrl("APP_URL", "http://localhost:5173");
const appSecret = requireSecret("APP_SECRET");
const storage = createStorage();
// The worker is the process that sends. Without this check a production worker with no
// SES_PROVIDER marked every email delivered and sent nothing.
assertRealProvider();
const provider = (process.env.SES_PROVIDER || "fake") === "ses" ? createSesProvider() : fakeProvider();
const pollState = { last: 0 };
const logPrune = { last: 0 };

type AutomationRunRef = {
  id: string;
  tenant_id: string;
  wait_event: string | null;
};

export async function tick(options: { durable?: boolean } = {}) {
  const jobs = await claimJobs();
  await Promise.all(jobs.map((job) => processJob(job, options.durable)));
  const runs = await claimAutomationRuns();
  await Promise.all(
    runs.map((run) => executeAutomationRun(db, run.tenant_id, run.id, { publicUrl, appUrl, secret: appSecret })),
  );
  const attempts = await processQueuedAttempts();
  // Each of these stands alone. A failure in one is logged and the others still run.
  const broadcasts = await alone("broadcasts", () =>
    sendBroadcasts(db, {
      publicUrl,
      appUrl,
      secret: appSecret,
      limit: concurrency,
      onError: (broadcastId, error) => console.error(`broadcast ${broadcastId ?? "claim"} failed`, error),
    }),
  );
  const imports = await alone("imports", () => startImports(db, storage, undefined, undefined, { bounded: options.durable }));
  await alone("log pruning", () => options.durable ? pruneLogs(db, undefined, undefined, 1) : pruneLogsIfDue(db, logPrune));
  return { jobs: jobs.length, runs: runs.length, attempts, broadcasts: broadcasts ?? 0, imports: imports ?? 0 };
}

async function alone<T>(name: string, run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    console.error(`${name} failed`, error);
  }
}

// Domain checks make several network calls per domain. They run on their own loop so a slow DNS
// server or a long list of pending domains never delays sending.
async function pollDomains() {
  await verifyDueDomains(db, {
    read: async (name, region) => readIdentity(sesClient(region), name),
    resolvers: nodeResolvers,
    onError: (domain, error) => console.error(`domain check failed for ${domain.name}`, error),
  }, pollState);
  await sleep(5_000);
}

export async function close() {
  await db.end();
}

if (runningAsEntry()) {
  console.log(`worker started concurrency=${concurrency}`);
  const eventsUrl = process.env.SES_EVENTS_QUEUE_URL;
  const inboundUrl = process.env.SES_INBOUND_QUEUE_URL;
  if (eventsUrl || inboundUrl) {
    const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
    // Each message is applied in one transaction. A crash partway through rolls everything back,
    // SQS redelivers, and the handler runs again from a clean state.
    // An empty value, as an env file may leave it, means unset. Read as a region it matched no
    // domain, and every inbound message was dropped.
    const inboundRegion = process.env.SES_INBOUND_REGION || process.env.AWS_REGION || null;
    if (eventsUrl) void watchQueue(() => consumeOnce(sqs, eventsUrl, async (body) => { await tx(db, (client) => applySesEvent(client, body as SesEvent)); }));
    if (inboundUrl) void watchQueue(() => consumeOnce(sqs, inboundUrl, async (body) => { await tx(db, (client) => applyInbound(client, storage, body as SesReceipt, { region: inboundRegion })); }));
  }
  if ((process.env.SES_PROVIDER ?? "fake") === "ses") void watchQueue(pollDomains);
  while (true) {
    try {
      const result = await tick();
      if (result.jobs === 0 && result.runs === 0 && result.attempts === 0)
        await sleep(intervalMs);
    } catch (error) {
      console.error(error);
      await sleep(1_000);
    }
  }
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

async function claimJobs() {
  return tx(db, async (client) => {
    // Transactional mail goes first: a password reset must not wait behind a broadcast. Emails
    // of a paused broadcast are left where they are until it is resumed.
    const rows = await client.query<Job>(
      `select j.id, j.tenant_id, j.email_id, j.request_id
       from send_jobs j
       join emails e on e.id = j.email_id
       left join broadcasts b on b.id = e.broadcast_id
       where ((j.state = 'ready' and j.available_at <= now())
          or (j.state = 'running' and j.locked_at < now() - interval '5 minutes'))
         and (b.id is null or b.status <> 'paused')
       order by (e.broadcast_id is not null), j.available_at, j.id
       limit $1
       for update of j skip locked`,
      [concurrency],
    );

    if (rows.rowCount === 0) return [];

    await client.query(
      `update send_jobs set state = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
       where id = any($1)`,
      [rows.rows.map((row) => row.id)],
    );

    return rows.rows;
  });
}

async function processJob(job: Job, durable = false) {
  try {
    await deliverJob(db, storage, provider, job, { durable });
  } catch (error) {
    await handleSendFailure(db, job, error, { durable });
  }
}

async function watchQueue(run: () => Promise<unknown>) {
  while (true) {
    try {
      await run();
    } catch (error) {
      console.error(error);
      await sleep(1_000);
    }
  }
}

function privateWebhookTargetsEnabled() {
  return (process.env.ALLOW_PRIVATE_WEBHOOKS ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true";
}

async function processQueuedAttempts() {
  // A disabled endpoint gets nothing more. Its waiting retries end here instead of firing for
  // another day, or all at once when the endpoint is switched back on.
  await db.query(
    `update webhook_attempts a
     set state = 'failed', error = 'Endpoint is disabled', updated_at = now()
     from webhooks w
     where w.tenant_id = a.tenant_id and w.id = a.webhook_id and not w.enabled
       and a.state = 'queued' and a.available_at <= now()`,
  );
  const attempts = await tx(db, async (client) => {
    const rows = await client.query<{
      id: string;
      tenant_id: string;
      webhook_id: string;
      event_id: string;
      request_id: string | null;
      attempt: number;
      url: string;
      secret: string;
      previous_secret: string | null;
      previous_secret_expires_at: string | null;
      type: EventType;
      email_id: string | null;
      data: Record<string, unknown>;
      event_created_at: string;
      from_email: string | null;
      from_name: string | null;
      subject: string | null;
      message_id: string | null;
      tags: Record<string, string> | null;
      broadcast_id: string | null;
      template_id: string | null;
      email_created_at: string | null;
      to: string[] | null;
    }>(
      `select a.id, a.tenant_id, a.webhook_id, a.event_id, a.request_id, a.attempt, w.url, w.secret,
              w.previous_secret, w.previous_secret_expires_at, e.type, e.email_id, e.data, e.created_at as event_created_at,
              m.from_email, m.from_name, m.subject, m.message_id, m.tags, m.broadcast_id, m.template_id, m.created_at as email_created_at,
              coalesce(r.to, '[]'::jsonb) as to
       from webhook_attempts a
       join webhooks w on w.tenant_id = a.tenant_id and w.id = a.webhook_id
       join email_events e on e.tenant_id = a.tenant_id and e.id = a.event_id
       left join emails m on m.tenant_id = e.tenant_id and m.id = e.email_id
       left join lateral (
         select jsonb_agg(email order by created_at) as to
         from email_recipients
         where tenant_id = e.tenant_id and email_id = e.email_id and kind = 'to'
       ) r on true
       where w.enabled
         and ((a.state = 'queued' and a.available_at <= now())
           or (a.state = 'running' and a.updated_at < now() - interval '1 minute'))
       order by a.available_at, a.id
       limit $1
       for update of a skip locked`,
      [concurrency * 2],
    );
    if (rows.rowCount === 0) return [];
    await client.query(
      "update webhook_attempts set state = 'running', updated_at = now() where id = any($1)",
      [rows.rows.map((row) => row.id)],
    );
    return rows.rows;
  });

  await Promise.all(
    attempts.map(async (attempt) => {
      const started = Date.now();
      // Everything that can throw sits inside the try, so a secret that no longer decrypts is
      // recorded on the attempt instead of leaving it running.
      try {
        const secret = decrypt(attempt.secret, appSecret);
        const previous = attempt.previous_secret && attempt.previous_secret_expires_at && Date.parse(attempt.previous_secret_expires_at) > Date.now()
          ? decrypt(attempt.previous_secret, appSecret)
          : null;
        const payload = JSON.stringify(
          formatWebhookPayload({
            id: attempt.event_id,
            request_id: attempt.request_id,
            type: attempt.type,
            email_id: attempt.email_id,
            data: webhookEventData({
              email_id: attempt.email_id,
              email_created_at: attempt.email_created_at,
              from_email: attempt.from_email,
              from_name: attempt.from_name,
              to: attempt.to,
              subject: attempt.subject,
              message_id: attempt.message_id,
              tags: attempt.tags,
              broadcast_id: attempt.broadcast_id,
              template_id: attempt.template_id,
              data: attempt.data,
            }),
            created_at: attempt.event_created_at,
          }),
        );
        const signed = signWebhook(payload, previous ? [secret, previous] : [secret], attempt.event_id);
        const legacy = sign(payload, secret, attempt.event_id, signed.timestamp);
        // The host was checked when the endpoint was saved. Its DNS can point somewhere private
        // since then, so it is checked again here, and publicFetch refuses a private address
        // on the connection itself.
        const open = privateWebhookTargetsEnabled();
        if (!open) await assertPublicWebhookTarget(new URL(attempt.url).hostname);
        const response = await (open ? fetch : publicFetch)(webhookUrl(attempt.url), {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            "svix-id": signed.id,
            "svix-timestamp": String(signed.timestamp),
            "svix-signature": signed.signature,
            // The standardwebhooks libraries read these names. Same values as the svix headers.
            "webhook-id": signed.id,
            "webhook-timestamp": String(signed.timestamp),
            "webhook-signature": signed.signature,
            "dispatch-webhook-id": legacy.id,
            "dispatch-webhook-timestamp": String(legacy.timestamp),
            "dispatch-webhook-signature": legacy.signature,
          },
          body: payload,
          signal: AbortSignal.timeout(5_000),
        });
        const body = await limitedText(response, 1_000);
        if (response.ok) {
          await db.query(
            `update webhook_attempts set state = 'sent', status = $2, latency_ms = $3, response = $4, updated_at = now()
             where id = $1`,
            [
              attempt.id,
              response.status,
              Date.now() - started,
              body.slice(0, 1000),
            ],
          );
          await markWebhook(
            db,
            attempt.tenant_id,
            attempt.webhook_id,
            "healthy",
            response.status,
          );
        } else {
          await failAttempt(
            attempt,
            Date.now() - started,
            `HTTP ${response.status}`,
            body.slice(0, 1000),
            response.status,
          );
        }
      } catch (error) {
        await failAttempt(attempt, Date.now() - started, String(error));
      }
    }),
  );
  return attempts.length;
}

async function failAttempt(
  attempt: {
    id: string;
    tenant_id: string;
    request_id: string | null;
    webhook_id: string;
    event_id: string;
    attempt: number;
  },
  latencyMs: number,
  error: string,
  response?: string,
  status?: number,
) {
  const nextAttempt = attempt.attempt + 1;
  // A replay is one extra delivery. If it fails it does not start the retry schedule again.
  const replay = await db.query("select 1 from webhook_replays where attempt_id = $1 limit 1", [attempt.id]);
  const delay = replay.rows[0] ? null : webhookDelay(attempt.attempt);

  await tx(db, async (client) => {
    await client.query(
      `update webhook_attempts
       set state = 'failed', status = $2, latency_ms = $3, error = $4, response = $5, updated_at = now()
       where id = $1`,
      [attempt.id, status ?? null, latencyMs, error, response ?? null],
    );

    if (delay !== null) {
      await client.query(
        `insert into webhook_attempts (id, tenant_id, request_id, webhook_id, event_id, state, attempt, available_at)
         values ($1, $2, $3, $4, $5, 'queued', $6, now() + make_interval(secs => $7))`,
        [
          id("attempt"),
          attempt.tenant_id,
          attempt.request_id,
          attempt.webhook_id,
          attempt.event_id,
          nextAttempt,
          delay,
        ],
      );
    }
    await markWebhook(
      client,
      attempt.tenant_id,
      attempt.webhook_id,
      delay === null ? "failing" : "retrying",
      status ?? null,
      error,
    );
  });
}

async function claimAutomationRuns() {
  return tx(db, async (client) => {
    const rows = await client.query<AutomationRunRef>(
      // Three kinds of work: a run an event just started or woke (ready), a run whose delay or
      // wait has run out (waiting), and a run a stopped worker left behind (running, with no
      // step committed for five minutes). Every step refreshes updated_at.
      `select id, tenant_id, wait_event
       from automation_runs
       where state = 'ready'
          or (state = 'waiting' and resume_at is not null and resume_at <= now())
          or (state = 'running' and updated_at < now() - interval '5 minutes')
       order by coalesce(resume_at, created_at), id
       limit $1
       for update skip locked`,
      [concurrency],
    );
    if (rows.rowCount === 0) return [];
    // A wait that ran out is marked as timed out, so the run takes the timeout branch.
    await client.query(
      `update automation_runs
       set resume_data = case when state = 'waiting' then jsonb_build_object('timed_out', wait_event is not null) else resume_data end,
         state = 'running', resume_at = null, wait_event = null, updated_at = now()
       where id = any($1)`,
      [rows.rows.map((row) => row.id)],
    );
    return rows.rows;
  });
}

async function markWebhook(
  client: Queryable,
  tenantId: string,
  webhookId: string,
  state: "healthy" | "retrying" | "failing" | "disabled",
  status?: number | null,
  error?: string,
) {
  // failing_since starts over when the last check is older than the whole retry schedule (about
  // 27 hours). Otherwise a failure from last week plus one failure today would read as five days
  // of failing and disable an endpoint that has been fine in between.
  const row = await client.query<{ failing_since: string | null }>(
    `insert into webhook_endpoint_health (webhook_id, tenant_id, state, consecutive_failures, last_status, last_error, failing_since)
     values ($1, $2, $3, case when $3 = 'healthy' then 0 else 1 end, $4, $5, case when $3 = 'healthy' then null else now() end)
     on conflict (webhook_id)
     do update set
       state = excluded.state,
       consecutive_failures = case when excluded.state = 'healthy' then 0 else webhook_endpoint_health.consecutive_failures + 1 end,
       last_status = excluded.last_status,
       last_error = excluded.last_error,
       failing_since = case
         when excluded.state = 'healthy' then null
         when webhook_endpoint_health.failing_since is null then now()
         when webhook_endpoint_health.checked_at < now() - interval '27 hours' then now()
         else webhook_endpoint_health.failing_since
       end,
       checked_at = now()
     returning failing_since`,
    [webhookId, tenantId, state, status ?? null, error ?? null],
  );
  if (endpointDisabled(row.rows[0]?.failing_since ?? null)) {
    await client.query(
      "update webhooks set enabled = false, updated_at = now() where tenant_id = $1 and id = $2",
      [tenantId, webhookId],
    );
  }
}

async function limitedText(response: Response, limit: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value.slice(0, Math.max(0, limit - total));
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total >= limit) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
