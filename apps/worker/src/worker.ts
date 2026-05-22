import "dotenv/config";
import { EventType, id, normalizeWebhookUrl, prepareTracking, renderTemplate, sign } from "@dispatch/core";
import { connect, tx } from "@dispatch/db";
import { sendFake } from "@dispatch/provider-fake";

const db = connect();
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 5);
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 250);
const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:3100";

type Job = {
  id: string;
  tenant_id: string;
  email_id: string;
  request_id: string;
};

type EventRow = {
  id: string;
  tenant_id: string;
  request_id: string | null;
  email_id: string | null;
  type: EventType;
  data: Record<string, unknown>;
};

type AutomationStep =
  | { type: "send_email"; from: string; to?: string; template: string; variables?: Record<string, unknown> }
  | { type: "update_contact"; email?: string; properties?: Record<string, unknown>; unsubscribed?: boolean }
  | { type: "add_to_segment"; segment_id: string; email?: string }
  | { type: "delay"; seconds: number }
  | { type: "wait"; event: string; timeout_seconds?: number };

type AutomationRunRef = {
  id: string;
  tenant_id: string;
  wait_event: string | null;
};

console.log(`worker started concurrency=${concurrency}`);

while (true) {
  try {
    const jobs = await claimJobs();
    await Promise.all(jobs.map((job) => processJob(job)));
    const runs = await claimAutomationRuns();
    await Promise.all(runs.map((run) => runAutomation(run, run.wait_event ? { timed_out: true } : {})));
    const attempts = await processQueuedAttempts();
    if (jobs.length === 0 && runs.length === 0 && attempts === 0) await sleep(intervalMs);
  } catch (error) {
    console.error(error);
    await sleep(1_000);
  }
}

async function claimJobs() {
  return tx(db, async (client) => {
    const rows = await client.query<Job>(
      `select id, tenant_id, email_id, request_id
       from send_jobs
       where state = 'ready' and available_at <= now()
       order by available_at, id
       limit $1
       for update skip locked`,
      [concurrency]
    );

    if (rows.rowCount === 0) return [];

    await client.query(
      `update send_jobs set state = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
       where id = any($1)`,
      [rows.rows.map((row) => row.id)]
    );

    return rows.rows;
  });
}

async function processJob(job: Job) {
  try {
    const email = await db.query<{
      id: string;
      tenant_id: string;
      subject: string;
      status: string;
    }>("select id, tenant_id, subject, status from emails where id = $1 and tenant_id = $2", [job.email_id, job.tenant_id]);

    if (!email.rows[0] || email.rows[0].status === "cancelled") {
      await finishJob(job.id, "done");
      return;
    }

    const recipients = await db.query<{ email: string; kind: string }>(
      "select email, kind from email_recipients where email_id = $1 order by created_at",
      [job.email_id]
    );
    const attachments = await db.query<{ count: string }>("select count(*)::text as count from email_attachments where email_id = $1", [
      job.email_id
    ]);
    const result = sendFake({
      id: job.email_id,
      subject: email.rows[0].subject,
      recipients: recipients.rows.map((recipient) => recipient.email),
      attachments: Number(attachments.rows[0]?.count ?? 0)
    });

    await db.query("update emails set provider_message_id = $3, updated_at = now() where tenant_id = $1 and id = $2", [
      job.tenant_id,
      job.email_id,
      result.provider_message_id
    ]);

    for (const event of result.events) {
      if (event.delay_ms > 0) await sleep(event.delay_ms);
      const row = await appendEvent(job.tenant_id, job.request_id, job.email_id, event.type, event.provider_event_id, event.data);
      if (row) await fanout(row);
    }

    await finishJob(job.id, "done");
  } catch (error) {
    const attempts = await db.query<{ attempts: number }>("select attempts from send_jobs where id = $1", [job.id]);
    const next = attempts.rows[0]?.attempts ?? 1;
    if (next >= 5) {
      await db.query("update send_jobs set state = 'failed', error = $2, updated_at = now() where id = $1", [job.id, String(error)]);
      const row = await appendEvent(job.tenant_id, job.request_id, job.email_id, "email.failed", `${job.id}:failed:${next}`, {
        error: String(error)
      });
      if (row) await fanout(row);
    } else {
      await db.query(
        `update send_jobs set state = 'ready', available_at = now() + make_interval(secs => $2), error = $3, updated_at = now()
         where id = $1`,
        [job.id, Math.min(30, 2 ** next), String(error)]
      );
    }
  }
}

