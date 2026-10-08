import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@dispatchmail/db";
import { presentUsage, registerUsage, usageMonth } from "./usage.js";

describe("monthly usage", () => {
  it("uses UTC month boundaries, including leap years and December rollover", () => {
    expect(usageMonth("2024-02")).toEqual({ month: "2024-02", start: "2024-02-01T00:00:00.000Z", end: "2024-03-01T00:00:00.000Z" });
    expect(usageMonth("2026-12").end).toBe("2027-01-01T00:00:00.000Z");
    expect(usageMonth(undefined, new Date("2026-09-30T23:59:59Z")).month).toBe("2026-09");
    for (const value of ["2026-13", "2026-00", "2026-2", "2026-02-01", ["2026-02"], "bad"]) expect(() => usageMonth(value)).toThrow();
  });

  it("fills missing days and estimates only SES recipient destinations, without cent rounding", () => {
    const period = usageMonth("2024-02");
    const result = presentUsage(period.month, period.start, period.end, [
      { date: "2024-02-01", recipients: "103", ses_recipients: "3", unmeasured_sends: "2", api_requests: "9" },
      { date: "2024-02-29", recipients: 2, ses_recipients: 2, unmeasured_sends: 0, api_requests: 5 },
    ]);
    expect(result.days).toHaveLength(29);
    expect(result.days[1]).toEqual({ date: "2024-02-02", recipients: 0, ses_recipients: 0, unmeasured_sends: 0, api_requests: 0 });
    expect(result).toMatchObject({ recipients: 105, ses_recipients: 5, unmeasured_sends: 2, api_requests: 14, ses_estimate_usd: 0.0005 });
  });

  it("scopes the full aggregation to the tenant and historical accepted recipients", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const flushTelemetry = vi.fn(async () => undefined);
    const app = Fastify();
    app.addHook("preHandler", async (request) => { request.auth = { tenant_id: "tenant_a", api_key_id: "key_a", scope: "full" }; });
    registerUsage(app, { db: { query } as unknown as Queryable, flushTelemetry });
    const response = await app.inject({ method: "GET", url: "/usage/summary?month=2026-10" });
    expect(response.statusCode).toBe(200);
    expect(flushTelemetry).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(values).toEqual(["tenant_a", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "2026-10-01", "2026-11-01"]);
    expect(sql).toContain("distinct on (ev.email_id)");
    expect(sql).toContain("ev.type = 'email.sent'");
    expect(sql).toContain("ev.provider_event_id is not null");
    expect(sql).toContain("jsonb_array_length(data->'recipients')");
    expect(sql).toContain("ev.data->>'sandbox' = 'false'");
    expect(sql).toContain("raw.provider = 'ses'");
    expect(sql).toContain("name = 'api_requests'");
    expect(sql).not.toContain("email_recipients");
    expect(response.json()).toMatchObject({ recipients: 0, api_requests: 0, ses_estimate_usd: 0 });
    expect(response.json().days).toHaveLength(31);
    await app.close();
  });
});
