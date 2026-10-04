import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { ApiError, operators, triggerKey, type PropertyType, type TriggerConfig } from "@dispatchmail/core";
import type { ContactRow, Db } from "@dispatchmail/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAudience } from "./audience.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build(type: PropertyType, key = "value") {
  const property = { id: "prop_1", key, type, fallback_value: null, deleted_at: null, created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z" };
  const contact = { id: "contact_1", email: "a@example.com", first_name: null, last_name: null, properties: { kept: "value" }, unsubscribed_at: null, created_at: property.created_at, updated_at: property.updated_at };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from contact_properties")) return { rows: [property] };
    if (sql.startsWith("update contact_properties")) return { rows: [{ ...property, fallback_value: JSON.parse(params[2] as string) }] };
    if (sql.startsWith("update contacts")) return { rows: [{ ...contact, properties: JSON.parse(params[7] as string) }] };
    if (sql.includes("from contacts")) return { rows: [contact] };
    return { rows: [] };
  });
  const app = Fastify();
  apps.push(app);
  app.addHook("preHandler", async (request) => {
    request.auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" };
    request.request_id = "req_1";
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.status(error instanceof ApiError ? error.statusCode : error.name === "ZodError" ? 400 : 500).send({ name: error.name, message: error.message });
  });
  registerAudience(app, { db: { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Db, paging: () => ({}), emitChange: vi.fn(), slug: (name) => name });
  return { app, query };
}

describe("typed audience routes", () => {
  it.each([
    ["boolean", false, "false"],
    ["date", "2026-10-03T09:30:00+02:00", "2026-02-30"],
  ] as Array<[PropertyType, boolean | string, string]>)
  ("validates %s fallback updates against the existing row", async (type, valid, invalid) => {
    const { app, query } = build(type);
    const response = await app.inject({ method: "PATCH", url: "/contact-properties/prop_1", payload: { fallback_value: valid } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ type, fallback_value: valid });
    const before = query.mock.calls.length;
    const bad = await app.inject({ method: "PATCH", url: "/contact-properties/prop_1", payload: { fallback_value: invalid } });
    expect(bad.statusCode).toBe(400);
    expect(query.mock.calls.slice(before).some(([sql]) => sql.startsWith("update"))).toBe(false);
    const clear = await app.inject({ method: "PATCH", url: "/contact-properties/prop_1", payload: { fallback_value: null } });
    expect(clear.json().fallback_value).toBeNull();
  });

  it("keeps legacy definition updates and empty patches working", async () => {
    const { app } = build("boolean", "topics");
    const repeated = await app.inject({ method: "POST", url: "/contact-properties", payload: { key: "topics", type: "boolean", fallback_value: false } });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ key: "topics", fallback_value: false });
    const noChange = await app.inject({ method: "PATCH", url: "/contact-properties/prop_1", payload: {} });
    expect(noChange.statusCode).toBe(200);
    expect(noChange.json().fallback_value).toBeNull();
  });

  it("validates declared contact values, preserves undeclared keys, and removes null keys", async () => {
    const { app, query } = build("boolean", "activated");
    const response = await app.inject({ method: "PATCH", url: "/contacts/contact_1", payload: { properties: { activated: false, extra: { arbitrary: true }, kept: null } } });
    expect(response.statusCode).toBe(200);
    expect(response.json().properties).toEqual({ activated: { value: false, type: "boolean" }, extra: { value: { arbitrary: true }, type: "string" } });
    const before = query.mock.calls.length;
    const bad = await app.inject({ method: "PATCH", url: "/contacts/contact_1", payload: { properties: { activated: "false" } } });
    expect(bad.statusCode).toBe(400);
    expect(query.mock.calls.slice(before).some(([sql]) => sql.startsWith("update contacts"))).toBe(false);
  });
});

