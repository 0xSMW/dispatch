import { ApiError, id, isIsoDate, normalizeAutomation, stableHash, triggerKey, type TriggerConfig } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { assertPropertyValues, propertyDefinitions, type ContactRow } from "./audience.js";
import { emitRunEvent } from "./run-events.js";

export type ContactChange = { field: string; from: unknown; to: unknown };
export type FiredEvent = {
  id: string; request_id: string; name: string; email: string | null;
  data: Record<string, unknown>; created_at: string;
};
type Candidate = {
  id: string; trigger: string; trigger_type: TriggerConfig["type"]; reentry: string;
  steps: Array<Record<string, unknown>>; connections: unknown[] | null;
};
export type TriggerOptions = {
  triggerType: TriggerConfig["type"]; key: string; contact: ContactRow | null;
  changes?: ContactChange[]; originRunId?: string;
};

export function contactDiff(before: ContactRow | null, after: ContactRow): ContactChange[] {
  const snapshot = (row: ContactRow | null): Record<string, unknown> => row ? {
    ...row.properties, email: row.email, first_name: row.first_name, last_name: row.last_name,
    unsubscribed: Boolean(row.unsubscribed_at)
  } : {};
  const previous = snapshot(before);
  const next = snapshot(after);
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])].flatMap((field) => {
    const from = previous[field] ?? null;
    const to = next[field] ?? null;
    return stableHash(from) === stableHash(to) ? [] : [{ field, from, to }];
  });
}

export function matchesTrigger(config: TriggerConfig, changes: ContactChange[] = []): boolean {
  if (config.type !== "contact_updated") return true;
  return changes.some((change) => (!config.field || change.field === config.field)
    && (!Object.hasOwn(config, "from") || change.from === config.from)
    && (!Object.hasOwn(config, "to") || change.to === config.to));
}

export async function assertTriggerConfig(db: Queryable, tenantId: string, config: TriggerConfig) {
  if (config.type === "contact_updated" && config.field) {
    const builtins: Record<string, string> = { email: "string", first_name: "string", last_name: "string", created_at: "date", unsubscribed: "boolean" };
    const definitions = await propertyDefinitions(db, tenantId);
    const type = (Object.hasOwn(builtins, config.field) ? builtins[config.field] : undefined) ?? definitions.find((row) => row.key === config.field)?.type;
    if (!type) throw new ApiError("validation_error", 422, `Contact field ${config.field} must be built-in or declared`);
    for (const key of ["from", "to"] as const) {
      const value = config[key];
      if (value === undefined || value === null) continue;
      if (type === "date" ? !isIsoDate(value) : typeof value !== type) {
        throw new ApiError("validation_error", 422, `${key} for ${config.field} must be a ${type}`);
      }
      assertPropertyValues({ [config.field]: value }, definitions);
    }
  }
  if (config.type === "topic_subscribed") {
    const topic = await db.query("select id from topics where tenant_id = $1 and id = $2 and deleted_at is null", [tenantId, config.topic_id]);
    if (!topic.rows[0]) throw new ApiError("validation_error", 422, "Its topic was deleted or does not exist");
  }
  if (config.type === "segment_added") {
    // to_jsonb supports static-only schemas and later rule-backed dynamic segments.
    const segment = await db.query<{ type: string }>(
      "select case when to_jsonb(s)->>'rule' is not null then 'dynamic' else coalesce(to_jsonb(s)->>'type', 'static') end as type from segments s where tenant_id = $1 and id = $2 and deleted_at is null",
      [tenantId, config.segment_id]
    );
    if (!segment.rows[0]) throw new ApiError("validation_error", 422, "Its segment was deleted or does not exist");
    if (segment.rows[0].type !== "static") throw new ApiError("validation_error", 422, "Segment triggers require a static segment");
  }
}

export async function recordEvent(client: Queryable, tenantId: string, requestId: string, input: { name: string; email: string | null; data: Record<string, unknown> }) {
  const row = await client.query<FiredEvent>(
    `insert into custom_events (id, tenant_id, request_id, name, email, data)
     values ($1, $2, $3, $4, $5, $6)
     returning id, request_id, name, email, data, created_at`,
    [id("ce"), tenantId, requestId, input.name, input.email, JSON.stringify(input.data)]
  );
  return row.rows[0]!;
}

async function candidates(client: Queryable, tenantId: string, options: TriggerOptions) {
  const found = await client.query<Candidate>(
    `select id, trigger, trigger_type, reentry, steps, connections from automations
     where tenant_id = $1 and trigger_type = $2 and trigger = $3 and enabled = true and deleted_at is null
       and to_jsonb(automations)->>'paused_at' is null
     order by created_at`,
    [tenantId, options.triggerType, options.key]
  );
  const matching = found.rows.filter((row) => {
    const config = normalizeAutomation(row, true).steps.find((step) => step.type === "trigger")!.config as TriggerConfig;
    return config.type === options.triggerType && triggerKey(config) === options.key && matchesTrigger(config, options.changes);
  });
  if ((options.triggerType === "topic_subscribed" || options.triggerType === "segment_added") && matching.length) {
    const config = normalizeAutomation(matching[0]!, true).steps.find((step) => step.type === "trigger")!.config as TriggerConfig;
    try { await assertTriggerConfig(client, tenantId, config); }
    catch (error) {
      if (error instanceof ApiError && error.statusCode === 422) return [];
      throw error;
    }
  }
  return matching;
}

