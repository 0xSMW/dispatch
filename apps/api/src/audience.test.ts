import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { ApiError, operators, type PropertyType } from "@dispatchmail/core";
import type { Db } from "@dispatchmail/db";
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
  });
  app.setErrorHandler((error, _request, reply) => {
    reply.status(error instanceof ApiError ? error.statusCode : error.name === "ZodError" ? 400 : 500).send({ name: error.name, message: error.message });
  });
  registerAudience(app, { db: { query } as unknown as Db, paging: () => ({}), emitChange: vi.fn(), slug: (name) => name });
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
    expect(schemas.AutomationStep.allOf[0].then.properties.config).toEqual({ $ref: "#/components/schemas/SendEmailConfig" });
  });
});