// Exercise the real dispatchers at the route boundary. Pool reads and transaction queries are
// separate so a write accidentally moved out of the transaction cannot hide in this fixture.
function contactRoutes(input: {
  contact?: Partial<ContactRow> & { deleted_at?: string | null };
  member?: boolean;
  failRun?: boolean;
  deadlocks?: number;
  propertyType?: () => string;
  afterRollback?: (state: { contact: ContactRow | null }) => void;
} = {}) {
  const timestamp = "2026-10-03T00:00:00Z";
  const row = (values: Partial<ContactRow> = {}): ContactRow & { deleted_at: string | null } => ({
    id: "contact_1", email: "ada@example.com", first_name: null, last_name: null, properties: {},
    unsubscribed_at: null, created_at: timestamp, updated_at: timestamp, deleted_at: null, ...values,
  });
  const state = {
    contact: input.contact ? row(input.contact) : null,
    member: input.member ?? false,
    topicStatus: "unsubscribed",
    history: [] as Array<{ field: string; from: unknown; to: unknown; request_id: string }>,
    events: [] as Array<{ id: string; name: string; data: Record<string, unknown> }>,
    runs: [] as Array<{ id: string; automation_id: string; event_id: string }>,
  };
  const configs: TriggerConfig[] = [
    { type: "contact_created" }, { type: "contact_updated" },
    { type: "topic_subscribed", topic_id: "topic_1" }, { type: "segment_added", segment_id: "segment_1" },
  ];
  let snapshot: typeof state | null = null;
  let deadlocks = input.deadlocks ?? 0;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text === "begin") {
      snapshot = structuredClone(state);
      return { rows: [] };
    }
    if (text === "rollback") {
      Object.assign(state, snapshot);
      input.afterRollback?.(state);
      return { rows: [] };
    }
    if (text === "commit") return { rows: [] };
    if (text.includes("from contact_properties")) return { rows: [{ key: "activated", type: input.propertyType?.() ?? "boolean" }] };
    if (text.startsWith("insert into contacts")) {
      if (state.contact) return { rows: [] };
      state.contact = row({
        email: String(params[2]), first_name: (params[3] as string | null) ?? null, last_name: (params[4] as string | null) ?? null,
        properties: JSON.parse(params[5] as string), unsubscribed_at: params[6] ? timestamp : null,
      });
      return { rows: [{ ...state.contact }] };
    }
    if (text.includes("from contacts")) return { rows: state.contact ? [structuredClone(state.contact)] : [] };
    if (text.startsWith("update contacts")) {
      const contact = state.contact!;
      if (text.includes("first_name = coalesce")) {
        contact.first_name = (params[2] as string | null) ?? contact.first_name;
        contact.last_name = (params[3] as string | null) ?? contact.last_name;
        if (params[4]) contact.properties = JSON.parse(params[5] as string);
        if (params[6]) contact.unsubscribed_at = params[7] ? timestamp : null;
        contact.deleted_at = null;
      } else {
        if (params[2]) contact.first_name = params[3] as string | null;
        if (params[4]) contact.last_name = params[5] as string | null;
        if (params[6]) contact.properties = JSON.parse(params[7] as string);
        if (params[8] !== null) contact.unsubscribed_at = params[8] ? timestamp : null;
      }
      return { rows: [structuredClone(contact)] };
    }
    if (text.includes("as before from topics")) return { rows: [{ id: "topic_1", before: state.topicStatus }] };
    if (text.startsWith("insert into topic_subscriptions")) {
      state.topicStatus = String(params[4]);
      return { rows: [{ id: "sub_1", topic_id: params[2], contact_id: params[3], status: state.topicStatus }] };
    }
    if (text.includes("as status") && text.includes("from topics")) {
      return { rows: [{ id: "topic_1", name: "News", key: "news", status: state.topicStatus, explicit: true }] };
    }
    if (text.startsWith("select") && text.includes("from topics")) return { rows: [{ id: "topic_1" }] };
    if (text.startsWith("select") && text.includes("from segments")) return { rows: [{ id: "segment_1", type: "static" }] };
    if (text.startsWith("insert into segment_contacts")) {
      if (state.member) return { rows: [] };
      state.member = true;
      return { rows: [{ id: "member_1", contact_id: "contact_1", segment_id: "segment_1", created_at: timestamp }] };
    }
    if (text.includes("from segment_contacts")) return { rows: [{ id: "member_1", contact_id: "contact_1", segment_id: "segment_1", created_at: timestamp }] };
    if (text.startsWith("insert into contact_changes")) {
      expect(params.slice(1, 3)).toEqual(["tenant_1", "contact_1"]);
      state.history.push({ field: String(params[3]), from: JSON.parse(params[4] as string), to: JSON.parse(params[5] as string), request_id: String(params[6]) });
      return { rows: [] };
    }
    if (text.includes("from automations")) {
      const config = configs.find((config) => config.type === params[1] && triggerKey(config) === params[2]);
      return { rows: config ? [{
        id: `automation_${config.type}`, trigger: triggerKey(config), trigger_type: config.type, reentry: "every_time",
        steps: [{ key: "start", type: "trigger", config }], connections: [],
      }] : [] };
    }
    if (text.startsWith("insert into custom_events")) {
      expect(params.slice(1, 3)).toEqual(["tenant_1", "req_1"]);
      const event = { id: String(params[0]), name: String(params[3]), data: JSON.parse(params[5] as string) };
      state.events.push(event);
      return { rows: [{ ...event, request_id: params[2], email: params[4], created_at: timestamp }] };
    }
    if (text.startsWith("insert into automation_runs")) {
      if (input.failRun) throw new Error("run insert failed");
      if (deadlocks-- > 0) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      const run = { id: String(params[0]), automation_id: String(params[2]), event_id: String(params[3]) };
      state.runs.push(run);
      return { rows: [run] };
    }
    if (text.includes("from automation_runs r")) {
      return { rows: state.runs.filter((run) => run.id === params[1]).map((run) => ({ ...run, state: "ready", contact_id: "contact_1", request_id: "req_1" })) };
    }
    if (text.startsWith("insert into email_events")) return { rows: [] };
    throw new Error(`Unexpected contact route query: ${text}`);
  });
  const poolQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
    expect(sql).toContain("from contact_properties");
    return query(sql, params);
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const app = Fastify();
  apps.push(app);
  app.addHook("preHandler", async (request) => {
    request.auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" };
    request.request_id = "req_1";
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.status(error instanceof ApiError ? error.statusCode : error.name === "ZodError" ? 400 : 500).send({ message: error.message });
  });
  registerAudience(app, { db: { query: poolQuery, connect } as unknown as Db, paging: () => ({}), emitChange: vi.fn(), slug: (name) => name });
  return { app, state, query, poolQuery, connect, release };
}

