import { describe, expect, it, vi } from "vitest";
import {
  broadcastAudience,
  broadcastStatus,
  cancelBroadcast,
  clickedLinks,
  copyName,
  createBroadcast,
  deleteBroadcast,
  finishChunk,
  markRecipients,
  presentBroadcast,
  presentBroadcastSummary,
  previewBroadcast,
  recipientFilter,
  renderBroadcast,
  sendBroadcast,
  updateBroadcast,
  type BroadcastRow,
} from "./broadcasts.js";

function client(handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return handler(sql, params);
    }),
  };
}

const row: BroadcastRow = {
  id: "broadcast_1",
  name: "Launch",
  from_email: "hello@example.com",
  from_name: "Acme",
  reply_to: [],
  subject: "Hi {{{contact.first_name|there}}}",
  preview_text: null,
  html: "<p>Hello</p>",
  text: null,
  template_id: null,
  template_version_id: null,
  variables: {},
  topic_id: "topic_1",
  segment_id: "segment_1",
  status: "draft",
  recipient_count: 0,
  sent_count: 0,
  request_id: "req_1",
  scheduled_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  sent_at: null,
};

describe("broadcast presenter", () => {
  it("maps internal statuses to Resend's", () => {
    expect(broadcastStatus("sending")).toBe("queued");
    expect(broadcastStatus("paused")).toBe("queued");
    expect(broadcastStatus("cancelled")).toBe("canceled");
    expect(broadcastStatus("scheduled")).toBe("scheduled");
    expect(broadcastStatus("draft")).toBe("draft");
    expect(broadcastStatus("sent")).toBe("sent");
  });

  it("returns a flat broadcast with a friendly from and null reply_to when empty", () => {
    const body = presentBroadcast({ ...row, status: "paused" });
    expect(body).toMatchObject({
      object: "broadcast",
      id: "broadcast_1",
      from: "Acme <hello@example.com>",
      segment_id: "segment_1",
      audience_id: "segment_1",
      reply_to: null,
      preview_text: null,
      status: "queued",
      paused: true,
      scheduled_at: null,
      sent_at: null,
    });
    expect(presentBroadcast({ ...row, from_name: null, reply_to: ["r@example.com"] })).toMatchObject({
      from: "hello@example.com",
      reply_to: ["r@example.com"],
    });
  });

  it("leaves content out of list rows", () => {
    const summary = presentBroadcastSummary(row);
    expect(summary).not.toHaveProperty("html");
    expect(summary).toMatchObject({ object: "broadcast", id: "broadcast_1", status: "draft", segment_id: "segment_1" });
  });

  it("names a duplicate '<name> (copy)' and cuts it to 70 characters", () => {
    expect(copyName("Launch")).toBe("Launch (copy)");
    expect(copyName("x".repeat(70))).toHaveLength(70);
  });
});