async function appendEvent(
  tenantId: string,
  requestId: string,
  emailId: string,
  type: EventType,
  providerEventId: string,
  data: Record<string, unknown>
) {
  const row = await tx(db, async (client) => {
    const inserted = await client.query<EventRow>(
      `insert into email_events (id, tenant_id, request_id, email_id, type, provider_event_id, data)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (provider_event_id) do nothing
       returning id, tenant_id, request_id, email_id, type, data`,
      [id("event"), tenantId, requestId, emailId, type, providerEventId, JSON.stringify(data)]
    );
    const event = inserted.rows[0];
    if (!event) return null;

    const status = statusFor(type);
    if (status) {
      await client.query("update emails set status = $3, updated_at = now() where tenant_id = $1 and id = $2", [
        tenantId,
        emailId,
        status
      ]);
      await client.query("update email_recipients set status = $3, updated_at = now() where tenant_id = $1 and email_id = $2", [
        tenantId,
        emailId,
        status
      ]);
    }

    if (type === "email.bounced" || type === "email.complained") {
      await client.query(
        `insert into suppressions (id, tenant_id, email, reason)
         select $1, tenant_id, email, $4 from email_recipients
         where tenant_id = $2 and email_id = $3
         on conflict (tenant_id, email) do nothing`,
        [id("supp"), tenantId, emailId, type]
      );
    }

    await client.query(
      `insert into event_dedupe_keys (id, tenant_id, key, event_id)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, key) do nothing`,
      [id("dedupe"), tenantId, providerEventId, event.id]
    );
    await client.query(
      `insert into provider_events_raw (id, tenant_id, provider, provider_event_id, event_id, payload)
       values ($1, $2, 'fake', $3, $4, $5)
       on conflict (tenant_id, provider, provider_event_id)
       do update set event_id = excluded.event_id`,
      [id("raw"), tenantId, providerEventId, event.id, JSON.stringify({ type, data })]
    );
    await incrementUsage(client, tenantId, `events.${type}`, 1);
    if (type === "email.sent") await incrementUsage(client, tenantId, "emails.sent", 1);

    return event;
  });

  return row;
}

async function fanout(event: EventRow) {
  await db.query(
    `insert into webhook_attempts (id, tenant_id, request_id, webhook_id, event_id, state)
     select 'attempt_' || md5(random()::text || clock_timestamp()::text || id), tenant_id, $3, id, $4, 'queued'
     from webhooks
     where tenant_id = $1 and enabled = true and events ? $2`,
    [event.tenant_id, event.type, event.request_id, event.id]
  );
}

async function processQueuedAttempts() {
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
      type: EventType;
      email_id: string | null;
      data: Record<string, unknown>;
    }>(
      `select a.id, a.tenant_id, a.webhook_id, a.event_id, a.request_id, a.attempt, w.url, w.secret, e.type, e.email_id, e.data
       from webhook_attempts a
       join webhooks w on w.tenant_id = a.tenant_id and w.id = a.webhook_id
       join email_events e on e.tenant_id = a.tenant_id and e.id = a.event_id
       where a.state = 'queued' and a.available_at <= now()
       order by a.available_at, a.id
       limit $1
       for update skip locked`,
      [concurrency * 2]
    );
    if (rows.rowCount === 0) return [];
    await client.query("update webhook_attempts set state = 'running', updated_at = now() where id = any($1)", [rows.rows.map((row) => row.id)]);
    return rows.rows;
  });

  await Promise.all(
    attempts.map(async (attempt) => {
      const started = Date.now();
      const payload = JSON.stringify({
        id: attempt.event_id,
        request_id: attempt.request_id,
        type: attempt.type,
        email_id: attempt.email_id,
        data: attempt.data,
        created_at: new Date().toISOString()
      });
      const signature = sign(payload, attempt.secret, attempt.event_id);
      try {
        const response = await fetch(await webhookUrl(attempt.url), {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            "dispatch-webhook-id": signature.id,
            "dispatch-webhook-timestamp": String(signature.timestamp),
            "dispatch-webhook-signature": signature.signature
          },
          body: payload,
          signal: AbortSignal.timeout(5_000)
        });
        const body = await limitedText(response, 1_000);
        if (response.ok) {
          await db.query(
            `update webhook_attempts set state = 'sent', status = $2, latency_ms = $3, response = $4, updated_at = now()
             where id = $1`,
            [attempt.id, response.status, Date.now() - started, body.slice(0, 1000)]
          );
          await markWebhook(attempt.tenant_id, attempt.webhook_id, "healthy", response.status);
        } else {
          await failAttempt(attempt, Date.now() - started, `HTTP ${response.status}`, body.slice(0, 1000), response.status);
        }
      } catch (error) {
        await failAttempt(attempt, Date.now() - started, String(error));
      }
    })
  );
  return attempts.length;
}

