import { describe, expect, it, vi } from "vitest";
import type { Storage } from "@dispatchmail/storage";
import { applyInbound, parseInbound } from "./inbound.js";

const mime = Buffer.from([
  "From: Ada <ada@example.com>",
  "To: inbound@example.com",
  "Subject: Hello inbound",
  "Message-ID: <abc@example.com>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hi there"
].join("\r\n"));

describe("parseInbound", () => {
  it("reads the MIME headers postal-mime returns", async () => {
    const parsed = await parseInbound(mime);
    expect(parsed.from).toBe("ada@example.com");
    expect(parsed.to).toEqual(["inbound@example.com"]);
    expect(parsed.subject).toBe("Hello inbound");
    expect(parsed.text).toContain("Hi there");
    expect(parsed.messageId).toBe("<abc@example.com>");
  });
});

describe("applyInbound", () => {
  it("ingests a receipt into the tenant that enabled receiving and skips an unknown domain", async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push(sql);
        if (sql.includes("from domains")) {
          return params[0] === "example.com" ? { rows: [{ tenant_id: "tenant_1" }] } : { rows: [] };
        }
        if (sql.includes("insert into received_emails")) {
          return { rows: [{ id: params[0], from: params[3], subject: params[4], raw_key: params[12] }] };
        }
        if (sql.includes("insert into email_events")) {
          return { rows: [{ id: "event_1", tenant_id: params[1], request_id: params[2], email_id: null, type: params[5], data: {} }] };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    const files = new Map<string, Buffer>([["raw/inbound/message", mime]]);
    const storage = {
      get: async (key: string) => files.get(key) ?? Buffer.alloc(0),
      put: async (key: string, bytes: Buffer) => { files.set(key, bytes); },
      stream: async () => null as never,
      url: async () => ({ download_url: "http://localhost/files/x", expires_at: new Date().toISOString() }),
      delete: async () => {}
    } satisfies Storage;
    const notification = {
      mail: { messageId: "ses-in", source: "ada@example.com" },
      receipt: {
        recipients: ["inbound@example.com"],
        spfVerdict: { status: "PASS" },
        dkimVerdict: { status: "FAIL" },
        dmarcVerdict: { status: "GRAY" },
        action: { objectKey: "raw/inbound/message" }
      }
    };
    const saved = await applyInbound(db, storage, notification);
    expect(saved?.to).toEqual(["inbound@example.com"]);
    expect(queries.some((sql) => sql.includes("insert into received_emails"))).toBe(true);
    const auth = db.query.mock.calls.find((call) => String(call[0]).includes("insert into received_emails"))?.[1][11];
    expect(JSON.parse(String(auth))).toEqual({ spf: "pass", dkim: "fail", dmarc: "gray" });
    await expect(applyInbound(db, storage, { ...notification, receipt: { ...notification.receipt, recipients: ["nobody@other.test"] } })).resolves.toBeNull();
    const owner = db.query.mock.calls.find((call) => String(call[0]).includes("from domains"));
    expect(String(owner?.[0])).toContain("status in ('verified', 'partially_verified')");
    const event = db.query.mock.calls.find((call) => (call[1] as unknown[] | undefined)?.includes("email.received"));
    expect((event?.[1] as unknown[])[6]).toBe("ses:ses-in:received");
  });

  it("drops a redelivered notification and mail for a domain two tenants claim", async () => {
    const storage = {
      get: vi.fn(async () => mime),
      put: vi.fn(async () => {}),
      stream: async () => null as never,
      url: async () => ({ download_url: "http://localhost/files/x", expires_at: new Date().toISOString() }),
      delete: async () => {}
    } satisfies Storage;
    const notification = {
      mail: { messageId: "ses-in", source: "ada@example.com" },
      receipt: { recipients: ["Inbound@Example.com"], action: { objectKey: "raw/sesmessageid" } }
    };
    const seen = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("from domains")) return { rows: [{ tenant_id: "tenant_1" }] };
        if (sql.includes("from email_events")) return { rows: params[0] === "ses:ses-in:received" ? [{ "?column?": 1 }] : [] };
        return { rows: [], rowCount: 1 };
      })
    };
    await expect(applyInbound(seen, storage, notification, { region: "us-east-1" })).resolves.toBeNull();
    expect(storage.get).not.toHaveBeenCalled();
    expect(seen.query.mock.calls[0][1]).toEqual(["example.com", "us-east-1"]);
    expect(seen.query.mock.calls.some((call) => String(call[0]).includes("insert into received_emails"))).toBe(false);

    const shared = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from domains")) return { rows: [{ tenant_id: "tenant_1" }, { tenant_id: "tenant_2" }] };
        return { rows: [], rowCount: 1 };
      })
    };
    await expect(applyInbound(shared, storage, notification)).resolves.toBeNull();
    expect(storage.get).not.toHaveBeenCalled();
  });
});
