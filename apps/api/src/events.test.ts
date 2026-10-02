import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@dispatchmail/db";

const db = vi.hoisted(() => ({
  fireEvent: vi.fn(),
  executeAutomationRun: vi.fn(),
}));

vi.mock("@dispatchmail/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dispatchmail/db")>()),
  fireEvent: db.fireEvent,
  executeAutomationRun: db.executeAutomationRun,
}));

const { presentDefinition, presentFired, registerEvents } = await import("./events.js");

const definition = {
  id: "evdef_1",
  name: "user.created",
  schema: { plan: "string", seats: "number" },
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

function harness(handler: (sql: string, params: unknown[]) => { rows: unknown[] }) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => handler(sql.replace(/\s+/g, " "), params));
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    Object.assign(request, { auth: { tenant_id: "tenant_1" }, request_id: "req_1" });
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    reply.status(error.name === "ZodError" ? 400 : (error.statusCode ?? 500)).send({ name: error.name, message: error.message });
  });
  registerEvents(app, { db: { query } as unknown as Db, paging: () => ({}) });
  return { app, query };
}

beforeEach(() => {
  db.fireEvent.mockReset();
  db.executeAutomationRun.mockReset();
});

describe("event presenters", () => {
  it("presents a definition and a fired event flat", () => {
    expect(presentDefinition(definition)).toEqual({ object: "event", ...definition });
    expect(
      presentFired({ id: "ce_1", request_id: "req_1", name: "user.created", email: null, data: { plan: "pro" }, created_at: definition.created_at }),
    ).toEqual({ object: "fired_event", id: "ce_1", name: "user.created", email: null, payload: { plan: "pro" }, request_id: "req_1", created_at: definition.created_at });
  });
});

describe("event routes", () => {
  it("rejects a payload that breaks the event schema before firing", async () => {
    const { app } = harness((sql) => (sql.includes("from event_schemas") ? { rows: [definition] } : { rows: [] }));
    const response = await app.inject({
      method: "POST",
      url: "/events/send",
      payload: { event: "user.created", email: "ada@example.com", payload: { plan: 3, seats: 2 } },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ name: "validation_error", message: "payload.plan must be a string" });
    expect(db.fireEvent).not.toHaveBeenCalled();
  });

  it("stores a valid event and its runs, leaves the runs to the worker, and returns 202", async () => {
    db.fireEvent.mockResolvedValue({ event: { id: "ce_1" }, runs: ["run_new"], resumed: ["run_waiting"] });
    const { app, query } = harness((sql) => {
      if (sql.includes("from event_schemas")) return { rows: [definition] };
      if (sql.includes("from contacts")) return { rows: [{ email: "ada@example.com" }] };
      return { rows: [] };
    });
    const response = await app.inject({
      method: "POST",
      url: "/events/send",
      payload: { event: "user.created", contact_id: "contact_1", payload: { plan: "pro" } },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ object: "event", event: "user.created", id: "ce_1" });
    expect(query.mock.calls[0]![1]).toEqual(["tenant_1", "contact_1"]);
    expect(db.fireEvent.mock.calls[0]!.slice(1)).toEqual(["tenant_1", "req_1", { name: "user.created", email: "ada@example.com", data: { plan: "pro" } }]);
    expect(db.executeAutomationRun).not.toHaveBeenCalled();
  });

  it("fires an event with no definition without checking the payload", async () => {
    db.fireEvent.mockResolvedValue({ event: { id: "ce_2" }, runs: [], resumed: [] });
    const { app } = harness(() => ({ rows: [] }));
    const response = await app.inject({ method: "POST", url: "/events/send", payload: { event: "anything", payload: { x: [1] } } });
    expect(response.statusCode).toBe(202);
  });

  it("refuses reserved definition names and finds definitions by name", async () => {
    const { app, query } = harness((sql) => (sql.includes("from event_schemas") ? { rows: [definition] } : { rows: [] }));
    const reserved = await app.inject({ method: "POST", url: "/events", payload: { name: "resend:email.sent" } });
    expect(reserved.statusCode).toBe(400);

    const found = await app.inject({ method: "GET", url: "/events/user.created" });
    expect(found.json()).toMatchObject({ object: "event", id: "evdef_1" });
    expect(query.mock.calls.at(-1)![0]).toContain("(id = $2 or name = $2)");
  });

  it("returns 409 for a live duplicate definition and deletes by name", async () => {
    const { app, query } = harness((sql) => (sql.includes("from event_schemas") ? { rows: [definition] } : { rows: [] }));
    const duplicate = await app.inject({ method: "POST", url: "/events", payload: { name: "user.created", schema: { plan: "string" } } });
    expect(duplicate.statusCode).toBe(409);

    const deleted = await app.inject({ method: "DELETE", url: "/events/user.created" });
    expect(deleted.json()).toEqual({ object: "event", id: "evdef_1", deleted: true });
    expect(query.mock.calls.at(-1)![1]).toEqual(["tenant_1", "evdef_1"]);
  });
});
