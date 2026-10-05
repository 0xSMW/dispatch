import Fastify from "fastify";
import { ApiError } from "@dispatchmail/core";
import type { Db } from "@dispatchmail/db";
import { describe, expect, it, vi } from "vitest";
import { registerAudience } from "./audience.js";

const timestamp = "2026-10-05T00:00:00Z";
const rule = { type: "rule", field: "contact.score", operator: "gte", value: 3 };
const contact = { id: "contact_1", email: "a@fixture.net", first_name: null, last_name: null, properties: { score: 4 },
  unsubscribed_at: null, created_at: timestamp, updated_at: timestamp };

async function fixture() {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.startsWith("insert into segments")) return { rows: [{
      id: _params![0], name: _params![2], description: null, rule: null, created_at: timestamp, updated_at: timestamp,
    }] };
    if (sql.includes("from contact_properties")) return { rows: [{ key: "score", type: "number" }] };
    if (sql.includes("from segments") && !sql.includes("join")) return { rows: [{
      id: "segment_1", name: "Filter", description: null, rule, created_at: timestamp, updated_at: timestamp,
    }] };
    if (sql.startsWith("with matched")) return { rows: [{ count: "1", sample: [contact] }] };
    if (sql.startsWith("select count(*)")) return { rows: [{ count: "1" }] };
    if (sql.includes("select c.id, c.id as contact_id")) return { rows: [{ ...contact, contact_id: contact.id }] };
    if (sql.startsWith("select c.id,")) return { rows: [contact] };
    return { rows: [] };
  });
  const app = Fastify();
  app.addHook("preHandler", async (request) => {
    request.auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" };
    request.request_id = "fixture";
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.status(error instanceof ApiError ? error.statusCode : 400).send({ name: error.name });
  });
  registerAudience(app, { db: { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Db,
    paging: () => ({ limit: 1 }), emitChange: async () => undefined, slug: (value) => value });
  await app.ready();
  return { app, query };
}

describe("dynamic segment route wiring", () => {
  it.each([undefined, null])("binds SQL NULL, not JSON null, for static creation with rule %s", async (value) => {
    const { app, query } = await fixture();
    try {
      const response = await app.inject({ method: "POST", url: "/segments", payload: {
        name: "Static", ...(value === undefined ? {} : { rule: value }),
      } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ type: "static", rule: null });
      const insertion = query.mock.calls.find(([sql]) => sql.startsWith("insert into segments"))!;
      expect(insertion[1]![4]).toBeNull();
    } finally { await app.close(); }
  });
  it("presents typed preview samples from the single-statement helper", async () => {
    const { app, query } = await fixture();
    try {
      const response = await app.inject({ method: "POST", url: "/segments/preview", payload: { rule } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ count: 1, sample: [{ id: contact.id, properties: { score: { value: 4, type: "number" } } }] });
      expect(query.mock.calls.filter(([sql]) => sql.startsWith("with matched"))).toHaveLength(1);
      expect(query.mock.calls.some(([sql]) => /^(insert|update|delete)/.test(sql))).toBe(false);
    } finally { await app.close(); }
  });
  it("paginates dynamic membership on real contact ids and caller placeholders", async () => {
    const { app, query } = await fixture();
    try {
      const response = await app.inject({ method: "GET", url: "/segments/segment_1/contacts" });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject([{ id: contact.id, contact_id: contact.id }]);
      const call = query.mock.calls.find(([sql]) => sql.includes("select c.id, c.id as contact_id"))!;
      expect(call[0]).toContain("c.tenant_id = $1");
      expect(call[0]).toContain("order by c.created_at desc, c.id desc");
      expect(call[1]).toEqual(["tenant_1", "score", 3, 2]);
    } finally { await app.close(); }
  });
  it("caches numeric detail counts but refuses dynamic add and delete", async () => {
    const { app, query } = await fixture();
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        const response = await app.inject({ method: "GET", url: "/segments/segment_1" });
        expect(response.json()).toMatchObject({ type: "dynamic", rule, contacts: 1 });
      }
      expect(query.mock.calls.filter(([sql]) => sql.startsWith("select count(*)"))).toHaveLength(1);
      const deleted = await app.inject({ method: "DELETE", url: "/segments/segment_1/contacts/contact_1" });
      expect(deleted.statusCode).toBe(409);
      expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
      expect(query.mock.calls.some(([sql]) => sql.startsWith("delete from segment_contacts"))).toBe(false);
    } finally { await app.close(); }
  });
});
