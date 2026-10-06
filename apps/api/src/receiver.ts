import { ApiError, type IntegrationRecord } from "@dispatchmail/core";
import {
  decryptCredentials, inboundEventId, integrationByToken, prepareInbound, receiveInbound,
  recordInboundFailure, type Db,
} from "@dispatchmail/db";
import { inboundDuplicate } from "../../../packages/db/src/inbound/receiver.js";
import { verifyClerk, verifyStripe, verifySupabase, verifyWebhook } from "../../../packages/db/src/inbound/signatures.js";
import type { Headers, InboundDependencies, Verification } from "../../../packages/db/src/inbound/types.js";
import type { FastifyInstance } from "fastify";

export const inboundBodyLimit = 1024 * 1024;

export function verifyInbound(integration: IntegrationRecord, input: Verification) {
  switch (integration.provider) {
    case "stripe": return verifyStripe(input);
    case "clerk": return verifyClerk(input);
    case "webhook": return verifyWebhook(input);
    case "supabase": return verifySupabase({ ...input, header: integration.settings.secret_header ?? "x-webhook-secret" });
  }
}

export function registerReceiver(app: FastifyInstance, deps: {
  db: Db; secret: string; now?: () => number; customerTransport?: InboundDependencies["customerTransport"];
}) {
  app.register(async scope => {
    // Encapsulated parser: other API JSON routes retain their ordinary parsed bodies.
    // Authenticate the exact bytes before decoding JSON, never stringify a parsed object.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: inboundBodyLimit }, (_request, body, done) => done(null, body));
    scope.post("/inbound/:token", { bodyLimit: inboundBodyLimit, config: { cors: false } }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const integration = await integrationByToken(deps.db, (request.params as { token: string }).token);
      if (!integration) throw new ApiError("not_found", 404, "Integration not found");
      const body = request.body as Buffer;
      const headers = request.headers as Headers;
      let credentials: ReturnType<typeof decryptCredentials>;
      try {
        credentials = decryptCredentials({
          signingSecret: integration.secret, stripeRestrictedKey: integration.settings.stripe_restricted_key,
        }, deps.secret);
      } catch {
        throw new ApiError("service_unavailable", 503, "Inbound delivery could not be processed; retry");
      }
      const invalid = async (reason: "invalid_signature" | "invalid_payload") => {
        await recordInboundFailure(deps.db, integration, request.request_id, reason);
        throw new ApiError("validation_error", 400, reason === "invalid_signature" ? "Invalid signature" : "Invalid inbound payload");
      };
      if (!Buffer.isBuffer(body) || !verifyInbound(integration, {
        body, headers, secret: credentials.signingSecret, now: deps.now?.() ?? Date.now() / 1000,
      })) return invalid("invalid_signature");
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return invalid("invalid_payload");
      }
      const providerEventId = inboundEventId({ provider: integration.provider, body, headers });
      if (!providerEventId || providerEventId.length > 255 || providerEventId.startsWith("attempt:")) return invalid("invalid_payload");
      let result: Awaited<ReturnType<typeof receiveInbound>> | null = await inboundDuplicate(deps.db, {
        integration, tokenHash: integration.token_hash, providerEventId,
      });
      if (!result) {
        let mapping: Awaited<ReturnType<typeof prepareInbound>>;
        try {
          mapping = await prepareInbound(integration, payload, {
            stripeRestrictedKey: credentials.stripeRestrictedKey, customerTransport: deps.customerTransport,
          });
        } catch {
          await recordInboundFailure(deps.db, integration, request.request_id, "processing_failed");
          throw new ApiError("service_unavailable", 503, "Inbound delivery could not be processed; retry");
        }
        result = await receiveInbound(deps.db, {
          integration, tokenHash: integration.token_hash, providerEventId, mapping, requestId: request.request_id,
        });
      }
      return {
        object: "inbound_delivery", status: result.status, event_name: result.eventName,
        contact_id: result.contactId, ...(result.reason ? { error: result.reason } : {}),
        ...(result.duplicate ? { duplicate: true } : {}),
      };
    });
  });
}