async function failAttempt(
  attempt: { id: string; tenant_id: string; request_id: string | null; webhook_id: string; event_id: string; attempt: number },
  latencyMs: number,
  error: string,
  response?: string,
  status?: number
) {
  const maxAttempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 5);
  const nextAttempt = attempt.attempt + 1;

  await tx(db, async (client) => {
    await client.query(
      `update webhook_attempts
       set state = 'failed', status = $2, latency_ms = $3, error = $4, response = $5, updated_at = now()
       where id = $1`,
      [attempt.id, status ?? null, latencyMs, error, response ?? null]
    );

    if (nextAttempt <= maxAttempts) {
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
          Math.min(300, 2 ** attempt.attempt)
        ]
      );
      await markWebhook(attempt.tenant_id, attempt.webhook_id, nextAttempt === maxAttempts ? "failing" : "retrying", status ?? null, error);
    } else {
      await client.query("update webhooks set enabled = false, updated_at = now() where tenant_id = $1 and id = $2", [
        attempt.tenant_id,
        attempt.webhook_id
      ]);
      await markWebhook(attempt.tenant_id, attempt.webhook_id, "disabled", status ?? null, error);
    }
  });
}

async function claimAutomationRuns() {
  return tx(db, async (client) => {
    const rows = await client.query<AutomationRunRef>(
      `select id, tenant_id, wait_event
       from automation_runs
       where state = 'waiting' and resume_at is not null and resume_at <= now()
       order by resume_at, id
       limit $1
       for update skip locked`,
      [concurrency]
    );
    if (rows.rowCount === 0) return [];
    await client.query(
      `update automation_runs
       set state = 'running', resume_at = null, wait_event = null, updated_at = now()
       where id = any($1)`,
      [rows.rows.map((row) => row.id)]
    );
    return rows.rows;
  });
}

async function runAutomation(runRef: AutomationRunRef, resumeData: Record<string, unknown>) {
  try {
    const run = await db.query<{
      id: string;
      tenant_id: string;
      automation_id: string;
      event_id: string;
      request_id: string;
      state: string;
      next_step_index: number;
      steps: AutomationStep[];
      email: string | null;
      data: Record<string, unknown>;
    }>(
      `select r.id, r.tenant_id, r.automation_id, r.event_id, e.request_id, r.state, r.next_step_index, a.steps,
         e.email, e.data
       from automation_runs r
       join automations a on a.id = r.automation_id
       join custom_events e on e.id = r.event_id
       where r.tenant_id = $1 and r.id = $2`,
      [runRef.tenant_id, runRef.id]
    );
    const current = run.rows[0];
    if (!current || current.state === "done" || current.state === "failed") return;

    await db.query(
      `update automation_runs
       set state = 'running', resume_at = null, wait_event = null, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [current.tenant_id, current.id]
    );
    if (current.next_step_index > 0) {
      await db.query(
        `update automation_steps
         set state = 'done',
           data = data || jsonb_build_object('resumed_at', now()) || $4::jsonb
         where tenant_id = $1 and run_id = $2 and step_index = $3 and state = 'waiting'`,
        [current.tenant_id, current.id, current.next_step_index - 1, JSON.stringify(resumeData)]
      );
    }

    for (let index = current.next_step_index; index < current.steps.length; index += 1) {
      const step = current.steps[index];
      if (step.type === "delay" || step.type === "wait") {
        await pauseAutomation(current.tenant_id, current.id, index, step);
        return;
      }

      try {
        const data = await executeAutomationStep(current, step);
        await db.query(
          `insert into automation_steps (id, tenant_id, run_id, step_index, type, state, data)
           values ($1, $2, $3, $4, $5, 'done', $6)`,
          [id("step"), current.tenant_id, current.id, index, step.type, JSON.stringify(data)]
        );
        await db.query("update automation_runs set next_step_index = $3, updated_at = now() where tenant_id = $1 and id = $2", [
          current.tenant_id,
          current.id,
          index + 1
        ]);
      } catch (error) {
        await db.query(
          `insert into automation_steps (id, tenant_id, run_id, step_index, type, state, data, error)
           values ($1, $2, $3, $4, $5, 'failed', '{}', $6)`,
          [id("step"), current.tenant_id, current.id, index, step.type, error instanceof Error ? error.message : String(error)]
        );
        throw error;
      }
    }

    await db.query(
      `update automation_runs
       set state = 'done', next_step_index = $3, resume_at = null, wait_event = null, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [current.tenant_id, current.id, current.steps.length]
    );
  } catch (error) {
    await db.query("update automation_runs set state = 'failed', error = $3, updated_at = now() where tenant_id = $1 and id = $2", [
      runRef.tenant_id,
      runRef.id,
      error instanceof Error ? error.message : String(error)
    ]);
  }
}

