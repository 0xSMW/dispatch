import { ApiError } from "@dispatchmail/core";
import type { Queryable } from "@dispatchmail/db";
import type { FastifyInstance } from "fastify";

export function usageMonth(value: unknown, now = new Date()) {
  const month = value ?? now.toISOString().slice(0, 7);
  if (typeof month !== "string" || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new ApiError("validation_error", 400, "Use a calendar month in YYYY-MM format");
  }
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { month, start: start.toISOString(), end: end.toISOString() };
}

type Day = { date: string; recipients: number | string; ses_recipients: number | string; unmeasured_sends: number | string; api_requests: number | string };

export function presentUsage(month: string, start: string, end: string, rows: Day[]) {
  const byDay = new Map(rows.map((row) => [row.date, row]));
  const days: Array<{ date: string; recipients: number; ses_recipients: number; unmeasured_sends: number; api_requests: number }> = [];
  for (const day = new Date(start); day < new Date(end); day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    const row = byDay.get(date);
    days.push({ date, recipients: Number(row?.recipients ?? 0), ses_recipients: Number(row?.ses_recipients ?? 0),
      unmeasured_sends: Number(row?.unmeasured_sends ?? 0), api_requests: Number(row?.api_requests ?? 0) });
  }
  const total = (key: "recipients" | "ses_recipients" | "unmeasured_sends" | "api_requests") => days.reduce((sum, day) => sum + day[key], 0);
  return { object: "usage_summary", month, timezone: "UTC", start, end,
    recipients: total("recipients"), ses_recipients: total("ses_recipients"), unmeasured_sends: total("unmeasured_sends"), api_requests: total("api_requests"),
    ses_estimate_usd: total("ses_recipients") * 0.10 / 1000, ses_rate_per_1000_usd: 0.10, days };
}

export function registerUsage(app: FastifyInstance, { db, flushTelemetry }: { db: Queryable; flushTelemetry: () => Promise<void> }) {
  app.get("/usage/summary", async (request) => {
    const { month, start, end } = usageMonth((request.query as { month?: string }).month);
    await flushTelemetry();
    const result = await db.query<Day>(
      `with sends as (
        -- One provider acceptance per email. Worker and SES notifications already share a
        -- provider_event_id; choosing the first also protects imported duplicate records.
        select distinct on (ev.email_id) ev.email_id, ev.created_at, ev.data,
          exists (select 1 from provider_events_raw raw where raw.tenant_id = ev.tenant_id and raw.event_id = ev.id and raw.provider = 'ses') as ses
        from email_events ev join emails e on e.tenant_id = ev.tenant_id and e.id = ev.email_id
        where ev.tenant_id = $1 and ev.type = 'email.sent' and ev.email_id is not null
          and ev.provider_event_id is not null and ev.created_at < $3::timestamptz
          and (case when ev.data->>'sandbox' in ('true', 'false') then ev.data->>'sandbox' = 'false' else not e.sandbox end)
          and coalesce(ev.data->>'test', 'false') <> 'true'
        order by ev.email_id, ev.created_at, ev.id
      ), sent_days as (
        select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as date,
          sum(case when jsonb_typeof(data->'recipients') = 'array' then jsonb_array_length(data->'recipients') else 0 end)::bigint as recipients,
          sum(case when ses and jsonb_typeof(data->'recipients') = 'array' then jsonb_array_length(data->'recipients') else 0 end)::bigint as ses_recipients,
          count(*) filter (where jsonb_typeof(data->'recipients') is distinct from 'array')::bigint as unmeasured_sends
        from sends where created_at >= $2::timestamptz group by 1
      ), requests as (
        select period as date, sum(value)::bigint as api_requests from usage_counters
        where tenant_id = $1 and name = 'api_requests' and period >= $4 and period < $5 group by period
      )
      select coalesce(s.date, r.date) as date, coalesce(s.recipients, 0) as recipients,
        coalesce(s.ses_recipients, 0) as ses_recipients, coalesce(s.unmeasured_sends, 0) as unmeasured_sends,
        coalesce(r.api_requests, 0) as api_requests from sent_days s full join requests r on r.date = s.date order by 1`,
      [request.auth!.tenant_id, start, end, start.slice(0, 10), end.slice(0, 10)],
    );
    return presentUsage(month, start, end, result.rows);
  });
}
