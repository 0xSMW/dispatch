import { describe, expect, it, vi } from "vitest";
import { prepareTracking } from "@dispatchmail/core";
import { readUnsubscribeToken, type Db } from "@dispatchmail/db";
import { contactContext, renderBroadcast, sendBroadcasts, withPreview } from "./broadcasts.js";

const options = { publicUrl: "https://api.test", appUrl: "https://app.test", secret: "test-secret" };

type Recipient = { id: string; contact_id: string; email: string; first_name: string | null; status: string; email_id?: string | null; error?: string | null };

// An in-memory stand-in for the handful of statements the broadcast worker issues.
function fakeDb(count: number, overrides: Record<string, unknown> = {}) {
  const broadcast = {
    tenant_id: "tenant_1",
    id: "broadcast_1",
    name: "Launch",
    from_email: "hello@example.com",
    from_name: "Acme",
    reply_to: [],
    subject: "Hi {{{contact.first_name|there}}}",
    preview_text: null,
    html: '<p>Hello {{{FIRST_NAME|friend}}}</p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a>',
    text: null,
    template_id: null,
    template_version_id: null,
    variables: {},
    topic_id: null,
    segment_id: "segment_1",
    status: "sending",
    recipient_count: count,
    sent_count: 0,
    request_id: "req_send",
    scheduled_at: null as Date | null,
    declared: null,
    sent_at: null as Date | null,
    ...overrides,
  };
  const failures: string[] = [];
  const sandboxEmails = new Set<string>();
  const recipients: Recipient[] = Array.from({ length: count }, (_, index) => ({
    id: `br_${String(index).padStart(4, "0")}`,
    contact_id: `contact_${index}`,
    email: `user${index}@example.net`,
    first_name: index % 2 === 0 ? `User${index}` : null,
    status: "queued",
  }));

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
    if (sql === "select id from broadcasts where tenant_id = $1 and id = $2 for update") return { rows: [{ id: broadcast.id }] };
    if (sql.includes("sent_count = (")) {
      broadcast.sent_count = recipients.filter((row) => row.status === "sent" && !sandboxEmails.has(row.email_id!)).length;
      return { rows: [] };
    }
    if (sql.includes("for update of b skip locked")) {
      const due = broadcast.status === "sending" || (broadcast.status === "scheduled" && broadcast.scheduled_at! <= new Date());
      return { rows: due && !(params[0] as string[]).includes(broadcast.id) ? [{ ...broadcast }] : [] };
    }
    if (sql.includes("failures = failures + 1")) {
      failures.push(String(params[1]));
      return { rows: [] };
    }
    if (sql.startsWith("update broadcasts set status = 'sending'")) {
      broadcast.status = "sending";
      return { rows: [] };
    }
    if (sql.includes("select exists (select 1 from broadcast_recipients")) return { rows: [{ found: recipients.length > 0 }] };
    if (sql.includes("from broadcast_recipients br")) {
      const queued = recipients.filter((row) => row.status === "queued").slice(0, params[2] as number);
      return { rows: queued.map((row) => ({ ...row, last_name: null, properties: { plan: "pro" }, skip: false })) };
    }
    if (sql.includes("from tenants")) return { rows: [{ name: "Acme", brand: {} }] };
    if (sql.includes("from domains")) return { rows: [{ name: "example.com" }] };
    if (sql.includes("update broadcast_recipients br")) {
      const [, ids, statuses, emailIds, errors] = params as [string, string[], string[], Array<string | null>, Array<string | null>];
      ids.forEach((recipientId, index) => {
        const row = recipients.find((item) => item.id === recipientId)!;
        row.status = statuses[index];
        row.email_id = emailIds[index];
        row.error = errors[index];
      });
      return { rows: [] };
    }
    if (sql.includes("update broadcasts b set")) {
      if (!recipients.some((row) => row.status === "queued")) {
        broadcast.status = "sent";
        broadcast.sent_at = new Date();
      }
      return { rows: [{ status: broadcast.status }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const db = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Db;
  return { db, broadcast, recipients, query, failures, sandboxEmails };
}

function ingest() {
  let next = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn(async (_client: unknown, _input: Record<string, any>) => ({ email: { id: `email_${next++}`, status: "queued" } }));
}

describe("sendBroadcasts", () => {
  it("keeps simulated emails inspectable without counting them as real sends", async () => {
    const { db, broadcast, recipients, sandboxEmails } = fakeDb(2);
    const send = vi.fn(async (_client: unknown, input: { to: string }) => {
      const email = { id: `email_${input.to}`, status: "queued", sandbox: input.to === "user0@example.net" };
      if (email.sandbox) sandboxEmails.add(email.id);
      return { email };
    });
    await sendBroadcasts(db, { ...options, ingest: send as never });
    expect(recipients.every((row) => row.email_id)).toBe(true);
    expect(broadcast.status).toBe("sent");
    expect(broadcast.sent_count).toBe(1);
  });
  it("sends one chunk of 200 per tick and stops between chunks while paused", async () => {
    const { db, broadcast, recipients } = fakeDb(450);
    const send = ingest();

    expect(await sendBroadcasts(db, { ...options, ingest: send as never })).toBe(1);
    expect(send).toHaveBeenCalledTimes(200);
    expect(recipients.filter((row) => row.status === "sent")).toHaveLength(200);
    expect(broadcast.status).toBe("sending");

    broadcast.status = "paused";
    expect(await sendBroadcasts(db, { ...options, ingest: send as never })).toBe(0);
    expect(send).toHaveBeenCalledTimes(200);

    broadcast.status = "sending";
    await sendBroadcasts(db, { ...options, ingest: send as never });
    expect(send).toHaveBeenCalledTimes(400);
    expect(broadcast.status).toBe("sending");

    await sendBroadcasts(db, { ...options, ingest: send as never });
    expect(send).toHaveBeenCalledTimes(450);
    expect(broadcast.status).toBe("sent");
    expect(broadcast.sent_count).toBe(450);
    expect(recipients.every((row) => row.status === "sent" && row.email_id)).toBe(true);
  });

  it("starts a due scheduled broadcast and leaves a future one alone", async () => {
    const future = fakeDb(3, { status: "scheduled", scheduled_at: new Date(Date.now() + 60_000) });
    expect(await sendBroadcasts(future.db, { ...options, ingest: ingest() as never })).toBe(0);

    const due = fakeDb(3, { status: "scheduled", scheduled_at: new Date(Date.now() - 1_000) });
    expect(await sendBroadcasts(due.db, { ...options, ingest: ingest() as never })).toBe(1);
    expect(due.broadcast.status).toBe("sent");
  });

  it("renders per contact and adds one-click unsubscribe headers to every email", async () => {
    const { db } = fakeDb(2);
    const send = ingest();
    await sendBroadcasts(db, { ...options, ingest: send as never });

    const first = send.mock.calls[0][1];
    expect(first).toMatchObject({
      tenantId: "tenant_1",
      requestId: "req_send",
      to: "user0@example.net",
      from: "hello@example.com",
      fromName: "Acme",
      subject: "Hi User0",
      broadcastId: "broadcast_1",
      tags: { broadcast_id: "broadcast_1" },
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    expect(first.html).toContain("Hello User0");
    const header = first.headers["List-Unsubscribe"] as string;
    const token = decodeURIComponent(header.match(/^<https:\/\/api\.test\/unsubscribe\/(.+)>$/)![1]);
    expect(readUnsubscribeToken(token, options.secret)).toEqual({
      use: "unsub",
      tenant_id: "tenant_1",
      contact_id: "contact_0",
      broadcast_id: "broadcast_1",
      email: null,
      email_id: first.emailId,
      topic_id: null,
    });
    expect(first.html).toContain(`https://app.test/unsubscribe?token=${encodeURIComponent(token)}`);

    const second = send.mock.calls[1][1];
    expect(second.subject).toBe("Hi there");
    expect(second.html).toContain("Hello friend");
  });

  it("sends a contact with no first name a blank where the name goes", async () => {
    const { db, recipients } = fakeDb(2, { subject: "Hi {{{FIRST_NAME}}}", html: "<p>Hello {{{contact.first_name}}}</p>" });
    const send = ingest();
    await sendBroadcasts(db, { ...options, ingest: send as never });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toMatchObject({ subject: "Hi ", html: "<p>Hello </p>" });
    expect(recipients.every((row) => row.status === "sent")).toBe(true);
  });

  it("marks a recipient failed when its content cannot render and sends the rest", async () => {
    const { db, recipients } = fakeDb(2, { subject: "Hi {{{#if contact.first_name}}}{{{PROMO}}}{{{/if}}}" });
    const send = ingest();
    await sendBroadcasts(db, { ...options, ingest: send as never });
    expect(send).toHaveBeenCalledTimes(1);
    expect(recipients[0]).toMatchObject({ status: "failed", error: "Missing template variable: PROMO" });
    expect(recipients[1].status).toBe("sent");
  });

  it("records an address that was suppressed since the snapshot as skipped, not sent", async () => {
    const { db, recipients, broadcast } = fakeDb(2);
    const send = vi.fn(async (_client: unknown, input: { to: string }) => ({
      email: { id: `email_${input.to}`, status: input.to === "user0@example.net" ? "suppressed" : "queued" },
    }));
    await sendBroadcasts(db, { ...options, ingest: send as never });
    expect(recipients[0]).toMatchObject({ status: "skipped", error: "Suppressed" });
    expect(recipients[1].status).toBe("sent");
    expect(broadcast.sent_count).toBe(1);
  });

  it("counts a failure on the broadcast and keeps going when a chunk throws", async () => {
    const { db, failures, recipients } = fakeDb(3);
    const errors: Array<string | null> = [];
    const send = vi.fn(async () => {
      throw new Error("statement timeout");
    });
    const sent = await sendBroadcasts(db, { ...options, ingest: send as never, onError: (broadcastId) => errors.push(broadcastId) });
    expect(sent).toBe(0);
    expect(errors).toEqual(["broadcast_1"]);
    expect(failures).toEqual(["statement timeout"]);
    // The chunk's transaction rolled back, so nobody was marked.
    expect(recipients.every((row) => row.status === "queued")).toBe(true);
  });

  it("passes the backlog limit to the claim, so emails are created only as fast as they are delivered", async () => {
    const { db, query } = fakeDb(1);
    await sendBroadcasts(db, { ...options, ingest: ingest() as never, backlog: 50 });
    const claim = query.mock.calls.find((call) => String(call[0]).includes("for update of b skip locked"));
    expect(String(claim?.[0])).toContain("j.state in ('ready', 'running')");
    expect((claim?.[1] as unknown[])[1]).toBe(50);
  });
});

describe("broadcast rendering", () => {
  const recipient = { email: "ada@example.com", first_name: "Ada", last_name: null, properties: { plan: "pro" } };

  it("exposes contact fields, properties, and the three unsubscribe names", () => {
    const context = contactContext(recipient, "https://app.test/unsubscribe?token=t");
    expect(context.contact).toEqual({ plan: "pro", email: "ada@example.com", first_name: "Ada", last_name: undefined });
    expect(context.RESEND_UNSUBSCRIBE_URL).toBe("https://app.test/unsubscribe?token=t");
    expect(context.DISPATCH_UNSUBSCRIBE_URL).toBe(context.UNSUBSCRIBE_URL);
    expect(context.FIRST_NAME).toBe("Ada");
  });

  it("lets broadcast variables win over context and escapes values in html", () => {
    const rendered = renderBroadcast(
      { subject: "{{{contact.plan}}} for {{{EMAIL}}}", html: "<p>{{{greeting}}} {{{contact.first_name}}}</p>", text: null, variables: { greeting: "<b>Hi</b>" }, declared: null, preview_text: null },
      recipient,
      {},
      "https://app.test/unsubscribe?token=t",
    );
    expect(rendered.subject).toBe("pro for ada@example.com");
    expect(rendered.html).toBe("<p>&lt;b&gt;Hi&lt;/b&gt; Ada</p>");
  });

  it("inserts preview text as a hidden block after the body tag", () => {
    expect(withPreview("<html><body class=x><p>Hi</p></body></html>", "Read <this>")).toBe(
      '<html><body class=x><div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Read &#60;this&#62;</div><p>Hi</p></body></html>',
    );
    expect(withPreview("<p>Hi</p>", null)).toBe("<p>Hi</p>");
  });

  it("leaves the unsubscribe link alone when click tracking rewrites links", () => {
    const html = '<a href="https://example.com/pricing">Pricing</a><a href="https://app.test/unsubscribe?token=abc.def">Unsubscribe</a>';
    const tracked = prepareTracking(html, { baseUrl: "https://api.test", clicks: true });
    expect(tracked.html).toContain('href="https://app.test/unsubscribe?token=abc.def"');
    expect(tracked.html).not.toContain("https://example.com/pricing");
    expect(tracked.tokens).toHaveLength(1);
  });
});
