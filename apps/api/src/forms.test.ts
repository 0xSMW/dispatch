import { describe, expect, it, vi } from "vitest";
import cors from "@fastify/cors";
import Fastify from "fastify";
import { ApiError, formSchema, type FormRecord } from "@dispatchmail/core";
import type { Db, Queryable } from "@dispatchmail/db";
import { formOrigin, formSubmission, honeypot, registerForms } from "./forms.js";
import { hideLinks, logBodies, redact } from "./logs.js";

const form = { ...formSchema.parse({ name: "News", topic_ids: ["topic_1"], properties: ["active", "score"],
  from_email: "hello@example.com", allowed_origins: ["https://customer.example"] }), tenant_id: "tenant_1" } as FormRecord;
const db = { query: vi.fn(async () => ({ rows: [{ key: "active", type: "boolean" }, { key: "score", type: "number" }] })) } as unknown as Queryable;
describe("public form guards", () => {
  it("requires exact form origins and a blank website honeypot", () => {
    expect(formOrigin(form, "https://customer.example")).toBe(true);
    for (const origin of [undefined, "null", "https://customer.example.evil", "http://customer.example"])
      expect(formOrigin(form, origin)).toBe(false);
    expect(honeypot({ website: "bot" })).toBe(true);
    expect(honeypot({ website: "" })).toBe(false);
  });
  it("accepts allowlisted JSON and encoded scalar properties without extra fields", async () => {
    expect(await formSubmission(db, form, { email: "PERSON@example.com", properties: { active: false, score: 2 } }, false))
      .toEqual({ email: "person@example.com", properties: { active: false, score: 2 } });
    expect(await formSubmission(db, form, { email: "person@example.com", "properties.active": "false", "properties.score": "2" }, true))
      .toEqual({ email: "person@example.com", properties: { active: false, score: 2 } });
    expect(await formSubmission(db, form, { email: "person@example.com", "properties.active": "", "properties.score": "" }, true))
      .toEqual({ email: "person@example.com", properties: {} });
    for (const extra of [{ redirect_url: "https://evil.example" }, { properties: { secret: "x" } }, { properties: [] }])
      await expect(formSubmission(db, form, { email: "person@example.com", ...extra }, false)).rejects.toMatchObject({ statusCode: 400 });
  });
  it("conceals confirmation links and credentials from viewer logs and omits public consent bodies", () => {
    expect(hideLinks('Confirm https://example.com/confirm/sealed.token now')).toBe("Confirm #link-hidden now");
    expect(logBodies({ method: "POST", route: "/confirm/:token", body: {}, responseText: "{}" })).toEqual({ request_body: null, response_body: null });
    expect(redact({ stripe_restricted_key: "synthetic", secret: "synthetic" })).toEqual({ stripe_restricted_key: "[redacted]", secret: "[redacted]" });
  });
});