async function pauseAutomation(
  tenantId: string,
  runId: string,
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
      [id("step"), tenantId, runId, index, step.type, JSON.stringify(data)]
    );
    await client.query(
      `update automation_runs
       set state = 'waiting', next_step_index = $3, resume_at = $4, wait_event = $5, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, runId, index + 1, resumeAt, step.type === "wait" ? step.event : null]
    );
  });
}

async function executeAutomationStep(
  run: {
    id: string;
    tenant_id: string;
    automation_id: string;
    event_id: string;
    request_id: string;
    email: string | null;
    data: Record<string, unknown>;
  },
  step: AutomationStep
) {
  if (step.type === "send_email") {
    const to = step.to ?? run.email;
    if (!to) throw new Error("send_email step needs a recipient");
    const variables = { ...run.data, event: run.data, email: run.email, ...(step.variables ?? {}) };
    const email = await createAutomationEmail(run, { from: step.from, to, template: step.template, variables });
    return { email_id: email.id };
  }

  if (step.type === "update_contact") {
    const email = step.email ?? run.email;
    if (!email) throw new Error("update_contact step needs an email");
    const contact = await upsertContact(run.tenant_id, email);
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
       returning id, email`,
      [run.tenant_id, contact.id, JSON.stringify(step.properties ?? {}), step.unsubscribed ?? null]
    );
    return { contact_id: row.rows[0].id, email: row.rows[0].email };
  }

  if (step.type === "add_to_segment") {
    const email = step.email ?? run.email;
    if (!email) throw new Error("add_to_segment step needs an email");
    const segment = await db.query("select id from segments where tenant_id = $1 and id = $2 and deleted_at is null", [
      run.tenant_id,
      step.segment_id
    ]);
    if (!segment.rows[0]) throw new Error("Segment not found");
    const contact = await upsertContact(run.tenant_id, email);
    await db.query(
      `insert into segment_contacts (id, tenant_id, segment_id, contact_id)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, segment_id, contact_id) do nothing`,
      [id("member"), run.tenant_id, step.segment_id, contact.id]
    );
    return { segment_id: step.segment_id, contact_id: contact.id, email };
  }

  throw new Error(`Unsupported automation step: ${step.type}`);
}

