import type { Db, Queryable } from "./index.js";
import { findBy, tx } from "./index.js";
import { addContactSegment, assertPropertyValues, contactColumns, deleteContact, mergeProperties, propertyDefinitions, updateContact, type ContactRow } from "./audience.js";
import { dispatchContactWrite, dispatchSegmentAdded, recordEvent, startRuns } from "./contact-triggers.js";
export type { FiredEvent } from "./contact-triggers.js";
import { ingestEmail } from "./emails.js";
import { emit } from "./events.js";
import { recipientContext } from "./broadcasts.js";
import { subscriptionLinks, unsubscribeVariables } from "./unsubscribe.js";
import { emitRunEvent } from "./run-events.js";
import {
  ApiError,
  durationSeconds,
  evaluate,
  id,
  normalizeAutomation,
  parseAddress,
  toArray,
  type Connection,
  type Rule,
  type Step,
  type StepConfig,
  type TriggerConfig
} from "@dispatchmail/core";

export type AutomationRun = {
  id: string;
  tenant_id: string;
  automation_id: string;
  event_id: string;
  request_id: string;
  email: string | null;
  data: Record<string, unknown>;
  received_at?: string | Date;
};

export type AutomationRunOptions = {
  resumeData?: Record<string, unknown>;
  publicUrl?: string;
  secret?: string;
  appUrl?: string;
};

