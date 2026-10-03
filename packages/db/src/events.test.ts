import { describe, expect, it, vi } from "vitest";
import { appendEvent } from "./events.js";

function client() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("insert into email_events")) {
        return {
          rows: [{
            id: "event_1",
            tenant_id: params[1],
            request_id: params[2],
            email_id: params[3],
            type: params[5],
            data: JSON.parse(String(params[7]))
          }]
        };
      }
      if (sql.includes("insert into suppressions")) {
        return { rows: [{ id: "supp_1", email: "a@example.com" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    })
  };
}

describe("appendEvent", () => {
  it("reconciles sandbox statuses on deduplication without repeating usage or provider records", async () => {
    const db = client();
    const query = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql, params = []) => {
      if (sql.includes("insert into email_events")) {
        db.queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }
      return query(sql, params);
    });
    expect(await appendEvent(db, {
      tenantId: "tenant_1", requestId: "req_1", emailId: "email_1",
      type: "email.delivered", providerEventId: "email_1:sandbox:delivered",
      data: { sandbox: true }, mode: "delivery", recipients: ["preview@example.com"],
      provider: "sandbox",
    })).toBeNull();
    expect(db.queries.some(({ sql }) => sql.includes("update email_recipients"))).toBe(true);
    expect(db.queries.some(({ sql }) => sql.includes("update emails set status"))).toBe(true);
    expect(db.queries.some(({ sql }) => sql.includes("provider_events_raw"))).toBe(false);
    expect(db.queries.some(({ sql }) => sql.includes("usage_counters"))).toBe(false);
  });

  it("updates and suppresses only the bounced recipient when the bounce is permanent", async () => {
    const db = client();
    await appendEvent(db, {
      tenantId: "tenant_1",
      requestId: "req_1",
      emailId: "email_1",
      type: "email.bounced",
      providerEventId: "ses:Bounce:a@example.com",
      data: { bounce: { type: "Permanent", subType: "General", message: "550" } },
      mode: "delivery",
      recipients: ["A@Example.com"],
      provider: "ses"
    });
    const recipient = db.queries.find((query) => query.sql.includes("update email_recipients"));
    expect(recipient?.sql).toContain("lower(email) = any");
    expect(recipient?.params[4]).toEqual(["a@example.com"]);
    const suppression = db.queries.find((query) => query.sql.includes("insert into suppressions"));
    expect(suppression?.params).toEqual(["tenant_1", ["A@Example.com"], "email.bounced", "bounce", "email_1"]);
    // A suppression the user removed earlier comes back on a new bounce.
    expect(suppression?.sql).toContain("lower(email)");
    expect(suppression?.sql).toContain("do update set");
    expect(suppression?.sql).toContain("where suppressions.removed_at is not null");
    const raw = db.queries.find((query) => query.sql.includes("provider_events_raw"));
    expect(raw?.params).toContain("ses");
    const added = db.queries.find((query) => query.sql.includes("insert into email_events") && query.params.includes("suppression.added"));
    expect(added?.params[1]).toBe("tenant_1");
  });

  it("never moves a status backward when events arrive out of order", async () => {
    const db = client();
    await appendEvent(db, {
      tenantId: "tenant_1",
      requestId: "req_1",
      emailId: "email_1",
      type: "email.sent",
      providerEventId: "ses:Send:late",
      data: {},
      mode: "delivery",
      provider: "ses"
    });
    const email = db.queries.find((query) => query.sql.includes("update emails set status"));
    expect(email?.sql).toContain("when 'delivered' then 3");
    expect(email?.sql).toContain("<= $4");
    expect(email?.params).toEqual(["tenant_1", "email_1", "sent", 1]);

    const bounced = client();
    await appendEvent(bounced, {
      tenantId: "tenant_1",
      requestId: "req_1",
      emailId: "email_1",
      type: "email.bounced",
      providerEventId: "ses:Bounce:late",
      data: { bounce: { type: "Transient" } },
      mode: "delivery",
      provider: "ses"
    });
    expect(bounced.queries.find((query) => query.sql.includes("update emails set status"))?.params[3]).toBe(6);
  });

  it("does not suppress a transient bounce", async () => {
    const db = client();
    await appendEvent(db, {
      tenantId: "tenant_1",
      requestId: "req_1",
      emailId: "email_1",
      type: "email.bounced",
      providerEventId: "ses:Bounce:b@example.com",
      data: { bounce: { type: "Transient", subType: "MailboxFull" } },
      mode: "delivery",
      recipients: ["b@example.com"],
      provider: "ses"
    });
    expect(db.queries.some((query) => query.sql.includes("insert into suppressions"))).toBe(false);
    expect(db.queries.some((query) => query.sql.includes("update email_recipients"))).toBe(true);
  });
});