async function createAutomationEmail(
  run: { tenant_id: string; request_id: string; automation_id: string; id: string; event_id: string },
  input: { from: string; to: string; template: string; variables: Record<string, unknown> }
) {
  return tx(db, async (client) => {
    const domain = input.from.split("@")[1];
    const verified = await client.query(
      "select id from domains where tenant_id = $1 and name = $2 and status = 'verified' and deleted_at is null",
      [run.tenant_id, domain]
    );
    if (verified.rowCount === 0) throw new Error("Sender domain is not verified");

    const template = await publishedTemplate(client, run.tenant_id, input.template);
    const rendered = renderTemplate(template, input.variables);
    const suppressed = await client.query(
      `select email from suppressions where tenant_id = $1 and email = $2 and removed_at is null
       union
       select email from contacts where tenant_id = $1 and email = $2 and deleted_at is null and unsubscribed_at is not null`,
      [run.tenant_id, input.to]
    );
    if ((suppressed.rowCount ?? 0) > 0) throw new Error(`Recipient is suppressed: ${input.to}`);

    const emailId = id("email");
    const tracking = rendered.html ? prepareTracking(rendered.html, publicUrl) : { html: rendered.html, tokens: [] };
    const email = await client.query<{ id: string }>(
      `insert into emails (
        id, tenant_id, request_id, from_email, subject, html, text, template_id,
        template_version_id, headers, tags, status
      )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}', $10, 'queued')
       returning id`,
      [
        emailId,
        run.tenant_id,
        run.request_id,
        input.from,
        rendered.subject,
        tracking.html ?? null,
        rendered.text ?? null,
        template.template_id,
        template.id,
        JSON.stringify({ automation_id: run.automation_id, automation_run_id: run.id, event_id: run.event_id })
      ]
    );
    await client.query(
      `insert into email_recipients (id, tenant_id, email_id, email, kind)
       values ($1, $2, $3, $4, 'to')`,
      [id("rcpt"), run.tenant_id, emailId, input.to]
    );
    if (tracking.tokens.length > 0) {
      await client.query(
        `insert into tracking_tokens (token, tenant_id, email_id, kind, url)
         select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])`,
        [
          tracking.tokens.map((token) => token.token),
          tracking.tokens.map(() => run.tenant_id),
          tracking.tokens.map(() => emailId),
          tracking.tokens.map((token) => token.kind),
          tracking.tokens.map((token) => token.url ?? null)
        ]
      );
    }
    await client.query(
      `insert into send_jobs (id, tenant_id, email_id, request_id, available_at)
       values ($1, $2, $3, $4, now())`,
      [id("job"), run.tenant_id, emailId, run.request_id]
    );
    return email.rows[0];
  });
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
  if (!row.rows[0]) throw new Error("Published template not found");
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

function statusFor(type: EventType) {
  switch (type) {
    case "email.sent":
      return "sent";
    case "email.delivery_delayed":
      return "delivery_delayed";
    case "email.delivered":
      return "delivered";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
    case "email.suppressed":
      return "suppressed";
    case "email.failed":
      return "failed";
    default:
      return null;
  }
}

async function finishJob(jobId: string, state: "done" | "failed") {
  await db.query("update send_jobs set state = $2, updated_at = now() where id = $1", [jobId, state]);
}

async function markWebhook(tenantId: string, webhookId: string, state: "healthy" | "retrying" | "failing" | "disabled", status?: number | null, error?: string) {
  await db.query(
    `insert into webhook_endpoint_health (webhook_id, tenant_id, state, consecutive_failures, last_status, last_error)
     values ($1, $2, $3, case when $3 = 'healthy' then 0 else 1 end, $4, $5)
     on conflict (webhook_id)
     do update set
       state = excluded.state,
       consecutive_failures = case when excluded.state = 'healthy' then 0 else webhook_endpoint_health.consecutive_failures + 1 end,
       last_status = excluded.last_status,
       last_error = excluded.last_error,
       checked_at = now()`,
    [webhookId, tenantId, state, status ?? null, error ?? null]
  );
}

async function incrementUsage(client: Pick<typeof db, "query">, tenantId: string, name: string, amount: number) {
  const period = new Date().toISOString().slice(0, 10);
  await client.query(
    `insert into usage_counters (id, tenant_id, name, period, value)
     values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, name, period)
     do update set value = usage_counters.value + excluded.value, updated_at = now()`,
    [id("usage"), tenantId, name, period, amount]
  );
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

async function webhookUrl(value: string) {
  return normalizeWebhookUrl(value, {
    requireHttps: process.env.NODE_ENV === "production",
    allowPrivate: privateWebhookTargetsEnabled()
  });
}

function privateWebhookTargetsEnabled() {
  return (process.env.ALLOW_PRIVATE_WEBHOOKS ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
