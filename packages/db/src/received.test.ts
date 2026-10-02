import { describe, expect, it, vi } from "vitest";
import { applyHtmlFormat, attachmentsFromInbound, ingestReceived, verdict } from "./received.js";

describe("received mail helpers", () => {
  it("lower-cases SES verdicts and inlines cid images unless the caller asks for cid", () => {
    expect(verdict("PASS")).toBe("pass");
    expect(verdict("PROCESSING_FAILED")).toBe("processing_failed");
    expect(verdict(null)).toBe("gray");
    const html = '<img src="cid:logo">';
    const bytes = Buffer.from("png");
    expect(applyHtmlFormat(html, "data_uri", [{ content_id: "logo", content_type: "image/png", bytes }])).toBe(
      `<img src="data:image/png;base64,${bytes.toString("base64")}">`
    );
    expect(applyHtmlFormat(html, "cid", [{ content_id: "logo", content_type: "image/png", bytes }])).toBe(html);
  });

  it("rejects attachment content that is not base64", () => {
    expect(() => attachmentsFromInbound([{ filename: "a.txt", content: "!!!!", content_type: "text/plain" }])).toThrow(/base64/);
  });
});

describe("ingestReceived", () => {
  it("writes the received email, stores the raw message, and emits email.received", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const stored: Array<{ key: string; bytes: Buffer }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("insert into received_emails")) {
          return { rows: [{ id: params[0], from: params[3], subject: params[4], message_id: params[9], raw_key: params[12] }] };
        }
        if (sql.includes("insert into email_events")) {
          return { rows: [{ id: "event_1", tenant_id: params[1], request_id: params[2], email_id: null, type: params[5], data: {} }] };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    const raw = Buffer.from("raw-mime");
    const result = await ingestReceived(client, {
      tenantId: "tenant_1",
      requestId: "req_1",
      from: "ada@example.com",
      to: ["inbound@example.com"],
      subject: "Hello",
      text: "Hi",
      messageId: "<abc@example.com>",
      authentication: { spf: "pass", dkim: "pass", dmarc: "gray" },
      rawBytes: raw,
      storeAttachment: async (key, bytes) => {
        stored.push({ key, bytes });
      },
      attachments: [{ filename: "note.txt", content_type: "text/plain", bytes: Buffer.from("hello") }]
    });
    expect(result.raw_key).toBe(`raw/tenant_1/${result.id}`);
    expect(stored[0]).toEqual({ key: result.raw_key, bytes: raw });
    expect(stored[1].key).toMatch(/^received\/tenant_1\//);
    expect(queries.some((query) => query.sql.includes("email.received") || query.params.includes("email.received"))).toBe(true);
    expect(result.to).toEqual(["inbound@example.com"]);
    const event = queries.find((query) => query.params.includes("email.received"));
    expect(event?.params[6]).toBe(`${result.id}:received`);
    expect(JSON.parse(String(event?.params[7]))).toMatchObject({
      email_id: result.id,
      from: "ada@example.com",
      to: ["inbound@example.com"],
      received_for: ["inbound@example.com"],
      subject: "Hello",
      message_id: "<abc@example.com>",
      attachments: [{ id: expect.stringMatching(/^ratt_/), filename: "note.txt", content_type: "text/plain", content_id: null, size: 5 }]
    });
  });
});