describe("broadcast writes", () => {
  it("checks the segment and splits a friendly from on create", async () => {
    const db = client((sql) => (sql.startsWith("insert") ? { rows: [row] } : { rows: [{ id: "segment_1" }] }));
    await createBroadcast(db, "tenant_1", "req_1", {
      segment_id: "segment_1",
      from: "Acme <hello@example.com>",
      subject: "Hi",
      html: "<p>Hi</p>",
    });
    expect(db.queries[0].sql).toContain("from segments");
    const insert = db.queries.find((query) => query.sql.startsWith("insert"))!;
    expect(insert.params[2]).toBe("Hi");
    expect(insert.params[3]).toBe("hello@example.com");
    expect(insert.params[4]).toBe("Acme");
    expect(insert.params[14]).toBe("segment_1");
    expect(insert.params[15]).toBe("req_1");
  });

  it("fails create when the segment does not exist", async () => {
    const db = client(() => ({ rows: [] }));
    await expect(
      createBroadcast(db, "tenant_1", "req_1", { segment_id: "segment_x", from: "a@example.com", subject: "Hi" }),
    ).rejects.toMatchObject({ name: "not_found", statusCode: 404 });
  });

  it("refuses to update a broadcast that is not a draft", async () => {
    const db = client(() => ({ rows: [{ ...row, status: "sending" }] }));
    await expect(updateBroadcast(db, "tenant_1", "broadcast_1", { name: "New" })).rejects.toMatchObject({
      name: "validation_error",
    });
  });

  it("sends now or schedules for later, only from draft", async () => {
    const now = Date.parse("2026-10-01T00:00:00.000Z");
    const db = client((sql, params) => {
      if (sql.includes("from domains")) return { rows: [{ sending: "enabled" }] };
      return sql.startsWith("update") ? { rows: [{ ...row, status: params[3], scheduled_at: params[4] }] } : { rows: [row] };
    });
    const later = new Date(now + 3_600_000);
    const scheduled = await sendBroadcast(db, "tenant_1", "broadcast_1", { scheduledAt: later, requestId: "req_2", now });
    expect(scheduled.status).toBe("scheduled");
    const update = db.queries.find((query) => query.sql.startsWith("update"))!;
    // The sample render and the domain check both come before the status changes.
    expect(db.queries.findIndex((query) => query.sql.includes("from domains"))).toBeLessThan(db.queries.indexOf(update));
    expect(update.sql).toContain("status = any($3::text[])");
    expect(update.params).toEqual(["tenant_1", "broadcast_1", ["draft"], "scheduled", later, "req_2"]);

    const unverified = client((sql) => (sql.includes("from domains") ? { rows: [] } : { rows: [row] }));
    await expect(sendBroadcast(unverified, "tenant_1", "broadcast_1", { requestId: "req_5" })).rejects.toMatchObject({
      statusCode: 403,
      message: "Sender domain is not verified",
    });
    expect(unverified.queries.some((query) => query.sql.startsWith("update"))).toBe(false);

    const immediate = await sendBroadcast(db, "tenant_1", "broadcast_1", { scheduledAt: null, requestId: "req_3", now });
    expect(immediate.status).toBe("sending");

    const sent = client(() => ({ rows: [{ ...row, status: "sent" }] }));
    await expect(sendBroadcast(sent, "tenant_1", "broadcast_1", { requestId: "req_4" })).rejects.toMatchObject({
      name: "validation_error",
    });
  });

  it("refuses a broadcast whose content needs a value that no recipient would get", async () => {
    const draft = (html: string) =>
      client((sql) => {
        if (sql.includes("from domains")) return { rows: [{ sending: "enabled" }] };
        if (sql.includes("from tenants")) return { rows: [{ name: "Acme", brand: {}, domain: "example.com" }] };
        return { rows: [{ ...row, html, text: null, declared: null }] };
      });
    // A brand value that was never set fails every recipient the same way.
    const address = draft("<p>{{{COMPANY_ADDRESS}}}</p>");
    await expect(sendBroadcast(address, "tenant_1", "broadcast_1", { requestId: "req_6" })).rejects.toMatchObject({
      statusCode: 422,
      message: "The broadcast uses COMPANY_ADDRESS, which the brand settings do not set. Add it under Settings, Brand, or remove it from the content.",
    });
    expect(address.queries.some((query) => query.sql.startsWith("update"))).toBe(false);
    // So does a variable nothing supplies.
    await expect(sendBroadcast(draft("<p>{{{PROMO_CODE}}}</p>"), "tenant_1", "broadcast_1", { requestId: "req_7" })).rejects.toMatchObject({
      statusCode: 422,
      message: "The broadcast uses PROMO_CODE and nothing gives it a value. Add a fallback, or pass it in variables.",
    });
    // So does one inside a block that tests a contact field, on either side of the test.
    await expect(sendBroadcast(draft("<p>{{{#unless contact.first_name}}}{{{GREETING}}}{{{/unless}}}</p>"), "tenant_1", "broadcast_1", { requestId: "req_9" })).rejects.toMatchObject({
      message: "The broadcast uses GREETING and nothing gives it a value. Add a fallback, or pass it in variables.",
    });
    await expect(sendBroadcast(draft("<p>{{{#if contact.plan}}}{{{PROMO}}}{{{/if}}}</p>"), "tenant_1", "broadcast_1", { requestId: "req_10" })).rejects.toMatchObject({
      message: "The broadcast uses PROMO and nothing gives it a value. Add a fallback, or pass it in variables.",
    });
    // A contact property depends on the contact, so it does not stop the send.
    const property = draft("<p>{{{contact.plan}}} {{{FIRST_NAME}}}</p>");
    await expect(sendBroadcast(property, "tenant_1", "broadcast_1", { requestId: "req_8" })).resolves.toBeTruthy();
  });

  it("sends a contact with no first name a blank where the name goes", () => {
    const content = { ...row, subject: "Hi {{{contact.first_name}}}", html: "<p>Hi {{{FIRST_NAME}}} {{{contact.last_name}}}</p>", text: "{{{contact.plan}}}" };
    const rendered = renderBroadcast(content, { email: "ada@example.com", first_name: null, last_name: null, properties: {} }, {}, "https://example.com/u");
    expect(rendered).toEqual({ subject: "Hi ", html: "<p>Hi  </p>", text: "" });
    // Any other missing value still fails the recipient.
    expect(() => renderBroadcast({ ...content, text: "{{{PROMO}}}" }, { email: "ada@example.com", first_name: null, last_name: null, properties: {} }, {}, "https://example.com/u")).toThrow(
      "Missing template variable: PROMO",
    );
  });

  it("renders a test send the way the worker renders a recipient", async () => {
    const db = client((sql) => {
      if (sql.includes("from tenants")) return { rows: [{ name: "Acme", brand: { product_name: "Acme" }, domain: "example.com" }] };
      return { rows: [{ ...row, subject: "Hi {{{FIRST_NAME}}}", html: "<body><p>{{{contact.first_name}}} at {{{PRODUCT_NAME}}} <a href=\"{{{DISPATCH_UNSUBSCRIBE_URL}}}\">x</a></p></body>", text: null, preview_text: "Soon", declared: null }] };
    });
    // Its own tenant: the brand is cached per tenant for a few seconds.
    const sample = await previewBroadcast(db, "tenant_2", "broadcast_1");
    expect(sample.subject).toBe("Hi Ada");
    expect(sample.html).toContain("Ada at Acme");
    expect(sample.html).toContain("https://example.com/unsubscribe");
    expect(sample.html).toContain(">Soon</div>");
    const custom = await previewBroadcast(db, "tenant_2", "broadcast_1", { FIRST_NAME: "Grace", contact: { first_name: "Grace" } });
    expect(custom.subject).toBe("Hi Grace");
    expect(custom.html).toContain("Grace at Acme");
  });

  it("refuses to send a draft with no content", async () => {
    const db = client(() => ({ rows: [{ ...row, html: null, text: null }] }));
    await expect(sendBroadcast(db, "tenant_1", "broadcast_1", { requestId: "req_1" })).rejects.toMatchObject({
      name: "validation_error",
    });
  });

  it("returns a scheduled broadcast to draft on cancel and cancels queued recipients of a sending one", async () => {
    const draft = client(() => ({ rows: [{ ...row, status: "draft" }] }));
    await cancelBroadcast(draft, "tenant_1", "broadcast_1");
    expect(draft.queries[0].sql).toContain("when status = 'scheduled' then 'draft'");
    expect(draft.queries[0].params[2]).toEqual(["scheduled", "sending", "paused"]);
    expect(draft.queries).toHaveLength(1);

    const sending = client(() => ({ rows: [{ ...row, status: "cancelled" }] }));
    await cancelBroadcast(sending, "tenant_1", "broadcast_1");
    expect(sending.queries[1].sql).toContain("update broadcast_recipients set status = 'cancelled'");
    // Emails already created and not yet sent are cancelled with it, and so are their jobs.
    expect(sending.queries[2].sql).toContain("update send_jobs j set state = 'cancelled'");
    expect(sending.queries[3].sql).toContain("update emails set status = 'cancelled'");
    expect(sending.queries[3].sql).toContain("status in ('queued', 'scheduled')");
  });

  it("reports not found before a bad state when a transition matches nothing", async () => {
    const missing = client(() => ({ rows: [] }));
    await expect(deleteBroadcast(missing, "tenant_1", "broadcast_x")).rejects.toMatchObject({ name: "not_found" });

    const sent = client((sql) => (sql.startsWith("update") ? { rows: [] } : { rows: [{ ...row, status: "sent" }] }));
    await expect(deleteBroadcast(sent, "tenant_1", "broadcast_1")).rejects.toMatchObject({
      name: "validation_error",
      message: "Only draft or scheduled broadcasts can be deleted",
    });
    expect(sent.queries[0].params[2]).toEqual(["draft", "scheduled", "cancelled"]);
  });
});

