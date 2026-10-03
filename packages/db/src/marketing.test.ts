import { describe, expect, it, vi } from "vitest";
import { acceptEmail } from "./accept.js";
import { clearBrandCache } from "./emails.js";
import { readUnsubscribeToken } from "./unsubscribe.js";

const context = { tenant_id: "tenant_marketing", request_id: "req_1" };
const unsubscribe = { secret: "test-secret", appUrl: "https://app.example", publicUrl: "https://api.example" };
const letter = { from: "hello@example.com", to: "ada@example.com", subject: "News", text: "Hi", topic_id: "topic_news" };

function fixture(opts: { optedOut?: string[]; template?: boolean } = {}) {
  clearBrandCache();
  const emails: unknown[][] = [];
  const recipients: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from domains")) return { rows: [{ id: "domain_1", name: "example.com", sending: "enabled" }] };
    if (sql.includes("from templates") && opts.template) return { rows: [{
      id: "version_1", template_id: "template_1", subject: "News", html: '<a href="{{{UNSUBSCRIBE_URL}}}">Leave</a>',
      text: null, variables: [], from_address: null, reply_to: [], track: false,
    }] };
    if (sql.includes("select id from contacts")) return { rows: [{ id: `contact_${String(params[1]).split("@")[0]}` }] };
    if (sql.includes("select id from topics")) return { rows: [{ id: "topic_news" }] };
    if (sql.includes("select c.email")) return { rows: (opts.optedOut ?? []).filter((email) => (params[1] as string[]).includes(email)).map((email) => ({ email })) };
    if (sql.includes("insert into emails")) {
      emails.push(params);
      return { rows: [{ id: params[0], request_id: params[2], from: params[4], subject: params[7], status: params[17], scheduled_at: params[18], created_at: "2026-10-01T00:00:00.000Z" }] };
    }
    if (sql.includes("insert into email_recipients")) {
      recipients.push(params);
      return { rows: (params[0] as string[]).map((id, i) => ({ id, email: (params[3] as string[])[i], status: (params[5] as string[])[i] })) };
    }
    return { rowCount: 0, rows: [] };
  });
  return { query, emails, recipients };
}

function token(headers: Record<string, string>) {
  return decodeURIComponent(headers["List-Unsubscribe"]!.match(/\/unsubscribe\/([^>]+)>/)![1]!);
}

describe("marketing recipient isolation", () => {
  it("splits and deduplicates To, Cc, and Bcc with a recipient-specific signed link", async () => {
    const db = fixture();
    const result = await acceptEmail(db as never, {
      ...letter, to: ["ada@example.com", "bob@example.com"], cc: ["ADA@example.com"], bcc: ["carol@example.com"],
      html: '<a href="{{UNSUBSCRIBE_URL}}">Leave</a><p>{{name}}</p>',
      text: "{{{RESEND_UNSUBSCRIBE_URL}}}",
      headers: { "list-unsubscribe": "https://evil.example", "LIST-UNSUBSCRIBE-POST": "bad", "X-Custom": "kept" },
    }, context, { client: db, unsubscribe });
    expect(result.emails?.map((row) => row.to)).toEqual(["ada@example.com", "bob@example.com", "carol@example.com"]);
    expect(new Set(result.emails?.map((row) => row.id)).size).toBe(3);
    expect(result.email.id).toBe(result.emails?.[0]?.id);
    for (const [i, params] of db.emails.entries()) {
      const headers = JSON.parse(params[13] as string);
      const payload = readUnsubscribeToken(token(headers), unsubscribe.secret)!;
      expect(payload).toMatchObject({ tenant_id: context.tenant_id, contact_id: `contact_${["ada", "bob", "carol"][i]}`, email_id: params[0], topic_id: letter.topic_id });
      expect(Object.keys(headers).sort()).toEqual(["List-Unsubscribe", "List-Unsubscribe-Post", "X-Custom"].sort());
      expect(params[8]).toContain(`${unsubscribe.appUrl}/unsubscribe?token=`);
      expect(params[8]).toContain("{{name}}");
      expect(params[10]).not.toContain("{{{");
      expect(JSON.parse(params[14] as string)).toEqual({ split_role: ["to", "to", "bcc"][i] });
      expect(db.recipients[i]![3]).toEqual([result.emails?.[i]?.to]);
      expect(db.recipients[i]![4]).toEqual(["to"]);
    }
  });

  it("keeps single-recipient responses and filters opt-outs independently", async () => {
    const db = fixture({ optedOut: ["ada@example.com"] });
    const result = await acceptEmail(db as never, { ...letter, to: ["ada@example.com", "bob@example.com"] }, context, { client: db, unsubscribe });
    expect(result.emails).toHaveLength(2);
    expect(db.recipients.map((row) => row[5])).toEqual([["failed"], ["queued"]]);
    const single = fixture();
    const accepted = await acceptEmail(single as never, letter, context, { client: single, unsubscribe });
    expect(accepted).not.toHaveProperty("emails");
  });

  it("never splits transactional sends or replaces their caller headers and placeholders", async () => {
    const db = fixture();
    const result = await acceptEmail(db as never, {
      ...letter, topic_id: undefined, to: ["ada@example.com", "bob@example.com"], cc: "carol@example.com",
      text: "{{UNSUBSCRIBE_URL}}", headers: { "list-unsubscribe": "caller" },
    }, context, { client: db });
    expect(result).not.toHaveProperty("emails");
    expect(db.emails).toHaveLength(1);
    expect(db.recipients[0]![4]).toEqual(["to", "to", "cc"]);
    expect(db.emails[0]![10]).toBe("{{UNSUBSCRIBE_URL}}");
    expect(JSON.parse(db.emails[0]![13] as string)).toEqual({ "list-unsubscribe": "caller" });
  });

  it("ignores forged unsubscribe variables when rendering a marketing template", async () => {
    const db = fixture({ template: true });
    await acceptEmail(db as never, {
      ...letter, text: undefined, subject: undefined, template: { id: "template_1", variables: { UNSUBSCRIBE_URL: "https://evil.example" } },
    }, context, { client: db, unsubscribe });
    expect(db.emails[0]![8]).toContain("https://app.example/unsubscribe?token=");
    expect(db.emails[0]![8]).not.toContain("evil.example");
  });

  it("explains a missing unsubscribe link on a transactional template", async () => {
    const db = fixture({ template: true });
    await expect(acceptEmail(db as never, {
      ...letter, topic_id: undefined, text: undefined, template: "template_1",
    }, context, { client: db })).rejects.toMatchObject({
      message: "This template prints an unsubscribe link, so it needs topic_id. Send it as marketing, or remove the link.",
    });
  });
});