describe("contact route trigger dispatch", () => {
  it.each([
    ["POST", "/contacts", { email: "ada@example.com" }, ["@contact.created"]],
    ["PATCH", "/contacts/contact_1", { first_name: "Ada" }, ["@contact.updated"]],
    ["PATCH", "/contacts/contact_1/topics", { topics: [{ id: "topic_1", subscription: "opt_in" }] }, ["@topic.subscribed:topic_1"]],
    ["POST", "/contacts/contact_1/segments/segment_1", undefined, ["@segment.added:segment_1"]],
    ["POST", "/segments/segment_1/contacts", { email: "ada@example.com" }, ["@contact.created", "@segment.added:segment_1"]],
    ["POST", "/topics/topic_1/subscriptions", { email: "ada@example.com", status: "opt_in" }, ["@contact.created", "@topic.subscribed:topic_1"]],
  ] as const)("retries the entire aborted %s %s transaction without duplicate dispatch", async (method, url, payload, names) => {
    const { app, state, query, connect, release } = contactRoutes({ deadlocks: 1, ...(method === "PATCH" || payload === undefined ? { contact: {} } : {}) });
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode).toBe(200);
    expect(state.events.map((event) => event.name)).toEqual(names);
    expect(state.runs).toHaveLength(names.length);
    expect(new Set(state.history.map((change) => change.field)).size).toBe(state.history.length);
    expect(query.mock.calls.filter(([sql]) => ["begin", "rollback", "commit"].includes(sql)).map(([sql]) => sql)).toEqual(["begin", "rollback", "begin", "commit"]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("recomputes PATCH diffs and property merges after another writer commits during rollback", async () => {
    const { app, state, query } = contactRoutes({
      contact: { first_name: "Grace", properties: { activated: false } }, deadlocks: 1,
      afterRollback: ({ contact }) => {
        contact!.first_name = "Ada";
        contact!.properties = { activated: true, concurrent: "keep" };
      },
    });
    const response = await app.inject({ method: "PATCH", url: "/contacts/contact_1", payload: { first_name: "Ada", properties: { activated: true } } });
    expect(response.statusCode).toBe(200);
    expect(state.contact!.properties).toEqual({ activated: true, concurrent: "keep" });
    expect(state.history).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(query.mock.calls.filter(([sql]) => sql.includes("from contacts"))).toHaveLength(2);
  });

  it("returns the existing 500 after four aborted attempts, leaving no contact or dispatch", async () => {
    const { app, state, query, connect, release } = contactRoutes({ deadlocks: 4 });
    const response = await app.inject({ method: "POST", url: "/contacts", payload: { email: "ada@example.com" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ message: "deadlock detected" });
    expect(state.contact).toBeNull();
    expect(state.history).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(query.mock.calls.filter(([sql]) => sql === "rollback")).toHaveLength(4);
    expect(query.mock.calls.some(([sql]) => sql === "commit")).toBe(false);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledTimes(4);
  });

  it.each(["POST", "PATCH"] as const)("rereads property validation inside every %s transaction attempt", async (method) => {
    let type = "boolean";
    const { app, state, query } = contactRoutes({
      ...(method === "PATCH" ? { contact: {} } : {}), deadlocks: 1,
      propertyType: () => type,
      afterRollback: () => { type = "number"; },
    });
    const response = await app.inject({
      method, url: method === "POST" ? "/contacts" : "/contacts/contact_1",
      payload: { ...(method === "POST" ? { email: "ada@example.com" } : {}), properties: { activated: true } },
    });
    expect(response.statusCode).toBe(400);
    expect(state.history).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(query.mock.calls.filter(([sql]) => sql.includes("from contact_properties"))).toHaveLength(2);
    expect(query.mock.calls.filter(([sql]) => sql === "rollback")).toHaveLength(2);
  });

  it("creates a contact, records its actual fields, and enrolls it on the write transaction", async () => {
    const { app, state, query, connect, release } = contactRoutes();
    const response = await app.inject({
      method: "POST", url: "/contacts",
      payload: { email: "ADA@example.com", first_name: "Ada", properties: { activated: false }, segments: [{ id: "segment_1" }], topics: [{ id: "topic_1", subscription: "opt_in" }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ email: "ada@example.com", properties: { activated: { value: false, type: "boolean" } } });
    expect(state.history).toEqual([
      { field: "activated", from: null, to: false, request_id: "req_1" },
      { field: "email", from: null, to: "ada@example.com", request_id: "req_1" },
      { field: "first_name", from: null, to: "Ada", request_id: "req_1" },
      { field: "unsubscribed", from: null, to: false, request_id: "req_1" },
      { field: "segments.segment_1", from: false, to: true, request_id: "req_1" },
      { field: "topics.topic_1", from: false, to: true, request_id: "req_1" },
    ]);
    expect(state.events.map((event) => event.name)).toEqual(["@contact.created", "@segment.added:segment_1", "@topic.subscribed:topic_1"]);
    expect(state.runs.map((run) => run.automation_id)).toEqual(["automation_contact_created", "automation_segment_added", "automation_topic_subscribed"]);
    expect(state.events[0]!.data).toMatchObject({ contact: { id: "contact_1", activated: false, first_name: "Ada" }, depth: 0 });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.at(-1)![0]).toBe("commit");

    const counts = [state.history.length, state.events.length, state.runs.length];
    const repeated = await app.inject({
      method: "POST", url: "/contacts",
      payload: { email: "ada@example.com", first_name: "Ada", properties: { activated: false }, segments: [{ id: "segment_1" }], topics: [{ id: "topic_1", subscription: "opt_in" }] },
    });
    expect(repeated.statusCode).toBe(200);
    expect([state.history.length, state.events.length, state.runs.length]).toEqual(counts);
  });

  it.each([null, "2026-10-02T00:00:00Z"])("dispatches updates or revivals from the locked previous snapshot (deleted_at=%s)", async (deletedAt) => {
    const { app, state, query } = contactRoutes({ contact: { first_name: "Grace", properties: { activated: false }, deleted_at: deletedAt } });
    const response = await app.inject({ method: "POST", url: "/contacts", payload: { email: "ada@example.com", first_name: "Ada", properties: { activated: true } } });
    expect(response.statusCode).toBe(200);
    expect(state.history).toEqual([
      { field: "activated", from: false, to: true, request_id: "req_1" },
      { field: "first_name", from: "Grace", to: "Ada", request_id: "req_1" },
    ]);
    expect(state.events.map((event) => event.name)).toEqual([deletedAt ? "@contact.created" : "@contact.updated"]);
    expect(query.mock.calls.find(([sql]) => sql.includes("deleted_at from contacts"))![0]).toContain("for update");
  });

  it("records PATCH changes, including a removed property, and skips an identical patch", async () => {
    const { app, state, query } = contactRoutes({ contact: { first_name: "Ada", properties: { activated: false, note: "remove" } } });
    const payload = { first_name: "Ada", properties: { activated: true, note: null } };
    const changed = await app.inject({ method: "PATCH", url: "/contacts/contact_1", payload });
    expect(changed.statusCode).toBe(200);
    expect(state.history).toEqual([
      { field: "activated", from: false, to: true, request_id: "req_1" },
      { field: "note", from: "remove", to: null, request_id: "req_1" },
    ]);
    expect(state.events.map((event) => event.name)).toEqual(["@contact.updated"]);
    expect(state.events[0]!.data.changes).toEqual(state.history.map(({ request_id: _requestId, ...change }) => change));
    const before = query.mock.calls.length;
    const repeated = await app.inject({ method: "PATCH", url: "/contacts/contact_1", payload });
    expect(repeated.statusCode).toBe(200);
    expect(state.history).toHaveLength(2);
    expect(state.runs).toHaveLength(1);
    expect(query.mock.calls.slice(before).some(([sql]) => sql.includes("from automations"))).toBe(false);
  });

  it("dispatches only the final topic opt-in and ignores repeated identical writes", async () => {
    const { app, state } = contactRoutes({ contact: {} });
    const payload = { topics: [{ id: "topic_1", subscription: "opt_out" }, { id: "topic_1", subscription: "opt_in" }] };
    const changed = await app.inject({ method: "PATCH", url: "/contacts/contact_1/topics", payload });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data).toEqual([{ id: "topic_1", name: "News", key: "news", subscription: "opt_in", explicit: true }]);
    expect(state.history).toEqual([{ field: "topics.topic_1", from: false, to: true, request_id: "req_1" }]);
    expect(state.events.map((event) => event.name)).toEqual(["@topic.subscribed:topic_1"]);
    const repeated = await app.inject({ method: "PATCH", url: "/contacts/contact_1/topics", payload });
    expect(repeated.statusCode).toBe(200);
    expect(state.history).toHaveLength(1);
    expect(state.runs).toHaveLength(1);
    const optOut = await app.inject({ method: "PATCH", url: "/contacts/contact_1/topics", payload: { topics: [{ id: "topic_1", subscription: "opt_out" }] } });
    expect(optOut.statusCode).toBe(200);
    expect(state.history.at(-1)).toEqual({ field: "topics.topic_1", from: true, to: false, request_id: "req_1" });
    expect(state.runs).toHaveLength(1);
  });

  it("does not enroll a globally unsubscribed contact on topic opt-in", async () => {
    const { app, state } = contactRoutes({ contact: { unsubscribed_at: "2026-10-01T00:00:00Z" } });
    const response = await app.inject({ method: "PATCH", url: "/contacts/contact_1/topics", payload: { topics: [{ id: "topic_1", subscription: "opt_in" }] } });
    expect(response.statusCode).toBe(200);
    expect(state.topicStatus).toBe("subscribed");
    expect(state.events).toEqual([]);
    expect(state.runs).toEqual([]);
  });

  it("dispatches contact membership additions once, not when the row already exists", async () => {
    const { app, state, query } = contactRoutes({ contact: {} });
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: "POST", url: "/contacts/contact_1/segments/segment_1" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ object: "segment", id: "segment_1", contact_id: "contact_1" });
    }
    expect(state.history).toEqual([{ field: "segments.segment_1", from: false, to: true, request_id: "req_1" }]);
    expect(state.events.map((event) => event.name)).toEqual(["@segment.added:segment_1"]);
    expect(state.runs).toHaveLength(1);
    expect(query.mock.calls.find(([sql]) => sql.includes("from contacts"))![0]).toContain("for update");
  });

  it.each([
    ["/segments/segment_1/contacts", { email: "ada@example.com" }, "@segment.added:segment_1"],
    ["/topics/topic_1/subscriptions", { email: "ada@example.com", status: "opt_in" }, "@topic.subscribed:topic_1"],
  ])("dispatches contact creation and membership from %s", async (url, payload, key) => {
    const { app, state } = contactRoutes();
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("added");
    expect(state.events.map((event) => event.name)).toEqual(["@contact.created", key]);
    expect(state.runs).toHaveLength(2);
  });

  it("rolls back the contact and its history if dispatch cannot persist a run", async () => {
    const { app, state, query, release } = contactRoutes({ failRun: true });
    const response = await app.inject({ method: "POST", url: "/contacts", payload: { email: "ada@example.com" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ message: "run insert failed" });
    expect(state.contact).toBeNull();
    expect(state.history).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(query.mock.calls.at(-1)![0]).toBe("rollback");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("typed public contracts", () => {
  const schemas = JSON.parse(readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8")).components.schemas;
  it("documents all four property and import types and boolean fallback values", () => {
    for (const name of ["ContactPropertyInput", "ContactProperty", "ImportColumn"]) {
      expect(schemas[name].properties.type.enum).toEqual(["string", "number", "boolean", "date"]);
    }
    for (const name of ["ContactPropertyInput", "ContactPropertyUpdate", "ContactProperty"]) {
      expect(schemas[name].properties.fallback_value.anyOf).toContainEqual({ type: "boolean" });
    }
    expect(schemas.ContactImportInput.properties.column_map.contentSchema).toEqual({ $ref: "#/components/schemas/ImportColumnMap" });
  });
  it("keeps rule operators and additive mappings aligned with core", () => {
    expect([...schemas.Rule.oneOf[0].properties.operator.enum].sort()).toEqual([...operators].sort());
    expect(schemas.SendEmailConfig.properties.variable_mapping).toMatchObject({ type: "object", additionalProperties: { type: "string" } });
    expect(schemas.AutomationStep.allOf.find((rule: { if: { properties: { type: { const: string } } } }) => rule.if.properties.type.const === "send_email").then.properties.config).toEqual({ $ref: "#/components/schemas/SendEmailConfig" });
  });
});
