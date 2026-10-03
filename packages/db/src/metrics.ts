import { ApiError } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { realEmailEvent } from "./sandbox.js";

export const countMetrics = [
  "received",
  "sent",
  "delivered",
  "delivery_delayed",
  "failed",
  "suppressed",
  "bounced",
  "bounced_transient",
  "bounced_permanent",
  "bounced_undetermined",
  "opened",
  "unique_opened",
  "clicked",
  "unique_clicked",
  "complained",
  "unsubscribed",
] as const;

export const rateMetrics = [
  "delivery_rate",
  "open_rate",
  "click_rate",
  "bounce_rate",
  "complaint_rate",
  "unsubscribe_rate",
] as const;

export const metricNames = [...countMetrics, ...rateMetrics] as const;
export const dimensionNames = ["period", "domain", "email", "broadcast", "automation", "step"] as const;

const units = { hourly: "hour", daily: "day", weekly: "week", monthly: "month" } as const;
const periodFormats = {
  hourly: 'YYYY-MM-DD"T"HH24:00:00',
  daily: "YYYY-MM-DD",
  weekly: "YYYY-MM-DD",
  monthly: "YYYY-MM",
} as const;

export type MetricName = (typeof metricNames)[number];
export type CountMetric = (typeof countMetrics)[number];
export type DimensionName = (typeof dimensionNames)[number];
export type Granularity = keyof typeof units;

export type MetricsInput = {
  start: Date;
  end: Date;
  timezone: string;
  granularity: Granularity;
  metrics: MetricName[];
  dimensions: DimensionName[];
  domainIds: string[];
  emailIds: string[];
  broadcastIds: string[];
  automationIds: string[];
};

type Counts = Record<CountMetric, number>;

const countSql = `
  count(*) filter (where ev.type = 'email.received')::int as received,
  count(*) filter (where ev.type = 'email.sent')::int as sent,
  count(*) filter (where ev.type = 'email.delivered')::int as delivered,
  count(*) filter (where ev.type = 'email.delivery_delayed')::int as delivery_delayed,
  count(*) filter (where ev.type = 'email.failed')::int as failed,
  count(*) filter (where ev.type = 'email.suppressed')::int as suppressed,
  count(*) filter (where ev.type = 'email.bounced')::int as bounced,
  count(*) filter (where ev.type = 'email.bounced' and ev.data->'bounce'->>'type' = 'Transient')::int as bounced_transient,
  count(*) filter (where ev.type = 'email.bounced' and ev.data->'bounce'->>'type' = 'Permanent')::int as bounced_permanent,
  count(*) filter (where ev.type = 'email.bounced' and ev.data->'bounce'->>'type' = 'Undetermined')::int as bounced_undetermined,
  count(*) filter (where ev.type = 'email.opened')::int as opened,
  count(distinct ev.email_id) filter (where ev.type = 'email.opened')::int as unique_opened,
  count(*) filter (where ev.type = 'email.clicked')::int as clicked,
  count(distinct ev.email_id) filter (where ev.type = 'email.clicked')::int as unique_clicked,
  count(*) filter (where ev.type = 'email.complained')::int as complained,
  count(*) filter (where ev.type = 'email.unsubscribed')::int as unsubscribed
`;

export function parseMetricsQuery(query: Record<string, unknown>, now = new Date()): MetricsInput {
  const end = query.end_date ? parseDate(query.end_date, "end_date") : now;
  const start = query.start_date
    ? parseDate(query.start_date, "start_date")
    : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (start >= end) throw new ApiError("validation_error", 422, "start_date must be before end_date");
  const granularity = parseEnum(query.granularity, units, "daily", "granularity");
  const timezone = typeof query.timezone === "string" && query.timezone ? query.timezone : "UTC";
  const input: MetricsInput = {
    start,
    end,
    timezone,
    granularity,
    metrics: chosen(listed(query, "metrics"), metricNames, "metrics"),
    dimensions: parseNames(listed(query, "dimensions"), dimensionNames, "dimensions"),
    domainIds: listed(query, "domain_id"),
    emailIds: listed(query, "email_id"),
    broadcastIds: listed(query, "broadcast_id"),
    automationIds: listed(query, "automation_id"),
  };
  validateMetrics(input);
  return input;
}

