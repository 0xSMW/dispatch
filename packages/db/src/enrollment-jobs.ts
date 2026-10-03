import { ApiError, id, normalizeAutomation, stableHash, type TriggerConfig } from "@dispatchmail/core";
import { tx, type Db, type Queryable } from "./index.js";
import { contactColumns, type ContactRow } from "./audience.js";
import { assertTriggerConfig, recordEvent, startRuns } from "./contact-triggers.js";

export type EnrollmentCounts = { total: number; processed: number; enrolled: number; skipped: number; failed: number };
export type EnrollmentJob = {
  id: string; tenant_id: string; automation_id: string; segment_id: string | null;
  status: "queued" | "in_progress" | "completed" | "failed" | "cancelled";
  counts: EnrollmentCounts; error: string | null; cursor: string | null;
  created_at: string | Date; completed_at: string | Date | null;
};
type EnrollmentAutomation = {
  id: string; trigger: string; trigger_type: TriggerConfig["type"]; reentry: string;
  steps: Array<Record<string, unknown>>; connections: unknown[] | null;
  enabled: boolean; paused_at: string | null;
};

export function presentEnrollmentJob(row: EnrollmentJob) {
  return { object: "automation_enrollment_job" as const, id: row.id, automation_id: row.automation_id,
    segment_id: row.segment_id, status: row.status, counts: row.counts, error: row.error,
    created_at: row.created_at, completed_at: row.completed_at };
}

async function enrollmentAutomation(client: Queryable, tenantId: string, automationId: string, allowPaused = false) {
  const found = await client.query<EnrollmentAutomation>(
    `select id, trigger, trigger_type, reentry, steps, connections, enabled, paused_at
     from automations a where tenant_id = $1 and id = $2 and deleted_at is null for share`,
    [tenantId, automationId],
  );
  const automation = found.rows[0];
  if (!automation) throw new ApiError("not_found", 404, "Automation not found");
  if (!automation.enabled || (automation.paused_at && !allowPaused)) throw new ApiError("conflict", 409, "Enrollment requires an enabled, unpaused automation");
  if (automation.trigger_type === "event") throw new ApiError("conflict", 409, "Event triggers need an event payload and cannot enroll contacts");
  const config = normalizeAutomation(automation, true).steps.find((step) => step.type === "trigger")!.config as TriggerConfig;
  await assertTriggerConfig(client, tenantId, config);
  return automation;
}

async function assertSegment(client: Queryable, tenantId: string, segmentId: string | null) {
  if (!segmentId) return;
  const found = await client.query(
    `select id from segments s where tenant_id = $1 and id = $2 and deleted_at is null
       and to_jsonb(s)->>'rule' is null and coalesce(to_jsonb(s)->>'type', 'static') = 'static'`,
    [tenantId, segmentId],
  );
  if (!found.rows[0]) throw new ApiError("not_found", 404, "Static segment not found");
}

const audience = `c.tenant_id = $1 and c.deleted_at is null and c.created_at <= $3
  and ($2::text is null or exists (
    select 1 from segment_contacts s where s.tenant_id = c.tenant_id and s.contact_id = c.id and s.segment_id = $2))`;