export type AutomationRow = {
  id: string;
  name: string;
  trigger: string;
  trigger_type?: TriggerConfig["type"];
  reentry?: "once" | "every_time";
  steps: Array<Record<string, unknown>>;
  connections: unknown[] | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type Outcome = Connection["type"];

export const stepLimit = 100;
export const activeStates = ["ready", "running", "waiting"];

export const automationColumns = "id, name, trigger, trigger_type, reentry, steps, connections, enabled, created_at, updated_at";

export async function findAutomation(db: Queryable, tenantId: string, automationId: string) {
  return findBy<AutomationRow>(db, "automations", tenantId, automationId, { select: automationColumns });
}

// Stored rows may still hold the linear format, so every reader normalizes.
export function automationGraph(row: { trigger?: string | null; steps: Array<Record<string, unknown>>; connections?: unknown[] | null }) {
  return normalizeAutomation({ trigger: row.trigger, steps: row.steps, connections: row.connections ?? [] }, true);
}

export function walker(graph: { steps: Step[]; connections: Connection[] }) {
  const byKey = new Map(graph.steps.map((step) => [step.key, step]));
  const next = (from: string, outcome: Outcome) =>
    graph.connections.find((c) => c.from === from && c.type === outcome)?.to ??
    graph.connections.find((c) => c.from === from && c.type === "default")?.to ??
    null;
  const trigger = graph.steps.find((step) => step.type === "trigger")?.key ?? null;
  return { byKey, next, trigger, index: (key: string) => graph.steps.findIndex((step) => step.key === key) };
}

type RunRow = AutomationRun & {
  state: string;
  next_step_index: number;
  next_step_key: string | null;
  resume_data: Record<string, unknown> | null;
  trigger: string;
  steps: Array<Record<string, unknown>>;
  connections: unknown[] | null;
  automation_deleted: boolean;
};

const stopped = Symbol("stopped");

// Runs one automation run until it finishes, pauses, or is stopped.
//
// Every write to the run carries `and state = 'running'`. Stop and delete set the run to
// `stopped`, so the next write changes nothing and the executor returns: a run that was stopped
// while a step was in flight never goes back to waiting and never sends its remaining emails.
//
// Each step commits in one transaction with its step row and the run's next position. A worker
// that dies mid-step leaves no trace of the step, and the run is picked up again from the same
// step without sending twice.
export async function executeAutomationRun(db: Db, tenantId: string, runId: string, options: AutomationRunOptions = {}) {
  try {
    const loaded = await db.query<RunRow>(
      `select r.id, r.tenant_id, r.automation_id, r.event_id, coalesce(e.request_id, r.id) as request_id,
         r.state, r.next_step_index, r.next_step_key, r.resume_data, a.trigger, a.steps, a.connections,
         (a.deleted_at is not null) as automation_deleted, e.email, e.data, e.created_at as received_at
       from automation_runs r
       join automations a on a.id = r.automation_id
       join custom_events e on e.id = r.event_id
       where r.tenant_id = $1 and r.id = $2`,
      [tenantId, runId]
    );
    const run = loaded.rows[0];
    if (!run) throw new ApiError("not_found", 404, "Automation run not found");
    if (run.state === "done" || run.state === "failed" || run.state === "stopped") return;
    if (run.automation_deleted) {
      await tx(db, async (client) => {
        const stoppedRun = await client.query(
          `update automation_runs set state = 'stopped', resume_at = null, wait_event = null, updated_at = now()
           where tenant_id = $1 and id = $2 and state = any($3) returning id`,
          [tenantId, runId, activeStates]
        );
        if (stoppedRun.rows[0]) await emitRunEvent(client, tenantId, runId, "automation.run.completed");
      });
      return;
    }

    const claimed = await db.query(
      `update automation_runs
       set state = 'running', resume_at = null, wait_event = null, updated_at = now()
       where tenant_id = $1 and id = $2 and state = any($3)
       returning id`,
      [tenantId, runId, activeStates]
    );
    if (!claimed.rows[0]) return;

    const graph = automationGraph(run);
    const walk = walker(graph);

    let key: string | null;
    const fresh = !run.next_step_key && run.next_step_index === 0;
    if (fresh) {
      key = walk.trigger ? walk.next(walk.trigger, "default") : null;
    } else {
      const start = run.next_step_key ?? (await resolveLegacyKey(db, tenantId, runId, run.next_step_index, graph.steps));
      const paused = start ? walk.byKey.get(start) : undefined;
      const resumeData = options.resumeData ?? run.resume_data ?? {};
      // Closing the wait step and moving the run past it commit together. If the wait was the
      // last step, the run is marked done in the same statement.
      const moved = await tx(db, async (client) => {
        const resumed = start ? await finishWaiting(client, tenantId, runId, start, resumeData) : false;
        const next = resumed && paused ? walk.next(paused.key, resumeOutcome(paused, resumeData)) : start;
        const advanced = await advance(client, tenantId, runId, next);
        return advanced ? next : stopped;
      });
      if (moved === stopped) return;
      key = moved;
    }

    for (let count = 0; key; count += 1) {
      if (count >= stepLimit) throw new ApiError("validation_error", 422, `Automation run stopped after ${stepLimit} steps`);
      const step = walk.byKey.get(key);
      if (!step) throw new ApiError("validation_error", 422, `Automation step ${key} does not exist`);
      const index = walk.index(key);

      if (step.type === "delay" || step.type === "wait_for_event") {
        await pauseAutomation(db, tenantId, runId, index, step);
        return;
      }

      const startedAt = new Date();
      let next: string | null | typeof stopped;
      try {
        next = await tx(db, async (client) => {
          // The lock also makes a concurrent stop wait until this step has committed.
          const alive = await client.query(
            "select id from automation_runs where tenant_id = $1 and id = $2 and state = 'running' for update",
            [tenantId, runId]
          );
          if (!alive.rows[0]) return stopped;
          const output = await executeStep(client, run, step, options);
          const following = walk.next(step.key, stepOutcome(step, output));
          await client.query(
            `insert into automation_steps (id, tenant_id, run_id, step_index, step_key, type, state, data, started_at, completed_at)
             values ($1, $2, $3, $4, $5, $6, 'done', $7, $8, now())`,
            [id("step"), tenantId, runId, index, step.key, step.type, JSON.stringify(output), startedAt]
          );
          await advance(client, tenantId, runId, following);
          return following;
        });
      } catch (error) {
        // The step's transaction rolled back. Its failure is recorded on its own.
        await db.query(
          `insert into automation_steps (id, tenant_id, run_id, step_index, step_key, type, state, data, error, started_at, completed_at)
           values ($1, $2, $3, $4, $5, $6, 'failed', '{}', $7, $8, now())`,
          [id("step"), tenantId, runId, index, step.key, step.type, error instanceof Error ? error.message : String(error), startedAt]
        );
        throw error;
      }
      if (next === stopped) return;
      key = next;
    }

    // Reached with nothing left to run: a graph with only a trigger, or a resume past the last step.
    await tx(db, (client) => advance(client, tenantId, runId, null));
  } catch (error) {
    await tx(db, async (client) => {
      const failed = await client.query(
        `update automation_runs set state = 'failed', error = $3, resume_at = null, wait_event = null, updated_at = now()
         where tenant_id = $1 and id = $2 and state = 'running' returning id`,
        [tenantId, runId, error instanceof Error ? error.message : String(error)]
      );
      if (failed.rows[0]) await emitRunEvent(client, tenantId, runId, "automation.run.failed");
    });
  }
}

// Moves a running run to its next step, or marks it done when there is none. Returns false when
// the run is no longer running, which means it was stopped.
async function advance(client: Queryable, tenantId: string, runId: string, next: string | null) {
  const row = await client.query(
    `update automation_runs
     set next_step_key = $3, resume_data = null, resume_at = null, wait_event = null, updated_at = now(),
       state = case when $3::text is null then 'done' else state end
     where tenant_id = $1 and id = $2 and state = 'running'
     returning id`,
    [tenantId, runId, next]
  );
  if (row.rows[0] && next === null) await emitRunEvent(client, tenantId, runId, "automation.run.completed");
  return Boolean(row.rows[0]);
}

export function stepOutcome(step: Step, output: Record<string, unknown>): Outcome {
  if (step.type !== "condition") return "default";
  return output.result ? "condition_met" : "condition_not_met";
}

export function resumeOutcome(step: Step, resumeData: Record<string, unknown> = {}): Outcome {
  if (step.type !== "wait_for_event") return "default";
  return resumeData.timed_out ? "timeout" : "event_received";
}

// Runs that paused before step keys existed carry only next_step_index. A paused legacy run
// points one past its wait step, which sits at normalized index next_step_index because the
// trigger occupies index 0. Resolve once and store the key on the run and the waiting step.
async function resolveLegacyKey(db: Queryable, tenantId: string, runId: string, nextIndex: number, steps: Step[]) {
  const waiting = await db.query<{ id: string; step_index: number }>(
    `select id, step_index from automation_steps
     where tenant_id = $1 and run_id = $2 and state = 'waiting' and step_key is null
     order by created_at desc limit 1`,
    [tenantId, runId]
  );
  const paused = waiting.rows[0]?.step_index === nextIndex - 1;
  const key = (paused ? steps[nextIndex]?.key : steps[nextIndex + 1]?.key) ?? null;
  if (paused && key) {
    await db.query("update automation_steps set step_key = $3 where tenant_id = $1 and id = $2", [tenantId, waiting.rows[0]!.id, key]);
  }
  await db.query("update automation_runs set next_step_key = $3 where tenant_id = $1 and id = $2", [tenantId, runId, key]);
  return key;
}

async function finishWaiting(db: Queryable, tenantId: string, runId: string, key: string, resumeData: Record<string, unknown>) {
  const row = await db.query(
    `update automation_steps
     set state = 'done', completed_at = now(), data = data || jsonb_build_object('resumed_at', now()) || $4::jsonb
     where tenant_id = $1 and run_id = $2 and step_key = $3 and state = 'waiting'
     returning id`,
    [tenantId, runId, key, JSON.stringify(resumeData)]
  );
  return (row.rowCount ?? row.rows.length) > 0;
}

async function pauseAutomation(db: Db, tenantId: string, runId: string, index: number, step: Step) {
  let resumeAt: Date | null;
  let data: Record<string, unknown>;
  let waitEvent: string | null = null;
  if (step.type === "delay") {
    const config = step.config as StepConfig<"delay">;
    resumeAt = new Date(Date.now() + durationSeconds(config.duration) * 1_000);
    data = { duration: config.duration, resume_at: resumeAt.toISOString() };
  } else {
    const config = step.config as StepConfig<"wait_for_event">;
    resumeAt = config.timeout ? new Date(Date.now() + durationSeconds(config.timeout) * 1_000) : null;
    data = { event_name: config.event_name, timeout_at: resumeAt?.toISOString() ?? null };
    waitEvent = config.event_name;
  }

  await tx(db, async (client) => {
    // Only a run that is still running may wait. A stopped run stays stopped.
    const paused = await client.query(
      `update automation_runs
       set state = 'waiting', next_step_key = $3, resume_at = $4, wait_event = $5, resume_data = null, updated_at = now()
       where tenant_id = $1 and id = $2 and state = 'running'
       returning id`,
      [tenantId, runId, step.key, resumeAt, waitEvent]
    );
    if (!paused.rows[0]) return;
    await client.query(
      `insert into automation_steps (id, tenant_id, run_id, step_index, step_key, type, state, data, started_at)
       values ($1, $2, $3, $4, $5, $6, 'waiting', $7, now())`,
      [id("step"), tenantId, runId, index, step.key, step.type, JSON.stringify(data)]
    );
  });
}

// Addresses are matched without regard to case. A deleted contact is reported as deleted so a
// step can leave it alone: an automation must not bring back someone who was erased.
async function stepContact(db: Queryable, tenantId: string, email: string, requestId: string, originRunId: string) {
  const read = () => db.query<ContactRow & { deleted: boolean }>(
    `select ${contactColumns}, (deleted_at is not null) as deleted
     from contacts where tenant_id = $1 and lower(email) = lower($2)
     order by deleted_at nulls first, created_at
     limit 1 for update`,
    [tenantId, email]
  );
  let row = await read();
  const found = row.rows[0];
  if (found?.deleted) return { deleted: true as const };
  if (found) return { ...found, deleted: false as const };
  const inserted = await db.query<ContactRow>(
    `insert into contacts (id, tenant_id, email) values ($1, $2, lower($3))
     on conflict do nothing returning ${contactColumns}`, [id("contact"), tenantId, email]
  );
  const created = inserted.rows[0];
  if (created) {
    await dispatchContactWrite(db, tenantId, requestId, null, created, { created: true, originRunId });
    return { ...created, deleted: false as const };
  }
  row = await read();
  if (!row.rows[0] || row.rows[0].deleted) return { deleted: true as const };
  return { ...row.rows[0], deleted: false as const };
}

// The condition context: { event: <payload>, contact: <contact with properties flattened> }.
export async function contactContext(db: Queryable, tenantId: string, email: string | null) {
  if (!email) return null;
  const row = await db.query<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    properties: Record<string, unknown> | null;
    unsubscribed_at: string | null;
    created_at: string | Date;
    topics: string[];
    segments: string[];
  }>(
    `select id, email, first_name, last_name, properties, unsubscribed_at, created_at,
       array(select t.id from topics t
         left join topic_subscriptions s on s.tenant_id = t.tenant_id and s.topic_id = t.id and s.contact_id = contacts.id
         where t.tenant_id = contacts.tenant_id and t.deleted_at is null
           and coalesce(s.status, t.default_status) = 'subscribed' order by t.id) as topics,
       array(select s.id from segments s
         join segment_contacts m on m.tenant_id = s.tenant_id and m.segment_id = s.id
         where s.tenant_id = contacts.tenant_id and m.contact_id = contacts.id and s.deleted_at is null
         order by s.id) as segments
     from contacts where tenant_id = $1 and lower(email) = lower($2) and deleted_at is null
     order by created_at limit 1`,
    [tenantId, email]
  );
  const contact = row.rows[0];
  if (!contact) return null;
  return {
    ...(contact.properties ?? {}),
    ...(!Object.hasOwn(contact.properties ?? {}, "topics") ? { topics: contact.unsubscribed_at ? [] : contact.topics ?? [] } : {}),
    ...(!Object.hasOwn(contact.properties ?? {}, "segments") ? { segments: contact.segments ?? [] } : {}),
    id: contact.id,
    email: contact.email,
    first_name: contact.first_name,
    last_name: contact.last_name,
    unsubscribed: Boolean(contact.unsubscribed_at),
    created_at: contact.created_at instanceof Date ? contact.created_at.toISOString() : contact.created_at
  };
}

