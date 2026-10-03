import { describe, expect, it, vi } from "vitest";
import { ProviderError, type Provider } from "@dispatchmail/core";
import type { Db } from "@dispatchmail/db";
import type { Storage } from "@dispatchmail/storage";
import { deliverJob, handleSendFailure, loadProviderEmail, pace } from "./deliver.js";

const job = { id: "job_1", tenant_id: "tenant_1", email_id: "email_1", request_id: "req_1" };

function storage(): Storage {
  return {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => Buffer.from("file-bytes")),
    stream: vi.fn(async () => null as never),
    url: vi.fn(async () => ({ download_url: "http://localhost/files/token", expires_at: new Date().toISOString() })),
    delete: vi.fn(async () => {})
  };
}

describe("pace", () => {
  it("waits when the region is already at max_per_second", async () => {
    const slept: number[] = [];
    const slots = new Map<string, number>([["us-east-1", 2_000]]);
    await pace("us-east-1", 1, { now: 1_200, sleep: async (ms) => { slept.push(ms); }, slots });
    expect(slept).toEqual([800]);
  });

  it("spaces jobs that start together one interval apart", async () => {
    const slept: number[] = [];
    const slots = new Map<string, number>();
    await Promise.all(
      Array.from({ length: 6 }, () => pace("us-east-1", 2, { now: 1_000, sleep: async (ms) => { slept.push(ms); }, slots }))
    );
    expect(slept).toEqual([500, 1_000, 1_500, 2_000, 2_500]);
    expect(slots.get("us-east-1")).toBe(4_000);
    const other: number[] = [];
    await pace("eu-west-1", 2, { now: 1_000, sleep: async (ms) => { other.push(ms); }, slots });
    expect(other).toEqual([]);
  });
});

describe("loadProviderEmail", () => {
  it("loads the body, skips suppressed recipients, and reads attachment bytes", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from emails")) {
          return { rows: [{ id: "email_1", tenant_id: "tenant_1", from_email: "ada@example.com", from_name: "Ada", reply_to: ["reply@example.com"], subject: "Hello", html: "<p>Hi</p>", text: "Hi", headers: { "X-Test": "1" }, status: "queued", region: "eu-west-1", tls: "enforced" }] };
        }
        if (sql.includes("from email_recipients")) return { rows: [{ email: "one@dispatch-fixture.net", kind: "to" }] };
        if (sql.includes("from email_attachments")) {
          return { rows: [{ filename: "note.txt", content_type: "text/plain", content_id: null, disposition: "attachment", storage_key: "attachments/tenant_1/email_1/att_1" }] };
        }
        return { rows: [] };
      })
    };
    const files = storage();
    const loaded = await loadProviderEmail(db, files, job);
    expect(loaded).toMatchObject({
      from: "Ada <ada@example.com>",
      region: "eu-west-1",
      tls: "enforced",
      recipients: [{ email: "one@dispatch-fixture.net", kind: "to" }],
      attachments: [{ filename: "note.txt", bytes: Buffer.from("file-bytes") }]
    });
    expect(db.query.mock.calls[1][0]).toContain("status not in");
  });
});

describe("late opt-outs", () => {
  it("checks suppression and, for broadcast mail, unsubscribes again at the moment of sending", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("from emails")) {
          return { rows: [{ id: "email_1", tenant_id: "tenant_1", from_email: "ada@example.com", from_name: null, reply_to: [], subject: "Hello", html: null, text: "Hi", headers: {}, status: "queued", broadcast_id: "broadcast_1", provider_message_id: null, region: "us-east-1", tls: "opportunistic" }] };
        }
        // Everyone on the email has since been suppressed or has unsubscribed.
        if (sql.includes("from email_recipients")) return { rows: [] };
        return { rows: [], rowCount: 1 };
      })
    };
    await expect(loadProviderEmail(db, storage(), job)).resolves.toBeNull();
    const recipients = calls.find((call) => call.sql.includes("from email_recipients"))!;
    expect(recipients.sql).toContain("from suppressions s");
    expect(recipients.sql).toContain("c.unsubscribed_at is not null");
    expect(recipients.params).toEqual(["email_1", "tenant_1", true]);
    const cancelled = calls.find((call) => call.sql.includes("update emails set status = 'cancelled'"));
    expect(cancelled?.params).toEqual(["tenant_1", "email_1"]);
  });
});