export async function createEnrollmentJob(db: Db, tenantId: string, automationId: string,
  input: { segment_id?: string; all?: true }, idempotencyKey?: string) {
  return tx(db, async (client) => {
    const segmentId = input.segment_id ?? null;
    const hash = stableHash({ segment_id: segmentId });
    if (idempotencyKey) {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`enroll:${tenantId}:${automationId}:${idempotencyKey}`]);
      const previous = await client.query<EnrollmentJob & { input_hash: string }>(
        "select * from automation_enrollment_jobs where tenant_id = $1 and automation_id = $2 and idempotency_key = $3",
        [tenantId, automationId, idempotencyKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].input_hash !== hash) throw new ApiError("conflict", 409, "Idempotency key was used with another audience");
        return previous.rows[0];
      }
    }
    await enrollmentAutomation(client, tenantId, automationId);
    await assertSegment(client, tenantId, segmentId);
    const total = await client.query<{ total: number }>(
      `select count(*)::integer as total from contacts c where ${audience.replace("$3", "now()")}`,
      [tenantId, segmentId],
    );
    const row = await client.query<EnrollmentJob>(
      `insert into automation_enrollment_jobs (id, tenant_id, automation_id, segment_id, idempotency_key, input_hash, counts)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [id("enroll"), tenantId, automationId, segmentId, idempotencyKey ?? null, hash,
        JSON.stringify({ total: total.rows[0]!.total, processed: 0, enrolled: 0, skipped: 0, failed: 0 })],
    );
    return row.rows[0]!;
  });
}

export async function findEnrollmentJob(db: Queryable, tenantId: string, automationId: string, jobId: string) {
  const row = await db.query<EnrollmentJob>(
    "select * from automation_enrollment_jobs where tenant_id = $1 and automation_id = $2 and id = $3",
    [tenantId, automationId, jobId],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Enrollment job not found");
  return row.rows[0];
}

export async function cancelEnrollmentJob(db: Queryable, tenantId: string, automationId: string, jobId: string) {
  await db.query(
    `update automation_enrollment_jobs set status = 'cancelled', completed_at = now(), updated_at = now()
     where tenant_id = $1 and automation_id = $2 and id = $3 and status in ('queued', 'in_progress')`,
    [tenantId, automationId, jobId],
  );
  return findEnrollmentJob(db, tenantId, automationId, jobId);
}

export async function processEnrollmentBatch(db: Db, tenantId: string, automationId: string, jobId: string) {
  return tx(db, async (client) => {
    const found = await client.query<EnrollmentJob>(
      `select * from automation_enrollment_jobs where tenant_id = $1 and automation_id = $2 and id = $3 for update skip locked`,
      [tenantId, automationId, jobId],
    );
    const job = found.rows[0];
    if (!job) return null;
    if (job.status !== "queued" && job.status !== "in_progress") return job;
    const automation = await enrollmentAutomation(client, tenantId, automationId, true);
    if (automation.paused_at) return job;
    await assertSegment(client, tenantId, job.segment_id);
    const contacts = await client.query<ContactRow>(
      `select ${contactColumns} from contacts c where ${audience} and ($4::text is null or c.id > $4)
       order by c.id limit 500 for update of c`,
      [tenantId, job.segment_id, job.created_at, job.cursor],
    );
    const counts = { ...job.counts };
    for (const contact of contacts.rows) {
      const receipt = await client.query(
        `insert into automation_enrollment_job_contacts (job_id, contact_id) values ($1, $2)
         on conflict do nothing returning contact_id`, [job.id, contact.id],
      );
      if (!receipt.rows[0]) continue;
      const event = await recordEvent(client, tenantId, job.id, { name: automation.trigger, email: contact.email,
        data: { enrollment_job_id: job.id, contact: { ...contact.properties, id: contact.id, email: contact.email,
          first_name: contact.first_name, last_name: contact.last_name, unsubscribed: Boolean(contact.unsubscribed_at),
          created_at: contact.created_at }, changes: [], depth: 0 } });
      const runs = await startRuns(client, tenantId, event, { triggerType: automation.trigger_type, key: automation.trigger,
        contact, priority: "bulk" }, [automation]);
      counts.processed += 1;
      counts.enrolled += runs.length;
      counts.skipped += runs.length ? 0 : 1;
    }
    const completed = contacts.rows.length < 500;
    const updated = await client.query<EnrollmentJob>(
      `update automation_enrollment_jobs set status = $4, counts = $5, cursor = $6, updated_at = now(),
         completed_at = case when $4 = 'completed' then now() else null end
       where tenant_id = $1 and automation_id = $2 and id = $3 returning *`,
      [tenantId, automationId, job.id, completed ? "completed" : "in_progress", JSON.stringify(counts),
        contacts.rows.at(-1)?.id ?? job.cursor],
    );
    return updated.rows[0]!;
  });
}

export async function processEnrollmentJobs(db: Db, limit = 1) {
  const jobs = await db.query<EnrollmentJob>(
    `select j.* from automation_enrollment_jobs j
     join automations a on a.tenant_id = j.tenant_id and a.id = j.automation_id
     where j.status in ('queued', 'in_progress') and a.paused_at is null
     order by j.updated_at, j.id limit $1`, [limit],
  );
  for (const job of jobs.rows) {
    try { await processEnrollmentBatch(db, job.tenant_id, job.automation_id, job.id); }
    catch (error) {
      // Transaction conflicts and connection interruptions roll the page back and retry on the
      // next tick. Never turn a competing worker's successfully advanced page into a failure.
      const code = (error as { code?: string }).code;
      if (code && (["40001", "40P01", "55P03", "57P01", "53300"].includes(code) || code.startsWith("08"))) continue;
      await db.query(
        `update automation_enrollment_jobs set status = 'failed', error = $4, completed_at = now(), updated_at = now()
         where tenant_id = $1 and automation_id = $2 and id = $3 and status in ('queued', 'in_progress')
           and cursor is not distinct from $5::text`,
        [job.tenant_id, job.automation_id, job.id, error instanceof Error ? error.message : "Enrollment failed", job.cursor],
      );
    }
  }
  return jobs.rows.length;
}