export function eventContext(data: Record<string, unknown>, receivedAt?: string | Date) {
  return { ...data, received_at: receivedAt instanceof Date ? receivedAt.toISOString() : receivedAt };
}

export function mappedVariables(mapping: Record<string, string> | undefined, context: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(mapping ?? {}).flatMap(([key, field]) => {
    const value = field.split(".").reduce<unknown>((current, part) =>
      current !== null && typeof current === "object" && Object.hasOwn(current, part)
        ? (current as Record<string, unknown>)[part] : undefined, context);
    return value === undefined ? [] : [[key, value]];
  }));
}

async function executeStep(db: Queryable, run: AutomationRun, step: Step, options: AutomationRunOptions): Promise<Record<string, unknown>> {
  if (step.type === "trigger") return {};

  if (step.type === "condition") {
    const contact = await contactContext(db, run.tenant_id, run.email);
    return { result: evaluate(step.config as Rule, { event: eventContext(run.data, run.received_at), contact }) };
  }

  if (step.type === "send_email") {
    const config = step.config as StepConfig<"send_email">;
    const to = config.to ?? run.email;
    if (!to) throw new ApiError("validation_error", 422, "send_email step needs a recipient");
    const recipient = await contactContext(db, run.tenant_id, to);
    // An automation can send anything: a receipt, a password reset, a newsletter. Only the step
    // knows which. A step with a topic is subscription mail, so it skips a contact who
    // unsubscribed from everything or opted out of that topic. A step without one always sends,
    // as POST /emails does.
    if (config.topic_id) {
      if (recipient?.unsubscribed) return { skipped: "unsubscribed", email: to };
      // A deleted contact is subscribed to nothing.
      if (!recipient) {
        const deleted = await db.query("select 1 from contacts where tenant_id = $1 and lower(email) = lower($2) and deleted_at is not null", [run.tenant_id, to]);
        if (deleted.rows[0]) return { skipped: "contact_deleted", email: to };
      }
    }
    const event = eventContext(run.data, run.received_at);
    const variables = { ...run.data, event, email: run.email, ...config.template.variables,
      ...mappedVariables(config.variable_mapping, { event, contact: recipient }) };
    const emailId = id("email");
    const context = recipientContext({
      email: to, first_name: recipient?.first_name ?? null, last_name: recipient?.last_name ?? null,
      properties: recipient ? Object.fromEntries(Object.entries(recipient).filter(([key]) => !["id", "email", "first_name", "last_name", "unsubscribed"].includes(key))) : {},
    }, "");
    for (const key of unsubscribeVariables) delete (context as Record<string, unknown>)[key];
    const links = config.topic_id ? subscriptionLinks({
      tenantId: run.tenant_id, contactId: recipient?.id, email: to, topicId: config.topic_id,
      emailId, ...options,
    }) : null;
    // With no sender on the step, the template's stored sender is used.
    const from = config.from ? parseAddress(config.from) : null;
    // On the step's own transaction, so the email, the step row, and the run's progress commit together.
    const result = await ingestEmail(db, {
      tenantId: run.tenant_id,
      requestId: run.request_id,
      emailId,
      contactId: recipient?.id,
      automationId: run.automation_id,
      automationStep: step.key,
      from: from?.email ?? "",
      fromName: from?.name,
      to,
      topicId: config.topic_id,
      subject: config.subject,
      replyTo: config.reply_to ? toArray(config.reply_to) : undefined,
      template: config.template.id,
      variables,
      context: { ...context, ...links?.context },
      headers: links?.headers,
      tags: { automation_id: run.automation_id, automation_run_id: run.id, event_id: run.event_id },
      publicUrl: options.publicUrl
    });
    // The topic check inside the send found an opt-out: the email exists and went to nobody.
    if (config.topic_id && result.email.status === "failed") return { email_id: result.email.id, skipped: "opted_out", email: to };
    return { email_id: result.email.id };
  }

  if (step.type === "contact_update") {
    const config = step.config as StepConfig<"contact_update">;
    const email = config.email ?? run.email;
    if (!email) throw new ApiError("validation_error", 422, "contact_update step needs an email");
    assertPropertyValues(config.properties, await propertyDefinitions(db, run.tenant_id));
    const contact = await stepContact(db, run.tenant_id, email, run.request_id, run.id);
    if (contact.deleted) return { skipped: "contact_deleted", email };
    const updated = await updateContact(db, run.tenant_id, contact.id, {
      ...config, properties: mergeProperties(contact.properties, config.properties ?? {})
    });
    await dispatchContactWrite(db, run.tenant_id, run.request_id, contact, updated, { originRunId: run.id });
    // The same event a PATCH /contacts/:id produces, so webhooks hear about changes an
    // automation makes. Keyed on the run and step, so a step that is retried emits it once.
    await emit(db, {
      tenantId: run.tenant_id,
      requestId: run.request_id,
      type: "contact.updated",
      resourceId: contact.id,
      data: { id: contact.id, email: updated.email },
      key: `${contact.id}:contact.updated:${run.id}:${step.key}`,
    });
    return { contact_id: updated.id, email };
  }

  if (step.type === "contact_delete") {
    const config = step.config as StepConfig<"contact_delete">;
    const email = config.email ?? run.email;
    if (!email) throw new ApiError("validation_error", 422, "contact_delete step needs an email");
    const row = await db.query<{ id: string }>(
      "select id from contacts where tenant_id = $1 and lower(email) = lower($2) and deleted_at is null order by created_at limit 1",
      [run.tenant_id, email]
    );
    const deleted = row.rows[0] ? await deleteContact(db, run.tenant_id, row.rows[0].id) : false;
    if (deleted && row.rows[0]) {
      await emit(db, {
        tenantId: run.tenant_id,
        requestId: run.request_id,
        type: "contact.deleted",
        resourceId: row.rows[0].id,
        data: { id: row.rows[0].id },
        key: `${row.rows[0].id}:contact.deleted:${run.id}:${step.key}`,
      });
    }
    return { contact_id: row.rows[0]?.id ?? null, email, deleted };
  }

  if (step.type === "add_to_segment") {
    const config = step.config as StepConfig<"add_to_segment">;
    const email = config.email ?? run.email;
    if (!email) throw new ApiError("validation_error", 422, "add_to_segment step needs an email");
    const segment = await db.query("select id from segments where tenant_id = $1 and id = $2 and deleted_at is null", [
      run.tenant_id,
      config.segment_id
    ]);
    if (!segment.rows[0]) throw new ApiError("not_found", 404, "Segment not found");
    const contact = await stepContact(db, run.tenant_id, email, run.request_id, run.id);
    if (contact.deleted) return { skipped: "contact_deleted", email };
    const member = await addContactSegment(db, run.tenant_id, contact.id, config.segment_id);
    await dispatchSegmentAdded(db, run.tenant_id, run.request_id, contact, config.segment_id, member.added, run.id);
    return { segment_id: config.segment_id, contact_id: contact.id, email };
  }

  throw new ApiError("validation_error", 422, `Unsupported automation step: ${step.type}`);
}

