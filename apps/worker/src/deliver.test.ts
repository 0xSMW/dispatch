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
        if (sql.includes("from email_recipients")) return { rows: [{ email: "one@example.com", kind: "to" }] };
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
      recipients: [{ email: "one@example.com", kind: "to" }],
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
  it("stores the SES message id and the provider event", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("from emails")) {
        return { rows: [{ id: "email_1", tenant_id: "tenant_1", from_email: "ada@example.com", from_name: null, reply_to: [], subject: "Hello", html: null, text: "Hi", headers: {}, status: "queued", region: "us-east-1", tls: "opportunistic" }] };
      }
      if (sql.includes("from email_recipients")) return { rows: [{ email: "one@example.com", kind: "to" }] };
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
        events: [{ type: "email.sent" as const, provider_event_id: "sesmsg:sent", delay_ms: 0, recipients: ["one@example.com"], data: { provider_message_id: "sesmsg" } }]
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
        return { rows: [{ id: "email_1", tenant_id: "tenant_1", from_email: "ada@example.com", from_name: null, reply_to: [], subject: "Hello", html: null, text: "Hi", headers: {}, status: "queued", provider_message_id: "sesmsg", region: "us-east-1", tls: "opportunistic" }] };
      }
      if (sql.includes("from email_recipients")) return { rows: [{ email: "one@example.com", kind: "to" }] };
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
    expect(JSON.parse(String(event?.params[7]))).toEqual({ failed: { reason: "MessageRejected" } });
  });
});
