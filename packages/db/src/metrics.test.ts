import { ApiError } from "@dispatchmail/core";
import { describe, expect, it, vi } from "vitest";
import { emailMetrics, parseMetricsQuery, withRates } from "./metrics.js";

const now = new Date("2026-07-08T00:00:00.000Z");

function dbReturning(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows }));
  return { query, rows };
}

describe("email metrics", () => {
  it("groups automation emails by step only with an automation filter", async () => {
    expect(() => parseMetricsQuery({ dimensions: "step" }, now)).toThrow("automation_id");
    const db = dbReturning([{ automation_id: "automation_1", automation_step: "welcome", sent: 2, delivered: 2, unique_opened: 1 }]);
    const report = await emailMetrics(db, "tenant_1", parseMetricsQuery({
      dimensions: ["automation", "step"], automation_id: ["automation_1"], metrics: ["sent", "open_rate"],
    }, now));
    expect(db.query.mock.calls[0]![0]).toContain("group by e.automation_id, e.automation_step");
    expect(db.query.mock.calls[0]![0]).toContain("e.automation_id = any(");
    expect(db.query.mock.calls[0]![1]).toContainEqual(["automation_1"]);
    expect(report.data).toEqual([{ automation_id: "automation_1", automation_step: "welcome", sent: 2, open_rate: 50 }]);
    expect(() => parseMetricsQuery({ automation_id: Array.from({ length: 101 }, (_, i) => `automation_${i}`) }, now)).toThrow("100");
  });

  it("defaults to the last 7 days and refuses a combined email and broadcast breakdown", () => {
    const parsed = parseMetricsQuery({}, now);
    expect(parsed.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(parsed.end.toISOString()).toBe("2026-07-08T00:00:00.000Z");
    expect(parsed.granularity).toBe("daily");
    expect(parsed.timezone).toBe("UTC");
    expect(parsed.dimensions).toEqual([]);
    expect(parsed.metrics).toContain("open_rate");
    expect(() => parseMetricsQuery({ dimensions: ["email", "broadcast"] }, now)).toThrow(ApiError);
    expect(() => parseMetricsQuery({ timezone: "UTC; drop table logs" }, now)).toThrow(/IANA/);
    // Browsers report the current spelling, which Intl.supportedValuesOf leaves out.
    for (const zone of ["Asia/Kolkata", "Europe/Kyiv", "Etc/UTC", "America/Nuuk", "Asia/Calcutta"]) {
      expect(parseMetricsQuery({ timezone: zone }, now).timezone).toBe(zone);
    }
    // A bare offset means the opposite direction in Postgres, so it is refused.
    expect(() => parseMetricsQuery({ timezone: "+05:30" }, now)).toThrow(/IANA/);
    expect(() => parseMetricsQuery({ timezone: "Mars/Olympus" }, now)).toThrow(/IANA/);
    expect(() => parseMetricsQuery({ metrics: ["sent", "not_a_metric"] }, now)).toThrow(/unknown value/);
  });

  it("computes rates from the counts and takes the totals from an ungrouped query", async () => {
    expect(withRates({
      received: 0,
      sent: 0,
      delivered: 0,
      delivery_delayed: 0,
      failed: 0,
      suppressed: 0,
      bounced: 0,
      bounced_transient: 0,
      bounced_permanent: 0,
      bounced_undetermined: 0,
      opened: 0,
      unique_opened: 0,
      clicked: 0,
      unique_clicked: 0,
      complained: 0,
      unsubscribed: 0,
    }).delivery_rate).toBe(0);

    const db = dbReturning([
      { period: "2026-07-01", domain_id: "domain_1", domain_name: "example.com", sent: 1, delivered: 1, unique_opened: 1, unique_clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 },
      { period: "2026-07-02", domain_id: "domain_1", domain_name: "example.com", sent: 3, delivered: 3, unique_opened: 1, unique_clicked: 1, bounced: 1, complained: 1, unsubscribed: 1 },
    ]);
    // The same email was opened on both days: two unique opens by day, one overall.
    db.query.mockResolvedValueOnce({ rows: db.rows }).mockResolvedValueOnce({
      rows: [{ sent: 4, delivered: 4, unique_opened: 1, unique_clicked: 1, bounced: 1, complained: 1, unsubscribed: 1 }],
    });
    const report = await emailMetrics(db, "tenant_1", parseMetricsQuery({
      start_date: "2026-07-01T00:00:00.000Z",
      end_date: "2026-07-08T00:00:00.000Z",
      timezone: "America/New_York",
      granularity: "daily",
      metrics: ["sent", "open_rate", "unsubscribe_rate"],
      dimensions: ["period", "domain"],
      domain_id: ["domain_1"],
    }, now));

    const sql = String(db.query.mock.calls[0][0]);
    const params = db.query.mock.calls[0][1] as unknown[];
    expect(sql).toContain("date_trunc(");
    expect(sql).toContain("count(*) filter (where ev.type = 'email.sent')");
    expect(sql).toContain("d.id as domain_id");
    expect(sql).not.toContain("America/New_York");
    expect(params).toContain("America/New_York");
    expect(params).toContain("day");
    expect(params).toContainEqual(["domain_1"]);
    expect(report.totals).toEqual({ sent: 4, open_rate: 25, unsubscribe_rate: 25 });
    expect(report.data[0]).toEqual({
      period: "2026-07-01",
      domain_id: "domain_1",
      domain_name: "example.com",
      sent: 1,
      open_rate: 100,
      unsubscribe_rate: 0,
    });
    expect(report.data[1]).toMatchObject({ open_rate: 33.33, unsubscribe_rate: 33.33 });
    expect(report.object).toBe("metrics");
    const totalSql = String(db.query.mock.calls[1][0]);
    expect(totalSql).not.toContain("group by");
    expect(totalSql).not.toContain("date_trunc(");
    expect(db.query.mock.calls[1][1]).not.toContain("America/New_York");
  });

  it("returns one total and no series when no dimension is asked for", async () => {
    const db = dbReturning([{ sent: 10, delivered: 8, unique_opened: 4, unique_clicked: 2, bounced: 1, complained: 1 }]);
    const report = await emailMetrics(db, "tenant_1", parseMetricsQuery({
      metrics: ["sent", "delivery_rate", "open_rate", "click_rate", "bounce_rate", "complaint_rate"],
    }, now));
    const sql = String(db.query.mock.calls[0][0]);
    expect(sql).not.toContain("group by");
    expect(report.data).toEqual([]);
    expect(report.totals).toEqual({
      sent: 10,
      delivery_rate: 80,
      open_rate: 50,
      click_rate: 25,
      bounce_rate: 10,
      complaint_rate: 12.5,
    });
  });
});