export function validateMetrics(input: MetricsInput) {
  if (!knownZone(input.timezone)) {
    throw new ApiError("validation_error", 422, "timezone must be an IANA name");
  }
  if (input.dimensions.includes("email") && input.dimensions.includes("broadcast")) {
    throw new ApiError("validation_error", 422, "email and broadcast cannot be combined");
  }
  if (input.dimensions.includes("step") && input.automationIds.length === 0) {
    throw new ApiError("validation_error", 422, "step requires an automation_id filter");
  }
  for (const [name, values] of [
    ["domain_id", input.domainIds],
    ["email_id", input.emailIds],
    ["broadcast_id", input.broadcastIds],
    ["automation_id", input.automationIds],
  ] as const) {
    if (values.length > 100) throw new ApiError("validation_error", 422, `${name} accepts at most 100 values`);
  }
}

export async function emailMetrics(db: Queryable, tenantId: string, input: MetricsInput) {
  validateMetrics(input);
  const params: unknown[] = [tenantId];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const start = bind(input.start);
  const end = bind(input.end);
  const where = [
    "ev.tenant_id = $1",
    `ev.created_at >= ${start}`,
    `ev.created_at < ${end}`,
    realEmailEvent(),
  ];
  if (input.domainIds.length > 0) where.push(`d.id = any(${bind(input.domainIds)}::text[])`);
  if (input.emailIds.length > 0) where.push(`ev.email_id = any(${bind(input.emailIds)}::text[])`);
  if (input.broadcastIds.length > 0) where.push(`e.broadcast_id = any(${bind(input.broadcastIds)}::text[])`);
  if (input.automationIds.length > 0) where.push(`e.automation_id = any(${bind(input.automationIds)}::text[])`);

  // The dimension binds below belong to the grouped query only.
  const whereParams = [...params];
  const select: string[] = [];
  const group: string[] = [];
  if (input.dimensions.includes("period")) {
    const unit = bind(units[input.granularity]);
    const zone = bind(input.timezone);
    const format = bind(periodFormats[input.granularity]);
    const truncated = `date_trunc(${unit}, ev.created_at at time zone ${zone})`;
    select.push(`to_char(${truncated}, ${format}) as period`);
    group.push(truncated);
  }
  if (input.dimensions.includes("domain")) {
    select.push("d.id as domain_id", "d.name as domain_name");
    group.push("d.id", "d.name");
  }
  if (input.dimensions.includes("email")) {
    select.push("ev.email_id as email_id");
    group.push("ev.email_id");
  }
  if (input.dimensions.includes("broadcast")) {
    select.push("e.broadcast_id as broadcast_id");
    group.push("e.broadcast_id");
  }
  if (input.dimensions.includes("automation") || input.dimensions.includes("step")) {
    select.push("e.automation_id as automation_id");
    group.push("e.automation_id");
  }
  if (input.dimensions.includes("step")) {
    select.push("e.automation_step as automation_step");
    group.push("e.automation_step");
  }
  select.push(countSql);
  const grouped = group.length > 0 ? ` group by ${group.join(", ")}` : "";
  const ordered = input.dimensions.includes("period") ? " order by period" : "";
  const from = `from email_events ev
    left join emails e on e.id = ev.email_id and e.tenant_id = ev.tenant_id
    left join domains d on d.tenant_id = ev.tenant_id and d.deleted_at is null and lower(d.name) = lower(split_part(e.from_email, '@', 2))
    where ${where.join(" and ")}`;
  const result = await db.query(`select ${select.join(", ")}\n    ${from}${grouped}${ordered}`, params);
  const raw = result.rows as Array<Record<string, unknown>>;
  const counted = raw.map(countsFrom);
  // Unique opens and clicks do not add up across groups: an email opened on two days is one
  // unique open. The totals come from the same filter with no grouping.
  const overall = input.dimensions.length === 0
    ? counted[0] ?? zeroCounts()
    : countsFrom((await db.query(`select ${countSql}\n    ${from}`, whereParams)).rows[0] ?? {});
  const totals = withRates(overall);
  const data = input.dimensions.length === 0
    ? []
    : raw.map((row, index) => ({
        ...dimensionFields(row, input.dimensions),
        ...pick(withRates(counted[index] ?? zeroCounts()), input.metrics),
      }));
  return {
    object: "metrics" as const,
    start_date: input.start.toISOString(),
    end_date: input.end.toISOString(),
    metrics: input.metrics,
    dimensions: input.dimensions,
    granularity: input.granularity,
    totals: pick(totals, input.metrics),
    data,
  };
}