// The limits POST /contacts sets. A name that breaks them is left out, and the event still goes.
function eventName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name.length <= 120 ? name : null;
}

// An event is often the first Dispatch hears of a person, such as a signup. An address with no
// contact gets one, subscribed, named from the payload's `first_name` and `last_name`. A live
// contact with no name gets the event's, and a name it has is never changed.
// A deleted contact keeps its address in the unique index, so its row is found here and nothing
// is created or revived: the deletion may have been a privacy request.
async function eventContact(client: Queryable, tenantId: string, requestId: string, eventId: string, email: string, data: Record<string, unknown>, retried = false) {
  const firstName = eventName(data.first_name);
  const lastName = eventName(data.last_name);
  const found = await client.query<ContactRow & { deleted_at: string | null }>(
    `select ${contactColumns}, deleted_at from contacts where tenant_id = $1 and lower(email) = lower($2) limit 1 for update`,
    [tenantId, email],
  );
  const current = found.rows[0];
  if (current) {
    const blank = (value: string | null) => !value?.trim();
    if (current.deleted_at || !((firstName && blank(current.first_name)) || (lastName && blank(current.last_name)))) return;
    const named = await client.query<ContactRow>(
      `update contacts set
         first_name = coalesce(nullif(trim(first_name), ''), $3, first_name),
         last_name = coalesce(nullif(trim(last_name), ''), $4, last_name),
         updated_at = now()
       where tenant_id = $1 and id = $2 and deleted_at is null
       returning ${contactColumns}`,
      [tenantId, current.id, firstName, lastName],
    );
    const contact = named.rows[0];
    if (!contact) return;
    await dispatchContactWrite(client, tenantId, requestId, current, contact);
    await emit(client, {
      tenantId,
      requestId,
      type: "contact.updated",
      resourceId: contact.id,
      data: { id: contact.id, email: contact.email },
      key: `${contact.id}:contact.updated:${eventId}`,
    });
    return;
  }
  // No conflict target, so both unique indexes on the address arbitrate. Two events for one new
  // address at once then make one contact, and the second neither fails nor changes it.
  const inserted = await client.query<ContactRow>(
    `insert into contacts (id, tenant_id, email, first_name, last_name)
     values ($1, $2, lower($3), $4, $5)
     on conflict do nothing
     returning ${contactColumns}`,
    [id("contact"), tenantId, email, firstName, lastName],
  );
  const contact = inserted.rows[0];
  if (!contact) {
    // A concurrent creator won. Re-read under its row lock before filling missing names.
    if (!retried) await eventContact(client, tenantId, requestId, eventId, email, data, true);
    return;
  }
  await dispatchContactWrite(client, tenantId, requestId, null, contact, { created: true });
  await emit(client, {
    tenantId,
    requestId,
    type: "contact.created",
    resourceId: contact.id,
    data: { id: contact.id, email: contact.email },
    key: `${contact.id}:contact.created:${eventId}`,
  });
}

