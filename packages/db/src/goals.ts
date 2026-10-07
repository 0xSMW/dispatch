import {
  ApiError, goalSchema, goalUpdateSchema, goalMetricsSchema, goalHistoryLimit, id,
  propertyTypes, type PropertyType, type Goal, type GoalInput, type GoalUpdate, type GoalQuery, type GoalMetrics,
} from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { propertyDefinitions } from "./audience.js";
import { assertGoalReferences, goalPredicate, goalStatePredicate, type SegmentProperty } from "./segments.js";
import { assertGoalHistoryFields, goalState } from "./goal-history.js";
import { realEmailEvent } from "./sandbox.js";

type GoalRow = Omit<Goal, "object" | "created_at" | "updated_at"> & {
  tenant_id: string; created_at: string | Date; updated_at: string | Date;
  deleted_at: string | Date | null;
};

export const goalColumns = "id, tenant_id, name, target, eligibility, window_days, created_at, updated_at, deleted_at";

export function presentGoal(row: GoalRow): Goal {
  return {
    object: "goal", id: row.id, name: row.name, target: row.target,
    eligibility: row.eligibility, window_days: row.window_days,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function invalid(message: string): never {
  throw new ApiError("validation_error", 400, message);
}
async function goalProperties(db: Queryable, tenantId: string): Promise<SegmentProperty[]> {
  return (await propertyDefinitions(db, tenantId)).map((property) => {
    if (!(propertyTypes as readonly string[]).includes(property.type)) invalid("Invalid contact property type");
    return { key: property.key, type: property.type as PropertyType };
  });
}

function parseGoal(input: unknown) {
  const parsed = goalSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "Invalid goal");
  return parsed.data;
}

function validateGoal(data: ReturnType<typeof parseGoal>, properties: readonly SegmentProperty[]) {
  if ("rule" in data.target) {
    if (!assertGoalHistoryFields(data.target.rule))
      invalid("Goal rule targets cannot use topic or segment membership: historical removals are incomplete");
    goalPredicate(data.target.rule, () => "$1", properties);
  }
  if (data.eligibility) goalPredicate(data.eligibility, () => "$1", properties);
}

export async function getGoal(db: Queryable, tenantId: string, goalId: string): Promise<GoalRow> {
  const result = await db.query<GoalRow>(
    `select ${goalColumns} from goals where tenant_id = $1 and id = $2 and deleted_at is null`,
    [tenantId, goalId],
  );
  if (!result.rows[0]) throw new ApiError("not_found", 404, "Goal not found");
  return result.rows[0];
}

export async function createGoal(db: Queryable, tenantId: string, input: GoalInput): Promise<GoalRow> {
  const data = parseGoal(input);
  validateGoal(data, await goalProperties(db, tenantId));
  if (data.eligibility) await assertGoalReferences(db, tenantId, data.eligibility);
  const result = await db.query<GoalRow>(
    `insert into goals (id, tenant_id, name, target, eligibility, window_days)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6) returning ${goalColumns}`,
    [id("goal"), tenantId, data.name, JSON.stringify(data.target),
      data.eligibility ? JSON.stringify(data.eligibility) : null, data.window_days],
  );
  return result.rows[0]!;
}

export async function updateGoal(db: Queryable, tenantId: string, goalId: string, input: GoalUpdate): Promise<GoalRow> {
  const parsed = goalUpdateSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "Invalid goal update");
  const current = await getGoal(db, tenantId, goalId);
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
  const data = parseGoal({
    name: current.name, target: current.target, eligibility: current.eligibility,
    window_days: current.window_days, ...patch,
  });
  validateGoal(data, await goalProperties(db, tenantId));
  if (data.eligibility) await assertGoalReferences(db, tenantId, data.eligibility);
  const params: unknown[] = [tenantId, goalId];
  const assignments = Object.keys(patch).map((key) => {
    const value = data[key as keyof typeof data];
    const json = key === "target" || key === "eligibility";
    params.push(json && value != null ? JSON.stringify(value) : value);
    return `${key} = $${params.length}${json ? "::jsonb" : ""}`;
  });
  const result = await db.query<GoalRow>(
    `update goals set ${[...assignments, "updated_at = clock_timestamp()"].join(", ")}
     where tenant_id = $1 and id = $2 and deleted_at is null returning ${goalColumns}`,
    params,
  );
  if (!result.rows[0]) throw new ApiError("not_found", 404, "Goal not found");
  return result.rows[0];
}