describe("broadcast worker queries", () => {
  it("marks a chunk of recipients in one statement", async () => {
    const db = client(() => ({ rows: [] }));
    await markRecipients(db, "tenant_1", [
      { id: "br_1", status: "sent", email_id: "email_1" },
      { id: "br_2", status: "failed", error: "Missing template variable: FIRST_NAME" },
    ]);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain("unnest");
    expect(db.queries[0].params).toEqual([
      "tenant_1",
      ["br_1", "br_2"],
      ["sent", "failed"],
      ["email_1", null],
      [null, "Missing template variable: FIRST_NAME"],
    ]);
    await markRecipients(db, "tenant_1", []);
    expect(db.queries).toHaveLength(1);
  });

  it("recalculates the sent count under a lock before finishing a chunk", async () => {
    const db = client(() => ({ rows: [{ status: "sent" }] }));
    expect(await finishChunk(db, "tenant_1", "broadcast_1")).toBe("sent");
    expect(db.queries[0]).toEqual({
      sql: "select id from broadcasts where tenant_id = $1 and id = $2 for update",
      params: ["tenant_1", "broadcast_1"],
    });
    expect(db.queries[1].sql).toContain("sent_count = (");
    expect(db.queries[1].sql).toContain("ev.type = 'email.sent'");
    expect(db.queries[1].sql).not.toContain("sent_count +");
    expect(db.queries[2].sql).toContain("coalesce(b.sent_at, now())");
  });
});

