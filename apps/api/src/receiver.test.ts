import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, encrypt, type IntegrationRecord } from "@dispatchmail/core";
import type { Db } from "@dispatchmail/db";
import { logBodies } from "./logs.js";

const mocks = vi.hoisted(() => ({
  integrationByToken: vi.fn(), decryptCredentials: vi.fn(), inboundEventId: vi.fn(),
  prepareInbound: vi.fn(), receiveInbound: vi.fn(), recordInboundFailure: vi.fn(),
}));
vi.mock("@dispatchmail/db", () => mocks);
const { registerReceiver, inboundBodyLimit } = await import("./receiver.js");
const now = 1_791_158_400;
const secret = "synthetic-signing-secret";
const row: IntegrationRecord = {
  id: "int_unit", tenant_id: "tenant_unit", provider: "stripe", name: "Unit", slug: "stripe",
  token_hash: "hash", secret: encrypt(secret, "synthetic-app-secret"), settings: {},
  last_received_at: null, created_at: "2026-10-05", updated_at: "2026-10-05", deleted_at: null,
};
async function harness() {
  const app = Fastify();
  app.addHook("onRequest", async request => { request.request_id = "req_unit"; });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) =>
    reply.code(error.statusCode ?? 500).send({ name: error.name, message: error.message }));
  registerReceiver(app, { db: {} as Db, secret: "synthetic-app-secret", now: () => now });
  // Demonstrates parser encapsulation without booting the production server.
  app.post("/ordinary", async request => ({ parsed: typeof request.body }));
  return app;
}
function signature(body: string, time = now) {
  return `t=${time},v1=${createHmac("sha256", secret).update(`${time}.`).update(body).digest("hex")}`;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.integrationByToken.mockResolvedValue(row);
  mocks.decryptCredentials.mockReturnValue({ signingSecret: secret });
  mocks.inboundEventId.mockReturnValue("evt_unit");
  mocks.prepareInbound.mockResolvedValue({ action: "ignored", reason: "unsupported_event" });
  mocks.receiveInbound.mockResolvedValue({ status: "ignored", eventName: null, contactId: null, reason: "unsupported_event" });
});
describe("receiver raw plumbing", () => {
  it("verifies unchanged JSON whitespace bytes and leaves ordinary JSON parsing alone", async () => {
    const app = await harness();
    const body = '{ "id" : "evt_unit", "type": "unknown" }\n';
    try {
      const result = await app.inject({ method: "POST", url: "/inbound/unit", payload: body,
        headers: { "content-type": "application/json", "stripe-signature": signature(body) } });
      expect(result.statusCode).toBe(200);
      expect(Buffer.from(mocks.inboundEventId.mock.calls[0]![0].body).toString()).toBe(body);
      expect(mocks.prepareInbound).toHaveBeenCalledWith(row, JSON.parse(body), expect.any(Object));
      expect((await app.inject({ method: "POST", url: "/ordinary", payload: { value: 1 } })).json()).toEqual({ parsed: "object" });
    } finally { await app.close(); }
  });
  it.each(["wrong", "stale", "future"])("audits %s signatures without parsing, mapping or reserving", async kind => {
    const app = await harness();
    const body = '{"id":"evt_unit"}';
    const signed = kind === "wrong" ? signature("{}") : signature(body, now + (kind === "stale" ? -301 : 301));
    try {
      const result = await app.inject({ method: "POST", url: "/inbound/unit", payload: body,
        headers: { "content-type": "application/json", "stripe-signature": signed } });
      expect(result.statusCode).toBe(400);
      expect(mocks.recordInboundFailure).toHaveBeenCalledWith(expect.anything(), row, "req_unit", "invalid_signature");
      expect(mocks.prepareInbound).not.toHaveBeenCalled();
      expect(mocks.inboundEventId).not.toHaveBeenCalled();
      expect(mocks.receiveInbound).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("refuses an unknown token without touching credentials or audit", async () => {
    mocks.integrationByToken.mockResolvedValue(null);
    const app = await harness();
    try {
      expect((await app.inject({ method: "POST", url: "/inbound/missing", payload: "{}" })).statusCode).toBe(404);
      expect(mocks.decryptCredentials).not.toHaveBeenCalled();
      expect(mocks.recordInboundFailure).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("enforces the 1MB cap before token lookup and never stores raw request bodies", async () => {
    const app = await harness();
    try {
      expect((await app.inject({ method: "POST", url: "/inbound/unit", payload: "x".repeat(inboundBodyLimit + 1),
        headers: { "content-type": "application/json" } })).statusCode).toBe(413);
      expect(mocks.integrationByToken).not.toHaveBeenCalled();
      expect(logBodies({ method: "POST", route: "/inbound/:token", body: Buffer.from("sensitive"),
        responseText: '{"status":"failed"}' })).toEqual({ request_body: null, response_body: null });
      for (const route of ["/integrations", "/integrations/:id/rotate"]) {
        expect(logBodies({ method: "POST", route, body: { secret: "sensitive" },
          responseText: '{"token":"sensitive","url":"https://api.example/inbound/sensitive"}' }))
          .toEqual({ request_body: null, response_body: null });
      }
    } finally { await app.close(); }
  });
  it("records preparation failure with fixed retryable response instead of raw transport errors", async () => {
    mocks.prepareInbound.mockRejectedValue(new Error("synthetic credential must not leak"));
    const app = await harness();
    const body = '{"id":"evt_unit"}';
    try {
      const response = await app.inject({ method: "POST", url: "/inbound/unit", payload: body,
        headers: { "content-type": "application/json", "stripe-signature": signature(body) } });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("credential");
      expect(mocks.recordInboundFailure).toHaveBeenCalledWith(expect.anything(), row, "req_unit", "processing_failed");
      expect(mocks.receiveInbound).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("preserves duplicate success results and sanitized transaction failure", async () => {
    const app = await harness();
    const body = '{"id":"evt_unit"}';
    const request = { method: "POST" as const, url: "/inbound/unit", payload: body,
      headers: { "content-type": "application/json", "stripe-signature": signature(body) } };
    try {
      mocks.receiveInbound.mockResolvedValue({ status: "processed", eventName: "stripe.invoice.paid", contactId: "contact_unit", duplicate: true });
      expect((await app.inject(request)).json()).toMatchObject({ status: "processed", duplicate: true });
      mocks.receiveInbound.mockRejectedValue(new ApiError("service_unavailable", 503, "Retry"));
      expect((await app.inject(request)).statusCode).toBe(503);
    } finally { await app.close(); }
  });
});
