import { describe, expect, it, vi } from "vitest";
import { seal } from "@dispatchmail/core";
import {
  applyUnsubscribe,
  oneClick,
  readUnsubscribeToken,
  unsubscribeHeaders,
  unsubscribeLinks,
  unsubscribeToken,
} from "./unsubscribe.js";

const secret = "test-secret";
const payload = { use: "unsub" as const, tenant_id: "tenant_1", contact_id: "contact_1", broadcast_id: "broadcast_1" };

function client(handler: (sql: string, params: unknown[]) => { rows: unknown[] }) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return handler(sql, params);
    }),
  };
}

describe("unsubscribe tokens", () => {
  it("round trips without an expiry", () => {
    const token = unsubscribeToken(payload, secret);
    expect(readUnsubscribeToken(token, secret)).toEqual(payload);
    const body = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    expect(body).not.toHaveProperty("exp");
  });

  it("rejects a token sealed for another purpose, a tampered token, and a wrong secret", () => {
    const share = seal({ use: "share", tenant_id: "tenant_1", contact_id: "contact_1" }, secret);
    expect(readUnsubscribeToken(share, secret)).toBeNull();
    const token = unsubscribeToken(payload, secret);
    const forged = Buffer.from(JSON.stringify({ ...payload, tenant_id: "tenant_2" })).toString("base64url");
    expect(readUnsubscribeToken(`${forged}.${token.split(".")[1]}`, secret)).toBeNull();
    expect(readUnsubscribeToken(token, "other-secret")).toBeNull();
  });

  it("builds the page link, the one-click link, and the RFC 8058 headers", () => {
    const links = unsubscribeLinks("abc.def", { appUrl: "https://app.example/", publicUrl: "https://api.example" });
    expect(links).toEqual({
      page: "https://app.example/unsubscribe?token=abc.def",
      oneClick: "https://api.example/unsubscribe/abc.def",
    });
    expect(unsubscribeHeaders(links.oneClick)).toEqual({
      "List-Unsubscribe": "<https://api.example/unsubscribe/abc.def>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("recognizes a one-click body as a parsed form or a raw string", () => {
    expect(oneClick({ "List-Unsubscribe": "One-Click" })).toBe(true);
    expect(oneClick("List-Unsubscribe=One-Click")).toBe(true);
    expect(oneClick({ unsubscribe_all: true })).toBe(false);
    expect(oneClick(undefined)).toBe(false);
    // RFC 8058 prefers multipart. The body arrives as its raw text.
    const multipart = '--b\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--b--\r\n';
    expect(oneClick(multipart)).toBe(true);
    expect(oneClick('--b\r\nContent-Disposition: form-data; name="other"\r\n\r\nOne-Click\r\n--b--')).toBe(false);
  });
});

describe("applyUnsubscribe", () => {
  const contact = { id: "contact_1", email: "ada@example.com", unsubscribed_at: null };

  it("opts out of the broadcast's topic on one-click", async () => {
    const db = client((sql) => {
      if (sql.includes("from contacts")) return { rows: [contact] };
      if (sql.includes("from broadcasts")) return { rows: [{ topic_id: "topic_news" }] };
      if (sql.includes("from topics t")) return { rows: [] };
      if (sql.includes("from topics")) return { rows: [{ id: "topic_news" }] };
      if (sql.includes("insert into topic_subscriptions")) return { rows: [{ topic_id: "topic_news", status: "unsubscribed" }] };
      return { rows: [] };
    });
    const change = await applyUnsubscribe(db, payload, { kind: "one_click" });
    expect(change).toEqual({ type: "contact.topics.updated", contact: { id: "contact_1", email: "ada@example.com" } });
    const upsert = db.queries.find((query) => query.sql.includes("insert into topic_subscriptions"))!;
    expect(upsert.params.slice(1)).toEqual(["tenant_1", "topic_news", "contact_1", "unsubscribed"]);
    expect(db.queries.some((query) => query.sql.includes("update broadcast_recipients set unsubscribed_at"))).toBe(true);
    expect(db.queries.some((query) => query.sql.includes("update contacts"))).toBe(false);
  });

  it("records the unsubscribe on the broadcast's email, which the metric counts", async () => {
    const db = client((sql) => {
      if (sql.includes("from contacts")) return { rows: [contact] };
      if (sql.includes("from broadcasts")) return { rows: [{ topic_id: null }] };
      if (sql.includes("update broadcast_recipients")) return { rows: [{ email_id: "email_9" }] };
      if (sql.includes("insert into email_events")) return { rows: [{ id: "event_1", tenant_id: "tenant_1", request_id: null, email_id: "email_9", type: "email.unsubscribed", data: {} }] };
      return { rows: [] };
    });
    await applyUnsubscribe(db, payload, { kind: "one_click" });
    const event = db.queries.find((query) => query.sql.includes("insert into email_events"))!;
    expect(event.params[3]).toBe("email_9");
    expect(event.params[5]).toBe("email.unsubscribed");
    // One event per email, however many times the link is used.
    expect(event.params[6]).toBe("email_9:unsubscribed");
  });

  it("treats a deleted topic as no topic, so an old one-click link still works", async () => {
    const db = client((sql) => {
      if (sql.includes("from contacts")) return { rows: [contact] };
      if (sql.includes("from broadcasts b")) return { rows: [{ topic_id: null }] };
      return { rows: [] };
    });
    const change = await applyUnsubscribe(db, payload, { kind: "one_click" });
    expect(change.type).toBe("contact.updated");
    expect(db.queries.find((query) => query.sql.includes("from broadcasts b"))!.sql).toContain("t.deleted_at is null");
  });

  it("unsubscribes from everything on one-click when the broadcast has no topic", async () => {
    const db = client((sql) => {
      if (sql.includes("from contacts")) return { rows: [contact] };
      if (sql.includes("from broadcasts")) return { rows: [{ topic_id: null }] };
      return { rows: [] };
    });
    const change = await applyUnsubscribe(db, payload, { kind: "one_click" });
    expect(change.type).toBe("contact.updated");
    expect(db.queries.some((query) => query.sql.includes("unsubscribed_at = coalesce(unsubscribed_at, now())"))).toBe(true);
  });

  it("refuses a topic the contact cannot see", async () => {
    const db = client((sql) => {
      if (sql.includes("from contacts")) return { rows: [contact] };
      if (sql.includes("from broadcasts")) return { rows: [{ topic_id: null }] };
      if (sql.includes("from topics t")) return { rows: [{ id: "topic_public", name: "News", description: null, visibility: "public", status: "subscribed" }] };
      return { rows: [] };
    });
    await expect(
      applyUnsubscribe(db, payload, { kind: "topics", topics: [{ id: "topic_private", subscription: "opt_in" }] }),
    ).rejects.toMatchObject({ name: "not_found" });
  });

  it("fails with not_found for a deleted contact", async () => {
    const db = client(() => ({ rows: [] }));
    await expect(applyUnsubscribe(db, payload, { kind: "all" })).rejects.toMatchObject({ name: "not_found" });
  });
});