export async function deleteGoal(db: Queryable, tenantId: string, goalId: string): Promise<boolean> {
  const result = await db.query(
    `update goals set deleted_at = clock_timestamp(), updated_at = clock_timestamp()
     where tenant_id = $1 and id = $2 and deleted_at is null returning id`,
    [tenantId, goalId],
  );
  return Boolean(result.rows[0]);
}

async function validateScope(db: Queryable, tenantId: string, query: GoalQuery) {
  if (query.automation_id) {
    const result = await db.query<{ steps: Array<{ key?: string }> }>(
      "select steps from automations where tenant_id = $1 and id = $2 and deleted_at is null",
      [tenantId, query.automation_id],
    );
    if (!result.rows[0]) throw new ApiError("not_found", 404, "Automation not found");
    // Step keys filter stored attribution, including steps removed from today's
    // graph. Unknown historical keys simply produce an empty cohort.
  } else if (query.broadcast_id) {
    const result = await db.query(
      "select id from broadcasts where tenant_id = $1 and id = $2 and deleted_at is null",
      [tenantId, query.broadcast_id],
    );
    if (!result.rows[0]) throw new ApiError("not_found", 404, "Broadcast not found");
  }
}

type MetricsRow = {
  start_date: string | Date; end_date: string | Date; valid_range: boolean;
  available_from: string | Date | null;
  data: Array<{ date: string; contacts_reached: number | string; converted: number | string }>;
};