describe("deliverJob", () => {
  function sandboxFixture(recipients: Array<{ email: string; kind: string; sandbox?: boolean }>, domains: string[] = []) {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from emails")) return { rows: [{
        id: job.email_id, tenant_id: job.tenant_id, from_email: "sender@dispatch-fixture.net",
        subject: "Preview", text: "Rendered preview", status: "queued",
        sandbox: false, settings: { sandbox_domains: domains },
      }] };
      if (sql.includes("from email_recipients")) return { rows: recipients };
      if (sql.includes("insert into email_events")) return { rows: [{
        id: "event_1", tenant_id: job.tenant_id, request_id: job.request_id,
        email_id: job.email_id, type: params[5], data: JSON.parse(String(params[7])),
      }] };
      return { rows: [], rowCount: 1 };
    });
    const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Db;
    const provider: Provider = {
      name: "ses",
      quota: vi.fn(async () => ({ max_24_hour: 200, max_per_second: 100, sent_24_hour: 0, sandbox: false })),
      send: vi.fn(async (email) => ({
        provider_message_id: "real-provider-id",
        events: [{ type: "email.sent", provider_event_id: "real-provider-id:sent", delay_ms: 0,
          recipients: email.recipients.map((r) => r.email), data: {} }],
      })),
    };
    return { db, query, provider };
  }

  it.each(["preview@example.com", "preview@sub.example.net", "preview@demo.invalid", "preview@qa.dispatch-fixture.net"])("bypasses SES quota and send for %s", async (address) => {
    const { db, query, provider } = sandboxFixture([{ email: address, kind: "to" }], ["qa.dispatch-fixture.net"]);
    await deliverJob(db, storage(), provider, job, { durable: true });
    expect(provider.send).not.toHaveBeenCalled();
    expect(provider.quota).not.toHaveBeenCalled();
    const event = query.mock.calls.find(([sql]) => sql.includes("insert into email_events"));
    expect(event?.[1]?.[5]).toBe("email.delivered");
    expect(JSON.parse(String(event?.[1]?.[7]))).toEqual({ sandbox: true, recipients: [address] });
    expect(query.mock.calls.some(([sql]) => sql.includes("set provider_message_id"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("provider_events_raw"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into usage_counters"))).toBe(false);
  });

  it("honors stored sandbox attribution after the custom setting is removed", async () => {
    const { db, provider } = sandboxFixture([{ email: "preview@qa.dispatch-fixture.net", kind: "to", sandbox: true }]);
    await deliverJob(db, storage(), provider, job);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("freezes history before late broadcast reclassification and reconciles its real aggregate", async () => {
    const fixture = sandboxFixture([{ email: "preview@qa.dispatch-fixture.net", kind: "to" }], ["qa.dispatch-fixture.net"]);
    const query = fixture.query.getMockImplementation()!;
    fixture.query.mockImplementation(async (sql, params = []) => {
      const result = await query(sql, params);
      if (sql.includes("from emails")) {
        return { ...result, rows: result.rows.map((row) => ({ ...row, broadcast_id: "broadcast_1" })) } as never;
      }
      return result;
    });
    await deliverJob(fixture.db, storage(), fixture.provider, job);
    expect(fixture.provider.quota).not.toHaveBeenCalled();
    expect(fixture.provider.send).not.toHaveBeenCalled();
    const calls = fixture.query.mock.calls;
    const frozen = calls.findIndex(([sql]) => sql.includes("update email_events ev set data"));
    const routing = calls.findIndex(([sql]) => sql.includes("update email_recipients set sandbox"));
    const aggregate = calls.findIndex(([sql]) => sql.includes("sent_count = ("));
    expect(frozen).toBeGreaterThan(-1);
    expect(routing).toBeGreaterThan(frozen);
    expect(aggregate).toBeGreaterThan(routing);
    const lock = calls.findIndex(([sql]) => sql.includes("from broadcasts") && sql.includes("for update"));
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(frozen);
  });

  it("hands only real To/Cc/Bcc recipients to SES for mixed mail", async () => {
    const { db, query, provider } = sandboxFixture([
      { email: "preview@example.org", kind: "to" },
      { email: "real@dispatch-fixture.net", kind: "cc" },
      { email: "hidden@dispatch-fixture.net", kind: "bcc" },
      { email: "hidden@demo.test", kind: "bcc" },
    ]);
    await deliverJob(db, storage(), provider, job, { sleep: async () => {} });
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({
      recipients: [{ email: "real@dispatch-fixture.net", kind: "cc" }, { email: "hidden@dispatch-fixture.net", kind: "bcc" }],
    }));
    const sandboxStatus = query.mock.calls.find(([sql]) => sql.includes("update emails set status"));
    expect(sandboxStatus?.[0]).toContain("and sandbox");
  });

  it("stores the SES message id and the provider event", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("from emails")) {
        return { rows: [{ id: "email_1", tenant_id: "tenant_1", from_email: "ada@example.com", from_name: null, reply_to: [], subject: "Hello", html: null, text: "Hi", headers: {}, status: "queued", region: "us-east-1", tls: "opportunistic" }] };
      }
      if (sql.includes("from email_recipients")) return { rows: [{ email: "one@dispatch-fixture.net", kind: "to" }] };
      if (sql.includes("from email_attachments")) return { rows: [] };
      if (sql.includes("insert into email_events")) {
        return { rows: [{ id: "event_1", tenant_id: "tenant_1", request_id: "req_1", email_id: "email_1", type: "email.sent", data: {} }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Db;
    const provider: Provider = {
      name: "ses",
      quota: async () => ({ max_24_hour: 200, max_per_second: 100, sent_24_hour: 0, sandbox: true }),
      send: vi.fn(async () => ({
        provider_message_id: "sesmsg",
        message_id: "<sesmsg@us-east-1.amazonses.com>",
        events: [{ type: "email.sent" as const, provider_event_id: "sesmsg:sent", delay_ms: 0, recipients: ["one@dispatch-fixture.net"], data: { provider_message_id: "sesmsg" } }]
      }))
    };
    await deliverJob(db, storage(), provider, job, { sleep: async () => {} });
    const update = queries.find((sql) => sql.includes("provider_message_id"));
    expect(update).toContain("message_id");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("provider_message_id"), ["tenant_1", "email_1", "sesmsg", "<sesmsg@us-east-1.amazonses.com>"]);
    // The id, the event, and the webhook attempts are written between one begin and one commit.
    const write = queries.findIndex((sql) => sql.includes("set provider_message_id"));
    const begin = queries.lastIndexOf("begin", write);
    const commit = queries.indexOf("commit", begin);
    const inTx = (text: string) => {
      const at = queries.findIndex((sql) => sql.includes(text));
      return at > begin && at < commit;
    };
    expect(inTx("set provider_message_id")).toBe(true);
    expect(inTx("insert into email_events")).toBe(true);
    expect(inTx("insert into webhook_attempts")).toBe(true);
  });

  it("does not send again when an earlier attempt already reached the provider", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("from emails")) {
        return { rows: [{ id: "email_1", tenant_id: "tenant_1", from_email: "ada@example.com", from_name: null, reply_to: [], subject: "Hello", html: null, text: "Hi", headers: {}, status: "queued", provider_message_id: "sesmsg", settings: { sandbox_domains: ["dispatch-fixture.net"] }, region: "us-east-1", tls: "opportunistic" }] };
      }
      if (sql.includes("from email_recipients")) return { rows: [{ email: "one@dispatch-fixture.net", kind: "to" }] };
      if (sql.includes("from email_attachments")) return { rows: [] };
      if (sql.includes("insert into email_events")) {
        return { rows: [{ id: "event_1", tenant_id: "tenant_1", request_id: "req_1", email_id: "email_1", type: "email.sent", data: {} }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Db;
    const provider: Provider = {
      name: "ses",
      quota: vi.fn(async () => ({ max_24_hour: 200, max_per_second: 100, sent_24_hour: 0, sandbox: true })),
      send: vi.fn()
    };
    await deliverJob(db, storage(), provider, job, { sleep: async () => {} });
    expect(provider.send).not.toHaveBeenCalled();
    const event = queries.find((entry) => entry.sql.includes("insert into email_events"));
    expect(event?.params[6]).toBe("sesmsg:sent");
    expect(queries.some((entry) => entry.sql.includes("set sandbox = true"))).toBe(false);
    expect(queries.some((entry) => entry.sql.includes("update send_jobs set state") && entry.params.includes("done"))).toBe(true);
  });
});

describe("handleSendFailure", () => {
  it("fails a rejected message immediately and records failed.reason", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("select attempts")) return { rows: [{ attempts: 1 }] };
      if (sql.includes("insert into email_events")) {
        return { rows: [{ id: "event_1", tenant_id: "tenant_1", request_id: "req_1", email_id: "email_1", type: "email.failed", data: {} }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Db;
    await handleSendFailure(db, job, new ProviderError("MessageRejected", false));
    expect(queries.some((entry) => entry.sql.includes("state = 'failed'"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("make_interval"))).toBe(false);
    const event = queries.find((entry) => entry.sql.includes("insert into email_events"));
    expect(JSON.parse(String(event?.params[7]))).toEqual({ failed: { reason: "MessageRejected" }, sandbox: false });
  });
});