describe("form preflight routing", () => {
  const dashboard = "http://127.0.0.1:5173";
  const key = "A".repeat(43);
  const managementRoute = "/forms/:id(^form_[0-9a-f]{32}$)";
  async function fixture() {
    const app = Fastify();
    const routes: Array<{ url: string | undefined; public?: boolean; cors?: boolean }> = [];
    const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
      rows: values?.[0] === key ? [{ ...form, key, allowed_origins: [dashboard, "https://customer.example"] }] : [],
    }));
    app.addHook("onRequest", async (request) => {
      routes.push({ ...request.routeOptions.config, url: request.routeOptions.url });
    });
    await app.register(cors, {
      origin: (origin, callback) => callback(null, !origin || origin === dashboard),
      allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-batch-validation", "x-request-id"],
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    });
    // The production auth hook is also after CORS and exempts only public routes.
    app.addHook("preHandler", async (request) => {
      if (!(request.routeOptions.config as { public?: boolean }).public)
        throw new ApiError("unauthorized", 401, "Authentication required");
    });
    registerForms(app, { db: { query } as unknown as Db, paging: () => ({}), secret: "offline",
      appUrl: dashboard, publicUrl: dashboard });
    await app.ready();
    return { app, query, routes };
  }
  it("prioritizes only minted management IDs over the public parameter route without lookup or credentials", async () => {
    const { app, query, routes } = await fixture();
    try {
      for (const id of [`form_${"a".repeat(32)}`, `form_${"0".repeat(32)}`]) {
        for (const method of ["GET", "PATCH", "DELETE"]) {
          const response = await app.inject({ method: "OPTIONS", url: `/forms/${id}`, headers: {
            origin: dashboard, "access-control-request-method": method, "access-control-request-headers": "authorization,content-type",
          } });
          expect(response.statusCode).toBe(204);
          expect(response.headers["access-control-allow-origin"]).toBe(dashboard);
          expect(String(response.headers["access-control-allow-methods"]).split(",").map((value) => value.trim())).toContain(method);
          expect(response.headers["access-control-allow-headers"]).toContain("authorization");
          expect(response.headers["access-control-allow-headers"]).toContain("content-type");
          expect(routes.at(-1)).toMatchObject({ url: managementRoute });
          expect(routes.at(-1)?.public).toBeUndefined();
          expect(routes.at(-1)?.cors).not.toBe(false);
        }
      }
      expect(query).not.toHaveBeenCalled();
      const refused = await app.inject({ method: "OPTIONS", url: `/forms/form_${"a".repeat(32)}`, headers: {
        origin: "https://dashboard.evil", "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,content-type",
      } });
      expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
      expect(refused.headers["access-control-allow-methods"]).toBeUndefined();
      expect(query).not.toHaveBeenCalled();
      for (const lookalike of [`form_${"a".repeat(31)}`, `form_${"a".repeat(33)}`, `form_${"A".repeat(32)}`, `xform_${"a".repeat(32)}`]) {
        const response = await app.inject({ method: "OPTIONS", url: `/forms/${lookalike}`, headers: {
          origin: dashboard, "access-control-request-method": "PATCH",
        } });
        expect(response.statusCode).toBe(404);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        expect(routes.at(-1)).toMatchObject({ url: "/forms/:id", public: true, cors: false });
      }
      expect((await app.inject({ method: "GET", url: `/forms/form_${"a".repeat(32)}` })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it("keeps public keys on exact-origin POST/content-type-only CORS even for a globally allowed origin", async () => {
    const { app, query, routes } = await fixture();
    try {
      query.mockResolvedValueOnce({ rows: [{ ...form, key }] });
      const notStored = await app.inject({ method: "OPTIONS", url: `/forms/${key}`, headers: {
        origin: dashboard, "access-control-request-method": "POST", "access-control-request-headers": "content-type",
      } });
      expect(notStored.statusCode).toBe(403);
      expect(notStored.headers["access-control-allow-origin"]).toBeUndefined();
      for (const origin of [dashboard, "https://customer.example"]) {
        const response = await app.inject({ method: "OPTIONS", url: `/forms/${key}`, headers: {
          origin, "access-control-request-method": "POST", "access-control-request-headers": "Content-Type",
        } });
        expect(response.statusCode).toBe(204);
        expect(response.headers["access-control-allow-origin"]).toBe(origin);
        expect(response.headers["access-control-allow-methods"]).toBe("POST");
        expect(response.headers["access-control-allow-headers"]).toBe("content-type");
        expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
        expect(routes.at(-1)).toMatchObject({ url: "/forms/:id", public: true, cors: false });
      }
      for (const origin of [undefined, "null", `${dashboard}.evil`, "https://disallowed.example"]) {
        const response = await app.inject({ method: "OPTIONS", url: `/forms/${key}`, headers: {
          ...(origin ? { origin } : {}), "access-control-request-method": "POST",
        } });
        expect(response.statusCode).toBe(403);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      }
      for (const [method, headers] of [["GET", "content-type"], ["PATCH", "content-type"], ["DELETE", "content-type"],
        ["POST", "authorization"], ["POST", "content-type,x-request-id"], ["POST", "content-type,x-extra"]]) {
        const response = await app.inject({ method: "OPTIONS", url: `/forms/${key}`, headers: {
          origin: dashboard, "access-control-request-method": method!, "access-control-request-headers": headers!,
        } });
        expect(response.statusCode).toBe(403);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        expect(response.headers["access-control-allow-methods"]).toBeUndefined();
      }
      for (const missing of ["B".repeat(43), "C".repeat(43)]) {
        const response = await app.inject({ method: "OPTIONS", url: `/forms/${missing}`, headers: {
          origin: dashboard, "access-control-request-method": "POST",
        } });
        expect(response.statusCode).toBe(404);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      }
      expect(query).toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("retains public POST honeypot, exact-origin checks and the 16KB body limit", async () => {
    const { app, routes } = await fixture();
    try {
      const response = await app.inject({ method: "POST", url: `/forms/${key}`, headers: { origin: dashboard },
        payload: { email: "bot@example.com", website: "bot", properties: { forbidden: true } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ object: "form_submission", message: "Thank you. Check your email if confirmation is needed." });
      expect(routes.at(-1)).toMatchObject({ url: "/forms/:id", public: true, cors: false });
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      expect((await app.inject({ method: "POST", url: `/forms/${key}`, payload: { email: "bot@example.com", website: "bot" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/forms/${key}`, headers: { origin: dashboard },
        payload: { email: "bot@example.com", website: "bot", first_name: "x".repeat(17000) } })).statusCode).toBe(413);
    } finally { await app.close(); }
  });
});