export function withRates(row: Counts) {
  // Two decimals: the complaint threshold is 0.08%, which one decimal would round to 0.1 or 0.0.
  const rate = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 10000) / 100);
  return {
    ...row,
    delivery_rate: rate(row.delivered, row.sent),
    open_rate: rate(row.unique_opened, row.delivered),
    click_rate: rate(row.unique_clicked, row.delivered),
    bounce_rate: rate(row.bounced, row.sent),
    complaint_rate: rate(row.complained, row.delivered),
    unsubscribe_rate: rate(row.unsubscribed, row.delivered),
  };
}

function countsFrom(row: Record<string, unknown>): Counts {
  const counts = zeroCounts();
  for (const name of countMetrics) counts[name] = Number(row[name] ?? 0);
  return counts;
}

function zeroCounts(): Counts {
  return Object.fromEntries(countMetrics.map((name) => [name, 0])) as Counts;
}

function sumCounts(rows: Counts[]): Counts {
  const total = zeroCounts();
  for (const row of rows) {
    for (const name of countMetrics) total[name] += row[name];
  }
  return total;
}

function pick(row: Record<string, number>, metrics: MetricName[]) {
  const out: Record<string, number> = {};
  for (const name of metrics) out[name] = row[name] ?? 0;
  return out;
}

function dimensionFields(row: Record<string, unknown>, dimensions: DimensionName[]) {
  const out: Record<string, unknown> = {};
  if (dimensions.includes("period")) out.period = row.period ?? null;
  if (dimensions.includes("domain")) {
    out.domain_id = row.domain_id ?? null;
    out.domain_name = row.domain_name ?? null;
  }
  if (dimensions.includes("email")) out.email_id = row.email_id ?? null;
  if (dimensions.includes("broadcast")) out.broadcast_id = row.broadcast_id ?? null;
  if (dimensions.includes("automation") || dimensions.includes("step")) out.automation_id = row.automation_id ?? null;
  if (dimensions.includes("step")) out.automation_step = row.automation_step ?? null;
  return out;
}

function listed(query: Record<string, unknown>, name: string) {
  const value = query[name] ?? query[`${name}[]`];
  if (value == null || value === "") return [];
  const items = Array.isArray(value) ? value.flat() : String(value).split(",");
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function chosen<T extends string>(values: string[], allowed: readonly T[], name: string): T[] {
  const parsed = parseNames(values, allowed, name);
  return parsed.length > 0 ? parsed : [...allowed];
}

function parseNames<T extends string>(values: string[], allowed: readonly T[], name: string): T[] {
  const known = new Set<string>(allowed);
  for (const value of values) {
    if (!known.has(value)) throw new ApiError("validation_error", 422, `${name} has an unknown value: ${value}`);
  }
  return values as T[];
}

function parseEnum<T extends string>(value: unknown, allowed: Record<T, string>, fallback: T, name: string): T {
  if (value == null || value === "") return fallback;
  if (typeof value === "string" && value in allowed) return value as T;
  throw new ApiError("validation_error", 422, `${name} is invalid`);
}

function parseDate(value: unknown, name: string) {
  if (typeof value !== "string") throw new ApiError("validation_error", 422, `${name} must be a date`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError("validation_error", 422, `${name} must be a date`);
  return date;
}

// Intl.supportedValuesOf lists one spelling per zone, and it is often the older one, so browsers
// that report Asia/Kolkata or Europe/Kyiv were refused. The formatter accepts every spelling.
// It also accepts bare offsets such as "+05:30", which Postgres reads with the sign reversed,
// so only names are let through.
function knownZone(value: string) {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
