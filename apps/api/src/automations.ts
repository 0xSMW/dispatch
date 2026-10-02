import { ApiError, automationGraphSchema, automationSchema, automationUpdateSchema, id } from "@dispatchmail/core";
import {
  activeStates,
  automationColumns,
  automationGraph,
  findAutomation,
  paginate,
  softDelete,
  tx,
  type AutomationRow,
  type Db,
  type PagingParams,
} from "@dispatchmail/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { runWhere, type RunQuery } from "./filters.js";

type RunRow = {
  id: string;
  automation_id: string;
  event_id: string;
  event_name: string;
  email: string | null;
  event_data?: Record<string, unknown>;
  state: string;
  next_step_key?: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type StepRow = {
  id: string;
  step_key: string | null;
  step_index: number;
  type: string;
  state: string;
  data: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

const runStatuses: Record<string, string> = {
  ready: "running",
  running: "running",
  waiting: "running",
  done: "completed",
  failed: "failed",
  stopped: "cancelled",
};

const stepStatuses: Record<string, string> = { waiting: "running", done: "completed", failed: "failed" };

export function runStatus(state: string) {
  return runStatuses[state] ?? state;
}

// Turns a comma-separated Resend status filter into the stored states it covers.
export function runStates(filter?: string) {
  if (!filter) return null;
  const states = new Set<string>();
  for (const status of filter.split(",").map((value) => value.trim()).filter(Boolean)) {
    const matched = Object.entries(runStatuses).filter(([, value]) => value === status);
    if (!matched.length) {
      throw new ApiError("validation_error", 422, "status must be running, completed, failed, or cancelled");
    }
    for (const [state] of matched) states.add(state);
  }
  return [...states];
}

export function presentAutomation(row: AutomationRow) {
  const graph = automationGraph(row);
  return {
    object: "automation",
    id: row.id,
    name: row.name,
    status: row.enabled ? "enabled" : "disabled",
    trigger: row.trigger,
    steps: graph.steps,
    connections: graph.connections,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function presentAutomationRow(row: AutomationRow & { run_count?: number }) {
  return {
    id: row.id,
    name: row.name,
    status: row.enabled ? "enabled" : "disabled",
    trigger: row.trigger,
    run_count: row.run_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function presentRun(row: RunRow) {
  return {
    object: "automation_run",
    id: row.id,
    automation_id: row.automation_id,
    status: runStatus(row.state),
    event: { id: row.event_id, name: row.event_name, email: row.email },
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const runStatusNames = ["running", "completed", "failed", "cancelled"] as const;

export function presentRunMetrics(automationId: string, rows: Array<{ day: string; state: string; count: number }>) {
  const empty = () => Object.fromEntries(runStatusNames.map((name) => [name, 0])) as Record<(typeof runStatusNames)[number], number>;
  const totals = empty();
  const days = new Map<string, ReturnType<typeof empty>>();
  for (const row of rows) {
    const status = runStatus(row.state) as (typeof runStatusNames)[number];
    if (!(status in totals)) continue;
    const day = days.get(row.day) ?? empty();
    day[status] += row.count;
    totals[status] += row.count;
    days.set(row.day, day);
  }
  const total = runStatusNames.reduce((sum, name) => sum + totals[name], 0);
  return {
    object: "automation_run_metrics" as const,
    automation_id: automationId,
    total,
    totals,
    data: [...days.entries()].map(([date, counts]) => ({ date, ...counts })),
  };
}

export function presentStep(row: StepRow) {
  return {
    // A row written before steps had keys holds a 0-based index into the old linear list, and
    // the trigger now sits in front of that list.
    key: row.step_key ?? `step_${row.step_index + 1}`,
    type: row.type,
    status: stepStatuses[row.state] ?? row.state,
    started_at: row.started_at ?? row.created_at,
    completed_at: row.completed_at,
    output: row.data ?? {},
    error: row.error,
  };
}

export function presentRunDetail(row: RunRow, steps: StepRow[]) {
  const run = presentRun(row);
  return {
    ...run,
    event: { ...run.event, payload: row.event_data ?? {} },
    steps: steps.map(presentStep),
  };
}

type GraphInput = { trigger?: string; steps?: Array<Record<string, unknown>>; connections?: unknown[] };

// Applies a PATCH body's graph fields on top of the stored graph. Returns null when the body
// leaves the graph alone.
export function mergeGraph(current: AutomationRow, input: GraphInput) {
  if (!input.steps && !input.connections && !input.trigger) return null;
  if (input.steps) {
    const keyed = input.steps.every((step) => "key" in step);
    return automationGraphSchema.parse({
      trigger: input.trigger ?? current.trigger,
      steps: input.steps,
      connections: input.connections ?? (keyed ? automationGraph(current).connections : undefined),
    });
  }
  const graph = automationGraph(current);
  const steps = graph.steps.map((step) =>
    step.type === "trigger" && input.trigger ? { ...step, config: { ...step.config, event_name: input.trigger } } : step,
  );
  return automationGraphSchema.parse({ steps, connections: input.connections ?? graph.connections });
}

const runSelect = `r.id, r.automation_id, r.event_id, e.name as event_name, e.email, r.state, r.next_step_key,
  r.error, r.created_at, r.updated_at`;

export function registerAutomations(
  app: FastifyInstance,
  deps: { db: Db; paging: (request: FastifyRequest) => PagingParams },
) {
  const { db, paging } = deps;

  async function insert(
    tenantId: string,
    input: { name: string; enabled: boolean; trigger: string; steps: unknown[]; connections: unknown[] },
  ) {
    const row = await db.query<AutomationRow>(
      `insert into automations (id, tenant_id, name, trigger, steps, connections, enabled)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (tenant_id, name) where deleted_at is null do nothing
       returning ${automationColumns}`,
      [
        id("automation"),
        tenantId,
        input.name,
        input.trigger,
        JSON.stringify(input.steps),
        JSON.stringify(input.connections),
        input.enabled,
      ],
    );
    return row.rows[0] ?? null;
  }

  app.post("/automations", async (request) => {
    const input = automationSchema.parse(request.body);
    const row = await insert(request.auth!.tenant_id, input);
    if (!row) throw new ApiError("conflict", 409, `An automation named ${input.name} already exists`);
    return presentAutomation(row);
  });

  app.get("/automations", async (request) => {
    const status = (request.query as { status?: string }).status;
    if (status && status !== "enabled" && status !== "disabled") {
      throw new ApiError("validation_error", 422, "status must be enabled or disabled");
    }
    const page = await paginate<AutomationRow & { run_count: number }>(db, "automations", request.auth!.tenant_id, paging(request), {
      select: `${automationColumns}, (select count(*)::integer from automation_runs r
        where r.tenant_id = automations.tenant_id and r.automation_id = automations.id) as run_count`,
      deletedCol: "deleted_at",
      where: status ? "enabled = $2" : undefined,
      params: status ? [status === "enabled"] : undefined,
    });
    return { object: page.object, has_more: page.has_more, data: page.data.map(presentAutomationRow) };
  });

  app.get("/automations/:id", async (request) => {
    const automationId = (request.params as { id: string }).id;
    return presentAutomation(await findAutomation(db, request.auth!.tenant_id, automationId));
  });

  app.patch("/automations/:id", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const automationId = (request.params as { id: string }).id;
    const input = automationUpdateSchema.parse(request.body ?? {});
    // Read and write under one row lock. Two requests at once (an editor saving steps while
    // the user presses Start) would otherwise each write back what the other had just changed.
    const row = await tx(db, async (client) => {
      const locked = await client.query<AutomationRow>(
        `select ${automationColumns} from automations
         where tenant_id = $1 and id = $2 and deleted_at is null
         for update`,
        [tenantId, automationId],
      );
      const current = locked.rows[0];
      if (!current) throw new ApiError("not_found", 404, "Automation not found");
      const graph = mergeGraph(current, input);
      const enabled = input.enabled ?? current.enabled;
      if (graph && current.enabled && enabled) {
        throw new ApiError("conflict", 409, "Disable the automation before changing its steps");
      }
      const updated = await client.query<AutomationRow>(
        `update automations set name = $3, trigger = $4, steps = $5, connections = $6, enabled = $7, updated_at = now()
         where tenant_id = $1 and id = $2
         returning ${automationColumns}`,
        [
          tenantId,
          automationId,
          input.name ?? current.name,
          graph?.trigger ?? current.trigger,
          JSON.stringify(graph?.steps ?? current.steps),
          JSON.stringify(graph?.connections ?? current.connections ?? []),
          enabled,
        ],
      );
      // Disabling stops the runs in flight, as POST /stop does. A run left waiting would resume
      // against whatever steps the automation has by then.
      if (current.enabled && !enabled) await stopRuns(client, tenantId, automationId);
      return updated.rows[0]!;
    });
    return presentAutomation(row);
  });

  app.delete("/automations/:id", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const automation = await findAutomation(db, tenantId, (request.params as { id: string }).id);
    await tx(db, async (client) => {
      await softDelete(client, "automations", tenantId, automation.id);
      await stopRuns(client, tenantId, automation.id);
    });
    return { object: "automation", id: automation.id, deleted: true };
  });

  app.post("/automations/:id/duplicate", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const source = await findAutomation(db, tenantId, (request.params as { id: string }).id);
    const given = (request.body as { name?: unknown } | undefined)?.name;
    if (given !== undefined && (typeof given !== "string" || given.length < 1 || given.length > 120)) {
      throw new ApiError("validation_error", 400, "name must be 1 to 120 characters");
    }
    const name = given ?? `${source.name} (copy)`.slice(0, 120);
    const graph = automationGraph(source);
    const copy = { name, enabled: false, trigger: source.trigger, ...graph };
    const row =
      (await insert(tenantId, copy)) ?? (await insert(tenantId, { ...copy, name: `${name} ${id("copy").slice(-6)}` }));
    if (!row) throw new ApiError("conflict", 409, `An automation named ${name} already exists`);
    return presentAutomation(row);
  });

  app.post("/automations/:id/stop", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const automation = await findAutomation(db, tenantId, (request.params as { id: string }).id);
    const row = await tx(db, async (client) => {
      const updated = await client.query<AutomationRow>(
        `update automations set enabled = false, updated_at = now() where tenant_id = $1 and id = $2
         returning ${automationColumns}`,
        [tenantId, automation.id],
      );
      await stopRuns(client, tenantId, automation.id);
      return updated.rows[0]!;
    });
    return presentAutomation(row);
  });

  app.get("/automations/:id/runs", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const automation = await findAutomation(db, tenantId, (request.params as { id: string }).id);
    const query = request.query as { status?: string } & RunQuery;
    const states = runStates(query.status);
    const filters = runWhere(states, query);
    const page = await paginate<RunRow>(
      db,
      "automation_runs r join custom_events e on e.id = r.event_id",
      tenantId,
      paging(request),
      {
        tenantCol: "r.tenant_id",
        createdCol: "r.created_at",
        idCol: "r.id",
        where: filters.where,
        params: states ? [automation.id, states, ...filters.params] : [automation.id, ...filters.params],
        select: runSelect,
      },
    );
    return { object: page.object, has_more: page.has_more, data: page.data.map(presentRun) };
  });

  // Run counts by status, in total and per day, for the builder's Metrics tab.
  app.get("/automations/:id/runs/metrics", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const automation = await findAutomation(db, tenantId, (request.params as { id: string }).id);
    const filters = runWhere(null, request.query as RunQuery);
    const rows = await db.query<{ day: string; state: string; count: number }>(
      `select to_char(date_trunc('day', r.created_at at time zone 'UTC'), 'YYYY-MM-DD') as day, r.state, count(*)::integer as count
       from automation_runs r
       where r.tenant_id = $1 and ${filters.where}
       group by 1, 2
       order by 1`,
      [tenantId, automation.id, ...filters.params],
    );
    return presentRunMetrics(automation.id, rows.rows);
  });

  app.get("/automations/:id/runs/:run_id", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const params = request.params as { id: string; run_id: string };
    const run = await db.query<RunRow>(
      `select ${runSelect}, e.data as event_data
       from automation_runs r
       join custom_events e on e.id = r.event_id
       where r.tenant_id = $1 and r.automation_id = $2 and r.id = $3`,
      [tenantId, params.id, params.run_id],
    );
    if (!run.rows[0]) throw new ApiError("not_found", 404, "Automation run not found");
    const steps = await db.query<StepRow>(
      `select id, step_key, step_index, type, state, data, error, started_at, completed_at, created_at
       from automation_steps
       where tenant_id = $1 and run_id = $2
       order by created_at, id`,
      [tenantId, params.run_id],
    );
    return presentRunDetail(run.rows[0], steps.rows);
  });
}

async function stopRuns(client: { query: Db["query"] }, tenantId: string, automationId: string) {
  await client.query(
    `update automation_runs
     set state = 'stopped', resume_at = null, wait_event = null, updated_at = now()
     where tenant_id = $1 and automation_id = $2 and state = any($3)
     returning id`,
    [tenantId, automationId, activeStates],
  ).then(async (stopped) => {
    const runIds = stopped.rows.map((row) => (row as { id: string }).id);
    if (runIds.length === 0) return;
    // The step a stopped run was waiting on is closed too, or the run view shows it in progress forever.
    await client.query(
      `update automation_steps set state = 'failed', error = 'cancelled', completed_at = now()
       where tenant_id = $1 and run_id = any($2) and state = 'waiting'`,
      [tenantId, runIds],
    );
  });
}