describe("recipients and clicked links", () => {
  it("filters recipients by event type, bounce type, and email with parameters from $2", () => {
    const filter = recipientFilter("broadcast_1", { type: "bounced", bounce_type: "Permanent", email: "ad%a" });
    expect(filter.params).toEqual(["broadcast_1", "email.bounced", "Permanent", "%ad\\%a%"]);
    expect(filter.where).toContain("br.broadcast_id = $2");
    expect(filter.where).toContain("ev.type = $3");
    expect(filter.where).toContain("lower($4)");
    expect(filter.where).toContain("br.email ilike $5");
  });

  it("reads unsubscribed recipients from the recipient row", () => {
    const filter = recipientFilter("broadcast_1", { type: "unsubscribed" });
    expect(filter.where).toContain("br.unsubscribed_at is not null");
    expect(filter.params).toEqual(["broadcast_1"]);
  });

  it("counts who a send would reach and why the rest are left out", async () => {
    const counts = { total: 10, recipients: 6, unsubscribed: 2, suppressed: 1, opted_out: 1, no_first_name: 3, no_last_name: 4 };
    const db = client(() => ({ rows: [counts] }));
    const audience = await broadcastAudience(db, "tenant_1", { segmentId: "segment_1", topicId: null });
    expect(audience).toEqual({ object: "broadcast_audience", ...counts });
    expect(db.queries[0].params).toEqual(["tenant_1", "segment_1", null]);
    expect(db.queries[0].sql).toContain("lower(sup.email) = lower(c.email)");
    expect(db.queries[0].sql).toContain("c.deleted_at is null");
    // The name counts are of recipients only, and an empty name counts as none.
    expect(db.queries[0].sql).toContain("topic_ok and no_first_name");
    expect(db.queries[0].sql).toContain("coalesce(trim(c.first_name), '') = ''");

    const empty = client(() => ({ rows: [] }));
    expect((await broadcastAudience(empty, "tenant_1", { segmentId: null, topicId: null })).recipients).toBe(0);
  });

  it("rejects an unknown type", () => {
    expect(() => recipientFilter("broadcast_1", { type: "nope" })).toThrow("Unknown recipient type");
  });

  it("groups clicks by link, most clicked first", async () => {
    const db = client(() => ({ rows: [{ id: "link_a", url: "https://a.example", clicks: 3, unique_clicks: 2 }] }));
    const rows = await clickedLinks(db, "tenant_1", "broadcast_1");
    expect(rows[0]).toEqual({ object: "clicked_link", id: "link_a", url: "https://a.example", clicks: 3, unique_clicks: 2 });
    expect(db.queries[0].sql).toContain("order by clicks desc");
    expect(db.queries[0].sql).toContain("ev.data->'click'->>'link'");
    expect(db.queries[0].params).toEqual(["tenant_1", "broadcast_1"]);
  });
});
