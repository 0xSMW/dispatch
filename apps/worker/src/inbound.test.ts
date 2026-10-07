import { describe, expect, it, vi } from "vitest";
import type { Storage } from "@dispatchmail/storage";
import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { consumeOnce } from "./events.js";
import { applyInbound, parseInbound, type SesReceipt } from "./inbound.js";

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
  it("rejects an invalid envelope before database or storage access", async () => {
    const db = { query: vi.fn() };
    const storage = { get: vi.fn() } as unknown as Storage;
    await expect(applyInbound(db, storage, { receipt: {
      recipients: Array.from({ length: 51 }, (_, i) => `recipient${i}@example.com`), action: { objectKey: "raw/mail" }
    } })).rejects.toThrow("invalid receipt envelope");
    expect(db.query).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("deletes deeply nested malformed MIME and ingests a valid queue sibling", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let nested = "Content-Type: text/plain\r\n\r\nbody";
    for (let i = 0; i < 300; i++) nested = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${nested}\r\n--b${i}--`;
    const db = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from domains")) return { rows: [{ tenant_id: "tenant_1" }] };
      if (sql.includes("insert into received_emails")) return { rows: [{ id: params[0] }] };
      return { rows: [], rowCount: 1 };
    }) };
    const storage = { get: vi.fn(async (key: string) => key === "poison" ? Buffer.from(nested) : mime),
      put: vi.fn(async () => {}) } as unknown as Storage;
    const receipt = (key: string) => ({ receipt: { recipients: ["inbound@example.com"], action: { objectKey: key } } });
    const sqs = { send: vi.fn(async (command: unknown) => command instanceof ReceiveMessageCommand ? {
      Messages: [{ Body: JSON.stringify(receipt("poison")), ReceiptHandle: "poison" },
        { Body: JSON.stringify(receipt("valid")), ReceiptHandle: "valid" }]
    } : {}) };
    await expect(consumeOnce(sqs, "queue", async (body) => { await applyInbound(db, storage, body as SesReceipt); })).resolves.toBe(2);
    expect(log).toHaveBeenCalledWith("Discarding permanently invalid queue notification", expect.objectContaining({
      message: expect.stringMatching(/^Maximum MIME nesting depth/)
    }));
    expect(db.query.mock.calls.filter(([sql]) => sql.includes("insert into received_emails"))).toHaveLength(1);
    expect(sqs.send.mock.calls.filter(([command]) => command instanceof DeleteMessageCommand)
      .map(([command]) => (command as DeleteMessageCommand).input.ReceiptHandle)).toEqual(["poison", "valid"]);
    log.mockRestore();
  });

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
    files.set("raw/inbound/message", Buffer.from([
      "From: Ada <ada@example.com>",
      `To: ${Array.from({ length: 60 }, (_, i) => `hostile${i}@other.test`).join(", ")}`,
      "Cc: forged@other.test", "Bcc: hidden@other.test", "", "Hi there"
    ].join("\r\n")));
    const saved = await applyInbound(db, storage, notification);
    expect(saved?.to).toEqual(["inbound@example.com"]);
    const recipientWrite = db.query.mock.calls.find((call) => call[0].includes("insert into received_recipients"));
    expect(recipientWrite?.[1][3]).toEqual(["inbound@example.com"]);
    expect(recipientWrite?.[1][4]).toEqual(["to"]);
    const emailWrite = db.query.mock.calls.find((call) => call[0].includes("insert into received_emails"));
    expect(JSON.parse(String(emailWrite?.[1][7])).to).toContain("hostile59@other.test");
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
