import Fastify from "fastify";
import { connect } from "@dispatchmail/db";
import { expect, it } from "vitest";
import { registerUsage } from "./usage.js";

// Temporary tables shadow the real tables only on this connection; rollback removes every fixture.
it.skipIf(!process.env.TEST_DATABASE_URL)("aggregates accepted recipients by UTC month without duplicates, simulation, or cross-tenant sends", async () => {
  const db = connect(process.env.TEST_DATABASE_URL);
  const client = await db.connect();
  const app = Fastify();
  try {
    await client.query("begin");
    await client.query(`
      create temporary table emails (id text, tenant_id text, sandbox boolean) on commit drop;
      create temporary table email_events (id text, email_id text, tenant_id text, type text, provider_event_id text, created_at timestamptz, data jsonb) on commit drop;
      create temporary table provider_events_raw (tenant_id text, event_id text, provider text) on commit drop;
      create temporary table usage_counters (tenant_id text, name text, period text, value bigint) on commit drop;
    `);
    const records = [
      ["real", "a", false, "2026-10-01T00:00:00Z", { recipients: ["a", "b", "c"], sandbox: false }, "ses"],
      ["fake", "a", false, "2026-10-02T00:00:00Z", { recipients: ["d", "e"], sandbox: false }, "fake"],
      ["old", "a", false, "2026-10-03T00:00:00Z", {}, "ses"],
      ["sandbox", "a", true, "2026-10-03T00:00:00Z", { recipients: ["x"], sandbox: true }, "ses"],
      ["test", "a", false, "2026-10-03T00:00:00Z", { recipients: ["x"], test: true }, "ses"],
      ["other", "b", false, "2026-10-03T00:00:00Z", { recipients: ["x"] }, "ses"],
      ["prior", "a", false, "2026-09-30T23:59:59Z", { recipients: ["x"] }, "ses"],
    ] as const;
    for (const [id, tenant, sandbox, date, data, provider] of records) {
      await client.query("insert into emails values ($1,$2,$3)", [id, tenant, sandbox]);
      await client.query("insert into email_events values ($1,$2,$3,'email.sent',$4,$5,$6)", [id, id, tenant, `${id}:sent`, date, JSON.stringify(data)]);
      await client.query("insert into provider_events_raw values ($1,$2,$3)", [tenant, id, provider]);
    }
    await client.query(`insert into email_events values
      ('duplicate','real','a','email.sent','duplicate:sent','2026-10-04','{"recipients":["x","y"]}'),
      ('late','prior','a','email.sent','late:sent','2026-10-04','{"recipients":["x"]}')`);
    await client.query(`insert into usage_counters values
      ('a','api_requests','2026-10-01',5), ('a','api_requests','2026-10-31',7),
      ('a','api_requests','2026-09-30',100), ('a','api_requests','2026-11-01',100),
      ('b','api_requests','2026-10-01',100)`);
    app.addHook("preHandler", async (request) => { request.auth = { tenant_id: "a", api_key_id: "test", scope: "full" }; });
    registerUsage(app, { db: client, flushTelemetry: async () => {} });
    const response = await app.inject({ method: "GET", url: "/usage/summary?month=2026-10" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ recipients: 5, ses_recipients: 3, unmeasured_sends: 1, api_requests: 12 });
    expect(response.json().ses_estimate_usd).toBeCloseTo(0.0003);
    expect(response.json().days).toHaveLength(31);
  } finally {
    await app.close();
    await client.query("rollback");
    client.release();
    await db.end();
  }
}, 20_000);
