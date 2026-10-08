import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { brandContext, type BrandRecord } from "@dispatchmail/core";
import { clearBrandCache, unsubscribeToken, type Db } from "@dispatchmail/db";
import { registerUnsubscribe, unsubscribeAction } from "./unsubscribe.js";

const secret = "test-secret";

describe("unsubscribeAction", () => {
  it("reads one-click, topic changes, and unsubscribe all", () => {
    expect(unsubscribeAction({ "List-Unsubscribe": "One-Click" })).toEqual({ kind: "one_click" });
    expect(unsubscribeAction({ unsubscribe_all: true })).toEqual({ kind: "all" });
    expect(unsubscribeAction({ topics: [{ id: "topic_1", subscription: "opt_out" }] })).toEqual({
      kind: "topics",
      topics: [{ id: "topic_1", subscription: "opt_out" }],
    });
  });

  it("rejects an empty or unknown body", () => {
    expect(() => unsubscribeAction(undefined)).toThrow();
    expect(() => unsubscribeAction({ unsubscribe_all: false })).toThrow();
    expect(() => unsubscribeAction({ topics: [] })).toThrow();
  });
});

function fakeDb(topicId: string | null, options: { deadlocks?: number; topicStatus?: string; brand?: BrandRecord } = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let contact = {
    id: "contact_1", email: "ada@example.com", first_name: "Ada", last_name: null, properties: {},
    unsubscribed_at: null as string | null, deleted_at: null,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
  let topicStatus = options.topicStatus ?? "subscribed";
  const committed = { history: [] as unknown[][], events: [] as string[] };
  let snapshot: { contact: typeof contact; topicStatus: string; committed: typeof committed };
  let deadlocks = options.deadlocks ?? 0;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql === "begin") snapshot = structuredClone({ contact, topicStatus, committed });
    if (sql === "rollback") {
      contact = snapshot.contact;
      topicStatus = snapshot.topicStatus;
      Object.assign(committed, snapshot.committed);
    }
    if (sql.includes("from contacts")) return { rows: [{ ...contact }] };
    if (sql.includes("update contacts")) {
      contact = { ...contact, unsubscribed_at: "2026-10-03T00:00:00Z" };
      return { rows: [{ ...contact }] };
    }
    if (sql.includes("from broadcasts")) return { rows: [{ topic_id: topicId }] };
    if (sql.includes("as before from topics")) return { rows: [{ id: "topic_news", before: topicStatus }] };
    if (sql.includes("from topics t")) {
      return { rows: [{ id: "topic_news", name: "News", description: "Weekly", visibility: "public", status: topicStatus }] };
    }
    if (sql.includes("from topics")) return { rows: [{ id: "topic_news" }] };
    if (sql.includes("insert into topic_subscriptions")) {
      topicStatus = String(params[4]);
      return { rows: [{ topic_id: "topic_news", status: topicStatus }] };
    }
    if (sql.includes("insert into email_events")) {
      if (deadlocks-- > 0) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      committed.events.push(String(params[5]));
      return { rows: [{ id: "event_1", tenant_id: "tenant_1", request_id: params[2], email_id: null, type: params[5], data: {} }] };
    }
    if (sql.includes("insert into contact_changes")) committed.history.push(params.slice(3, 6));
    if (sql.includes("from tenants")) return { rows: [{ name: "Acme", brand: options.brand ?? { color: "#ffffff" } }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const db = { query, connect } as unknown as Db;
  return { db, queries, committed, connect, release };
}

async function app(db: Db) {
  clearBrandCache("tenant_1");
  const server = Fastify({ maxParamLength: 1024 });
  server.addHook("onRequest", async (request) => {
    request.request_id = "req_test";
  });
  registerUnsubscribe(server, { db, secret });
  await server.ready();
  return server;
}

describe("unsubscribe routes", () => {
  const token = unsubscribeToken({ tenant_id: "tenant_1", contact_id: "contact_1", broadcast_id: "broadcast_1" }, secret);

  it.each([
    [{ unsubscribe_all: true }, "subscribed", ["unsubscribed", "false", "true"], "contact.updated"],
    [{ topics: [{ id: "topic_news", subscription: "opt_in" }] }, "unsubscribed", ["topics.topic_news", "false", "true"], "contact.topics.updated"],
  ])("retries a complete public preference transaction for %j", async (payload, topicStatus, history, event) => {
    const { db, queries, committed, connect, release } = fakeDb("topic_news", { deadlocks: 1, topicStatus });
    const server = await app(db);
    const response = await server.inject({ method: "POST", url: `/unsubscribe/${token}`, payload });
    expect(response.statusCode).toBe(200);
    expect(committed.history).toEqual([history]);
    expect(committed.events).toEqual([event]);
    expect(queries.filter((query) => ["begin", "rollback", "commit"].includes(query.sql)).map((query) => query.sql)).toEqual(["begin", "rollback", "begin", "commit"]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("returns 500 on exhausted deadlocks without committing unsubscribe or history", async () => {
    const { db, queries, committed, connect, release } = fakeDb(null, { deadlocks: 4 });
    const server = await app(db);
    const response = await server.inject({ method: "POST", url: `/unsubscribe/${token}`, payload: { unsubscribe_all: true } });
    expect(response.statusCode).toBe(500);
    expect(committed.history).toEqual([]);
    expect(committed.events).toEqual([]);
    expect(queries.filter((query) => query.sql === "rollback")).toHaveLength(4);
    expect(queries.some((query) => query.sql === "commit")).toBe(false);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledTimes(4);
    const page = await server.inject({ method: "GET", url: `/unsubscribe/${token}` });
    expect(page.json().unsubscribed).toBe(false);
    await server.close();
  });

  it("returns the contact's visible topics and the tenant brand", async () => {
    const { db } = fakeDb(null);
    const server = await app(db);
    const response = await server.inject({ method: "GET", url: `/unsubscribe/${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: "unsubscribe",
      email: "ada@example.com",
      unsubscribed: false,
      topics: [{ id: "topic_news", name: "News", description: "Weekly", subscription: "opt_in" }],
      // The page's own heading and line are null until the tenant sets them, and the page then shows its defaults.
      brand: { product_name: "Acme", logo_url: null, color: "#ffffff", text_color: "#000000", title: null, description: null, button_label: null, updated_title: null, updated_description: null, unsubscribed_title: null, unsubscribed_description: null },
    });
  });

  it("resolves page overrides without changing email brand styling", async () => {
    const brand: BrandRecord = {
      color: "#ffffff", logo_url: "https://example.com/global.png", text_color: "#112233",
      unsubscribe_color: "#18181b", unsubscribe_logo_url: "https://example.com/page.png",
      unsubscribe_title: "Your subscriptions", unsubscribe_description: "Choose your news",
      unsubscribe_button_label: "Save choices", unsubscribe_updated_title: "Saved",
      unsubscribe_updated_description: "Your choices are saved", unsubscribe_unsubscribed_title: "All done",
      unsubscribe_unsubscribed_description: "You have unsubscribed",
    };
    const { db } = fakeDb(null, { brand });
    const server = await app(db);
    const expected = {
      product_name: "Acme", logo_url: brand.unsubscribe_logo_url, color: "#18181b", text_color: "#ffffff",
      title: "Your subscriptions", description: "Choose your news", button_label: "Save choices",
      updated_title: "Saved", updated_description: "Your choices are saved",
      unsubscribed_title: "All done", unsubscribed_description: "You have unsubscribed",
    };
    expect((await server.inject({ method: "GET", url: `/unsubscribe/${token}` })).json().brand).toEqual(expected);
    expect((await server.inject({ method: "POST", url: `/unsubscribe/${token}`, payload: { unsubscribe_all: true } })).json().brand).toEqual(expected);
    expect(brandContext(brand, { tenantName: "Acme" })).toMatchObject({
      LOGO_URL: "https://example.com/global.png", BRAND_COLOR: "#ffffff", BRAND_TEXT_COLOR: "#000000",
      THEME_TEXT_COLOR: "#112233", THEME_BUTTON_BACKGROUND: "#ffffff", THEME_BUTTON_TEXT_COLOR: "#000000",
    });
    await server.close();
  });

  it("inherits global logo and color when page overrides are null", async () => {
    const { db } = fakeDb(null, { brand: {
      logo_url: "https://example.com/global.png", color: "#ffffff",
      unsubscribe_logo_url: null, unsubscribe_color: null, unsubscribe_button_label: null,
    } });
    const server = await app(db);
    expect((await server.inject({ method: "GET", url: `/unsubscribe/${token}` })).json().brand).toMatchObject({
      logo_url: "https://example.com/global.png", color: "#ffffff", text_color: "#000000", button_label: null,
    });
    await server.close();
  });

  it("returns 404 for a bad token", async () => {
    const { db } = fakeDb(null);
    const server = await app(db);
    const response = await server.inject({ method: "GET", url: "/unsubscribe/not-a-token" });
    expect(response.statusCode).toBe(404);
  });

  it("accepts the RFC 8058 form body and opts out of the broadcast's topic", async () => {
    const { db, queries } = fakeDb("topic_news");
    const server = await app(db);
    const response = await server.inject({
      method: "POST",
      url: `/unsubscribe/${token}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().topics[0].subscription).toBe("opt_out");
    const upsert = queries.find((query) => query.sql.includes("insert into topic_subscriptions"))!;
    expect(upsert.params.slice(2)).toEqual(["topic_news", "contact_1", "unsubscribed"]);
    const event = queries.find((query) => query.sql.includes("insert into email_events"))!;
    expect(event.params[5]).toBe("contact.topics.updated");
    const history = queries.filter((query) => query.sql.includes("insert into contact_changes"));
    expect(history).toHaveLength(1);
    expect(history[0]!.params.slice(3, 6)).toEqual(["topics.topic_news", "true", "false"]);
    expect(queries.some((query) => query.sql.includes("from automations"))).toBe(false);
    expect(queries.map((query) => query.sql)).toContain("commit");
  });

  it("unsubscribes from everything with a JSON body and emits contact.updated", async () => {
    const { db, queries } = fakeDb(null);
    const server = await app(db);
    const response = await server.inject({ method: "POST", url: `/unsubscribe/${token}`, payload: { unsubscribe_all: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json().unsubscribed).toBe(true);
    expect(queries.some((query) => query.sql.includes("unsubscribed_at = coalesce(unsubscribed_at, now())"))).toBe(true);
    const event = queries.find((query) => query.sql.includes("insert into email_events"))!;
    expect(event.params[5]).toBe("contact.updated");
    const history = queries.filter((query) => query.sql.includes("insert into contact_changes"));
    expect(history).toHaveLength(1);
    expect(history[0]!.params.slice(3, 6)).toEqual(["unsubscribed", "false", "true"]);
    const before = queries.length;
    const repeated = await server.inject({ method: "POST", url: `/unsubscribe/${token}`, payload: { unsubscribe_all: true } });
    expect(repeated.statusCode).toBe(200);
    expect(queries.slice(before).some((query) => query.sql.includes("insert into contact_changes") || query.sql.includes("from automations"))).toBe(false);
  });

  it("dispatches a real preference opt-in, not an identical repeated opt-in", async () => {
    const { db, queries } = fakeDb("topic_news");
    const server = await app(db);
    const out = await server.inject({ method: "POST", url: `/unsubscribe/${token}`, payload: { topics: [{ id: "topic_news", subscription: "opt_out" }] } });
    expect(out.statusCode).toBe(200);
    const payload = { topics: [{ id: "topic_news", subscription: "opt_in" }] };
    const optedIn = await server.inject({ method: "POST", url: `/unsubscribe/${token}`, payload });
    expect(optedIn.statusCode).toBe(200);
    expect(optedIn.json().topics[0].subscription).toBe("opt_in");
    const history = queries.filter((query) => query.sql.includes("insert into contact_changes"));
    expect(history.map((query) => query.params.slice(3, 6))).toEqual([
      ["topics.topic_news", "true", "false"], ["topics.topic_news", "false", "true"],
    ]);
    const candidates = queries.filter((query) => query.sql.includes("from automations"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.params).toEqual(["tenant_1", "topic_subscribed", "@topic.subscribed:topic_news", null]);
    const before = queries.length;
    const repeated = await server.inject({ method: "POST", url: `/unsubscribe/${token}`, payload });
    expect(repeated.statusCode).toBe(200);
    expect(queries.slice(before).some((query) => query.sql.includes("insert into contact_changes") || query.sql.includes("from automations"))).toBe(false);
  });
});
