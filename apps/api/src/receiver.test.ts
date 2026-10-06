import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, encrypt, type IntegrationRecord } from "@dispatchmail/core";
import type { Db } from "@dispatchmail/db";
import { prepareInbound } from "../../../packages/db/src/inbound/application.js";
import type { InboundDependencies } from "../../../packages/db/src/inbound/types.js";
import { logBodies } from "./logs.js";

const mocks = vi.hoisted(() => ({
  integrationByToken: vi.fn(), decryptCredentials: vi.fn(), inboundEventId: vi.fn(),
  prepareInbound: vi.fn(), receiveInbound: vi.fn(), recordInboundFailure: vi.fn(), inboundDuplicate: vi.fn(),
}));
vi.mock("@dispatchmail/db", () => mocks);
vi.mock("../../../packages/db/src/inbound/receiver.js", () => ({ inboundDuplicate: mocks.inboundDuplicate }));
const { registerReceiver, inboundBodyLimit } = await import("./receiver.js");
const now = 1_791_158_400;
const secret = "synthetic-signing-secret";
const row: IntegrationRecord = {
  id: "int_unit", tenant_id: "tenant_unit", provider: "stripe", name: "Unit", slug: "stripe",
  token_hash: "hash", secret: encrypt(secret, "synthetic-app-secret"), settings: {},
  last_received_at: null, created_at: "2026-10-05", updated_at: "2026-10-05", deleted_at: null,
};
async function harness(customerTransport?: InboundDependencies["customerTransport"]) {
  const app = Fastify();
  app.addHook("onRequest", async request => { request.request_id = "req_unit"; });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) =>
    reply.code(error.statusCode ?? 500).send({ name: error.name, message: error.message }));
  registerReceiver(app, { db: {} as Db, secret: "synthetic-app-secret", now: () => now, customerTransport });
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
  mocks.inboundDuplicate.mockResolvedValue(null);
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
      expect(mocks.inboundDuplicate).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        integration: row, tokenHash: row.token_hash, providerEventId: "evt_unit",
      });
      expect(mocks.inboundDuplicate.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.inboundEventId.mock.invocationCallOrder[0]!);
      expect(mocks.prepareInbound.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.inboundDuplicate.mock.invocationCallOrder[0]!);
      expect(mocks.receiveInbound).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        integration: row, tokenHash: row.token_hash, providerEventId: "evt_unit",
        mapping: { action: "ignored", reason: "unsupported_event" }, requestId: "req_unit",
      });
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
      expect(mocks.inboundDuplicate).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("refuses an unknown token without touching credentials or audit", async () => {
    mocks.integrationByToken.mockResolvedValue(null);
    const app = await harness();
    try {
      expect((await app.inject({ method: "POST", url: "/inbound/missing", payload: "{}" })).statusCode).toBe(404);
      expect(mocks.decryptCredentials).not.toHaveBeenCalled();
      expect(mocks.recordInboundFailure).not.toHaveBeenCalled();
      expect(mocks.inboundDuplicate).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("enforces the 1MB cap before token lookup and never stores raw request bodies", async () => {
    const app = await harness();
    try {
      expect((await app.inject({ method: "POST", url: "/inbound/unit", payload: "x".repeat(inboundBodyLimit + 1),
        headers: { "content-type": "application/json" } })).statusCode).toBe(413);
      expect(mocks.integrationByToken).not.toHaveBeenCalled();
      expect(mocks.inboundDuplicate).not.toHaveBeenCalled();
      expect(logBodies({ method: "POST", route: "/inbound/:token", body: Buffer.from("sensitive"),
        responseText: '{"status":"failed"}' })).toEqual({ request_body: null, response_body: null });
      for (const route of ["/integrations", "/integrations/:id/rotate"]) {
        expect(logBodies({ method: "POST", route, body: { secret: "sensitive" },
          responseText: '{"token":"sensitive","url":"https://api.example/inbound/sensitive"}' }))
          .toEqual({ request_body: null, response_body: null });
      }
    } finally { await app.close(); }
  });
  it("refuses unavailable credentials before duplicate lookup", async () => {
    mocks.decryptCredentials.mockImplementation(() => { throw new Error("synthetic credential"); });
    const app = await harness();
    const body = '{"id":"evt_unit"}';
    try {
      const response = await app.inject({ method: "POST", url: "/inbound/unit", payload: body,
        headers: { "content-type": "application/json", "stripe-signature": signature(body) } });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("credential");
      expect(mocks.inboundDuplicate).not.toHaveBeenCalled();
      expect(mocks.prepareInbound).not.toHaveBeenCalled();
      expect(mocks.recordInboundFailure).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("refuses authenticated invalid JSON before event identity or duplicate lookup", async () => {
    const app = await harness();
    const body = '{"id":';
    try {
      const response = await app.inject({ method: "POST", url: "/inbound/unit", payload: body,
        headers: { "content-type": "application/json", "stripe-signature": signature(body) } });
      expect(response.statusCode).toBe(400);
      expect(mocks.recordInboundFailure).toHaveBeenCalledWith(expect.anything(), row, "req_unit", "invalid_payload");
      expect(mocks.inboundEventId).not.toHaveBeenCalled();
      expect(mocks.inboundDuplicate).not.toHaveBeenCalled();
      expect(mocks.prepareInbound).not.toHaveBeenCalled();
      expect(mocks.receiveInbound).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each([undefined, "", "attempt:reserved", "x".repeat(256)])("refuses invalid event identity %j before duplicate lookup", async eventId => {
    mocks.inboundEventId.mockReturnValue(eventId);
    const app = await harness();
    const body = '{"id":"evt_unit"}';
    try {
      const response = await app.inject({ method: "POST", url: "/inbound/unit", payload: body,
        headers: { "content-type": "application/json", "stripe-signature": signature(body) } });
      expect(response.statusCode).toBe(400);
      expect(mocks.recordInboundFailure).toHaveBeenCalledWith(expect.anything(), row, "req_unit", "invalid_payload");
      expect(mocks.inboundDuplicate).not.toHaveBeenCalled();
      expect(mocks.prepareInbound).not.toHaveBeenCalled();
      expect(mocks.receiveInbound).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each(["processed", "ignored"] as const)("returns a committed %s duplicate without retrying rejecting customer transport or effects", async status => {
    const transport = vi.fn().mockRejectedValue(new Error("synthetic transport unavailable"));
    mocks.prepareInbound.mockImplementation(prepareInbound);
    mocks.decryptCredentials.mockReturnValue({ signingSecret: secret, stripeRestrictedKey: "rk_test_synthetic" });
    mocks.inboundDuplicate.mockResolvedValue({
      status, eventName: "stripe.invoice.paid", contactId: status === "processed" ? "contact_unit" : null,
      ...(status === "ignored" ? { reason: "no_contact" } : {}), duplicate: true,
    });
    const app = await harness(transport);
    const body = JSON.stringify({ id: "evt_unit", type: "invoice.paid", data: { object: { id: "in_unit", customer: "cus_unit" } } });
    try {
      const response = await app.inject({ method: "POST", url: "/inbound/unit", payload: body,
        headers: { "content-type": "application/json", "stripe-signature": signature(body) } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        object: "inbound_delivery", status, event_name: "stripe.invoice.paid",
        contact_id: status === "processed" ? "contact_unit" : null,
        ...(status === "ignored" ? { error: "no_contact" } : {}), duplicate: true,
      });
      expect(mocks.inboundDuplicate).toHaveBeenCalledOnce();
      expect(mocks.prepareInbound).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      expect(mocks.receiveInbound).not.toHaveBeenCalled();
      expect(mocks.recordInboundFailure).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("prepares with customer transport and fully receives an advisory miss", async () => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "cus_unit", email: "unit@example.test",
    }), { status: 200 }));
    mocks.prepareInbound.mockImplementation(prepareInbound);
    mocks.decryptCredentials.mockReturnValue({ signingSecret: secret, stripeRestrictedKey: "rk_test_synthetic" });
    mocks.receiveInbound.mockResolvedValue({ status: "processed", eventName: "stripe.invoice.paid", contactId: "contact_unit" });
    const app = await harness(transport);
    const body = JSON.stringify({ id: "evt_unit", type: "invoice.paid", data: { object: { id: "in_unit", customer: "cus_unit" } } });
    try {
      const response = await app.inject({ method: "POST", url: "/inbound/unit", payload: body,
        headers: { "content-type": "application/json", "stripe-signature": signature(body) } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        object: "inbound_delivery", status: "processed", event_name: "stripe.invoice.paid", contact_id: "contact_unit",
      });
      expect(mocks.inboundDuplicate).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledExactlyOnceWith("https://api.stripe.com/v1/customers/cus_unit", expect.any(Object));
      expect(mocks.receiveInbound).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        integration: row, tokenHash: row.token_hash, providerEventId: "evt_unit", requestId: "req_unit",
        mapping: expect.objectContaining({ action: "upsert", lookup: { email: "unit@example.test" } }),
      });
      expect(mocks.recordInboundFailure).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each([404, 503])("preserves the advisory identity failure %i before preparation or effects", async statusCode => {
    mocks.inboundDuplicate.mockRejectedValue(new ApiError(
      statusCode === 404 ? "not_found" : "service_unavailable", statusCode,
      statusCode === 404 ? "Integration not found" : "Inbound delivery could not be processed; retry",
    ));
    const transport = vi.fn().mockRejectedValue(new Error("synthetic transport unavailable"));
    const app = await harness(transport);
    const body = '{"id":"evt_unit"}';
    try {
      const response = await app.inject({ method: "POST", url: "/inbound/unit", payload: body,
        headers: { "content-type": "application/json", "stripe-signature": signature(body) } });
      expect(response.statusCode).toBe(statusCode);
      expect(mocks.prepareInbound).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      expect(mocks.receiveInbound).not.toHaveBeenCalled();
      expect(mocks.recordInboundFailure).not.toHaveBeenCalled();
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