// Stores a fired event, starts a run for every enabled automation it triggers, and wakes
// runs waiting on it. New and woken runs are left `ready`. The worker picks them up, so the
// request that fired the event returns at once and a crash cannot strand a run.
export async function fireEvent(
  db: Db,
  tenantId: string,
  requestId: string,
  input: { name: string; email?: string | null; data: Record<string, unknown> }
) {
  const email = input.email ? input.email.toLowerCase() : null;
  return tx(db, async (client) => {
    const fired = await recordEvent(client, tenantId, requestId, { ...input, email });
    if (email) await eventContact(client, tenantId, requestId, fired.id, email, input.data);
    const contact = await contactContext(client, tenantId, email);

    const contactRow = email ? await client.query<ContactRow>(
      `select ${contactColumns} from contacts where tenant_id = $1 and lower(email) = lower($2) and deleted_at is null`,
      [tenantId, email]
    ) : null;
    const runs = await startRuns(client, tenantId, fired, { triggerType: "event", key: input.name, contact: contactRow?.rows[0] ?? null });

    const waiting = await client.query<{
      id: string;
      next_step_key: string | null;
      trigger: string;
      steps: Array<Record<string, unknown>>;
      connections: unknown[] | null;
    }>(
      `select r.id, r.next_step_key, a.trigger, a.steps, a.connections
       from automation_runs r
       join automations a on a.id = r.automation_id
       join custom_events started on started.id = r.event_id
       where r.tenant_id = $1 and r.state = 'waiting' and r.wait_event = $2
         and a.deleted_at is null
         and (
           (started.email is null and $3::text is null)
           or lower(started.email) = $3
         )
       order by r.updated_at, r.id
       for update of r skip locked`,
      [tenantId, input.name, email]
    );
    const resumed = waiting.rows.filter((run) => matchesFilter(run, { event: eventContext(fired.data, fired.created_at), contact })).map((run) => run.id);
    if (resumed.length > 0) {
      await client.query(
        `update automation_runs
         set state = 'ready', resume_at = null, wait_event = null, resume_data = $3, updated_at = now()
         where tenant_id = $1 and id = any($2)`,
        [tenantId, resumed, JSON.stringify({ event_id: fired.id })]
      );
    }
    return { event: fired, runs, resumed };
  });
}

function matchesFilter(
  run: { next_step_key: string | null; trigger: string; steps: Array<Record<string, unknown>>; connections: unknown[] | null },
  context: Record<string, unknown>
) {
  if (!run.next_step_key) return true;
  try {
    const step = automationGraph(run).steps.find((item) => item.key === run.next_step_key);
    const rule = (step?.config as { filter_rule?: Rule } | undefined)?.filter_rule;
    return rule ? evaluate(rule, context) : true;
  } catch {
    return true;
  }
}