async function origin(client: Queryable, tenantId: string, runId?: string) {
  if (!runId) return { automationId: null, depth: 0 };
  const row = await client.query<{ automation_id: string; trigger_type: string; data: Record<string, unknown> }>(
    `select r.automation_id, e.data, a.trigger_type from automation_runs r join custom_events e on e.id = r.event_id
     join automations a on a.id = r.automation_id
     where r.tenant_id = $1 and r.id = $2`, [tenantId, runId]
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Origin run not found");
  const depth = row.rows[0].trigger_type === "event" ? 0 : row.rows[0].data.depth;
  return { automationId: row.rows[0].automation_id, depth: Math.min(5, (typeof depth === "number" ? depth : 0) + 1) };
}

export async function startRuns(client: Queryable, tenantId: string, event: FiredEvent, options: TriggerOptions, selected?: Candidate[]) {
  const parent = await origin(client, tenantId, options.originRunId);
  if (parent.depth >= 5) return [];
  const runs: string[] = [];
  for (const automation of selected ?? await candidates(client, tenantId, options)) {
    if (automation.id === parent.automationId) continue;
    if (automation.reentry === "once" && options.contact) {
      const enrolled = await client.query(
        `insert into automation_enrollments (tenant_id, automation_id, contact_id)
         values ($1, $2, $3) on conflict do nothing returning contact_id`,
        [tenantId, automation.id, options.contact.id]
      );
      if (!enrolled.rows[0]) continue;
    }
    const run = await client.query<{ id: string }>(
      `insert into automation_runs (id, tenant_id, automation_id, event_id, state)
       values ($1, $2, $3, $4, 'ready') returning id`,
      [id("run"), tenantId, automation.id, event.id]
    );
    runs.push(run.rows[0]!.id);
    await emitRunEvent(client, tenantId, run.rows[0]!.id, "automation.run.started");
  }
  return runs;
}

export async function fireContactTrigger(client: Queryable, tenantId: string, requestId: string, options: TriggerOptions) {
  if (options.triggerType === "event") throw new ApiError("validation_error", 422, "Use fireEvent for real events");
  const selected = await candidates(client, tenantId, options);
  if (!selected.length) return { event: null, runs: [] };
  const parent = await origin(client, tenantId, options.originRunId);
  const contact = options.contact!;
  const event = await recordEvent(client, tenantId, requestId, {
    name: options.key, email: contact.email,
    data: { contact: { ...contact.properties, id: contact.id, email: contact.email, first_name: contact.first_name,
      last_name: contact.last_name, unsubscribed: Boolean(contact.unsubscribed_at), created_at: contact.created_at },
      changes: options.changes ?? [], depth: parent.depth, ...(options.originRunId ? { origin_run_id: options.originRunId } : {}) }
  });
  return { event, runs: await startRuns(client, tenantId, event, options, selected) };
}

export async function recordContactChanges(client: Queryable, tenantId: string, requestId: string, contactId: string, changes: ContactChange[]) {
  for (const change of changes) {
    await client.query(
      `insert into contact_changes (id, tenant_id, contact_id, field, from_value, to_value, request_id)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [id("change"), tenantId, contactId, change.field, JSON.stringify(change.from), JSON.stringify(change.to), requestId]
    );
  }
}

export async function dispatchContactWrite(client: Queryable, tenantId: string, requestId: string,
  before: ContactRow | null, contact: ContactRow, options: { created?: boolean; originRunId?: string } = {}) {
  const changes = contactDiff(before, contact);
  await recordContactChanges(client, tenantId, requestId, contact.id, changes);
  const triggerType = options.created ? "contact_created" : "contact_updated";
  if (!options.created && !changes.length) return;
  await fireContactTrigger(client, tenantId, requestId, {
    triggerType, key: triggerKey({ type: triggerType }), contact, changes, originRunId: options.originRunId
  });
}

export async function dispatchTopicChanges(client: Queryable, tenantId: string, requestId: string, contact: ContactRow,
  changes: Array<{ topic_id: string; before: string; after: string }>, originRunId?: string) {
  for (const change of changes) {
    if (change.before === change.after || contact.unsubscribed_at) continue;
    await recordContactChanges(client, tenantId, requestId, contact.id, [{ field: `topics.${change.topic_id}`, from: change.before === "subscribed", to: change.after === "subscribed" }]);
    if (change.before !== "subscribed" && change.after === "subscribed") {
      await fireContactTrigger(client, tenantId, requestId, {
        triggerType: "topic_subscribed", key: triggerKey({ type: "topic_subscribed", topic_id: change.topic_id }), contact, originRunId
      });
    }
  }
}

export async function dispatchSegmentAdded(client: Queryable, tenantId: string, requestId: string, contact: ContactRow, segmentId: string, added: boolean, originRunId?: string) {
  if (!added) return;
  await recordContactChanges(client, tenantId, requestId, contact.id, [{ field: `segments.${segmentId}`, from: false, to: true }]);
  await fireContactTrigger(client, tenantId, requestId, {
    triggerType: "segment_added", key: triggerKey({ type: "segment_added", segment_id: segmentId }), contact, originRunId
  });
}