export async function goalMetrics(
  db: Queryable, tenantId: string, goalId: string, input: GoalQuery,
): Promise<GoalMetrics> {
  const parsed = goalMetricsSchema.safeParse(input);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? "Invalid goal metrics query");
  const query = parsed.data;
  const goal = await getGoal(db, tenantId, goalId);
  const data = parseGoal({
    name: goal.name, target: goal.target, eligibility: goal.eligibility, window_days: goal.window_days,
  });
  const properties = await goalProperties(db, tenantId);
  validateGoal(data, properties);
  if (data.eligibility) await assertGoalReferences(db, tenantId, data.eligibility);
  await validateScope(db, tenantId, query);
  const params: unknown[] = [tenantId];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const end = bind(query.end_date ?? null);
  const start = bind(query.start_date ?? null);
  const window = bind(data.window_days);
  const scope = [
    "ev.tenant_id = $1", "ev.type = 'email.sent'", realEmailEvent("ev", "e"),
    "ev.created_at <= b.measured_at",
  ];
  if (query.automation_id) scope.push(`e.automation_id = ${bind(query.automation_id)}`);
  if (query.broadcast_id) scope.push(`e.broadcast_id = ${bind(query.broadcast_id)}`);
  if (query.step_key) scope.push(`e.automation_step = ${bind(query.step_key)}`);
  const eligibility = data.eligibility ? goalPredicate(data.eligibility, bind, properties) : "true";
  let conversion: string;
  if ("event" in data.target) {
    conversion = `exists (
      select 1 from custom_events ce
      where ce.tenant_id = c.tenant_id and lower(ce.email) = lower(c.email)
        and ce.deleted_at is null and ce.name = ${bind(data.target.event)}
        and ce.created_at >= c.first_send and ce.created_at <= c.window_end
    )`;
  } else {
    const before = goalStatePredicate(data.target.rule, bind, properties, goalState("before"), "h.created_at");
    const after = goalStatePredicate(data.target.rule, bind, properties, goalState("after"), "h.created_at");
    conversion = `exists (
      select 1 from (
        select ch.tenant_id, ch.contact_id, ch.created_at, ch.request_id
        from contact_changes ch
        where ch.tenant_id = c.tenant_id and ch.contact_id = c.id
          and ch.created_at >= c.first_send and ch.created_at <= c.window_end
        group by ch.tenant_id, ch.contact_id, ch.created_at, ch.request_id
      ) h
      where not (${before}) and (${after})
    )`;
  }
  // Only cohort contacts reach the conversion subqueries. First-send selection is
  // deliberately across all retained real sends, BEFORE the requested date filter.
  const result = await db.query<MetricsRow>(
    `with instant as materialized (
      select statement_timestamp() as measured_at
    ), ending as (
      select measured_at, coalesce(${end}::timestamptz, measured_at) as end_date from instant
    ), bounds as materialized (
      select measured_at, end_date, coalesce(${start}::timestamptz, end_date - interval '720 hours') as start_date
      from ending
    ), first_sends as materialized (
      select c.id as contact_id, min(ev.created_at) as first_send
      from email_events ev
      join emails e on e.tenant_id = ev.tenant_id and e.id = ev.email_id
      join contacts c on c.tenant_id = e.tenant_id and c.id = e.contact_id and c.deleted_at is null
      cross join bounds b
      where ${scope.join(" and ")}
      group by c.id
    ), cohort as materialized (
      select c.*, f.first_send,
        least(f.first_send + ${window}::integer * interval '24 hours', b.measured_at) as window_end
      from first_sends f
      join contacts c on c.tenant_id = $1 and c.id = f.contact_id and c.deleted_at is null
      cross join bounds b
      where f.first_send >= b.start_date and f.first_send < b.end_date and (${eligibility})
    ), outcomes as materialized (
      select (c.first_send at time zone 'UTC')::date as date, (${conversion}) as converted from cohort c
    ), daily as (
      select date, count(*) as contacts_reached, count(*) filter (where converted) as converted
      from outcomes group by date
    ), days as (
      select day::date as date
      from bounds b cross join lateral generate_series(
        date_trunc('day', b.start_date at time zone 'UTC'),
        date_trunc('day', b.end_date at time zone 'UTC'), interval '1 day'
      ) day
      where b.start_date < b.end_date and day < b.end_date at time zone 'UTC'
    )
    select b.start_date, b.end_date, b.start_date < b.end_date as valid_range,
      (select min(created_at) from contact_changes where tenant_id = $1) as available_from,
      coalesce((select jsonb_agg(jsonb_build_object(
        'date', to_char(days.date, 'YYYY-MM-DD'),
        'contacts_reached', coalesce(daily.contacts_reached, 0),
        'converted', coalesce(daily.converted, 0)
      ) order by days.date) from days left join daily using (date)), '[]'::jsonb) as data
    from bounds b`,
    params,
  );
  const row = result.rows[0]!;
  if (!row.valid_range) invalid("start_date must precede end_date");
  const daily = row.data.map((day) => {
    const reached = Number(day.contacts_reached);
    const converted = Number(day.converted);
    return { date: day.date, contacts_reached: reached, converted, rate: reached ? converted / reached : 0 };
  });
  const reached = daily.reduce((sum, day) => sum + day.contacts_reached, 0);
  const converted = daily.reduce((sum, day) => sum + day.converted, 0);
  return {
    object: "goal_metrics", goal_id: goalId,
    start_date: new Date(row.start_date).toISOString(), end_date: new Date(row.end_date).toISOString(),
    contacts_reached: reached, converted, rate: reached ? converted / reached : 0, data: daily,
    history: {
      available_from: row.available_from == null ? null : new Date(row.available_from).toISOString(),
      limitation: goalHistoryLimit,
    },
  };
}
