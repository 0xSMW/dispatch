import { decrypt, encrypt } from "@dispatchmail/core";
import { describe, expect, it, vi } from "vitest";
import {
  listWebhookEvents,
  presentStoredWebhook,
  queueWebhookReplay,
  rotateWebhookSecret,
  webhookEventAttempts,
  webhookEventDetail,
} from "./webhooks.js";
import { presentWebhook, presentWebhookAttempt, presentWebhookEvent } from "./present.js";

function client(rows: Array<Record<string, unknown>> = []) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows };
    }),
  };
}

const webhook = {
  id: "webhook_1",
  url: "https://example.com/hook",
  events: ["email.sent"],
  enabled: true,
  created_at: "2026-10-01T00:00:00.000Z",
};

describe("webhook presenters", () => {
  it("returns endpoint and status, and the signing secret only when one is passed", () => {
    expect(presentWebhook(webhook)).toEqual({
      object: "webhook",
      id: "webhook_1",
      endpoint: "https://example.com/hook",
      events: ["email.sent"],
      status: "enabled",
      created_at: webhook.created_at,
    });
    expect(presentWebhook({ ...webhook, enabled: false }, "whsec_abc").signing_secret).toBe("whsec_abc");
    expect(presentWebhook({ ...webhook, enabled: false }).status).toBe("disabled");
  });

  it("maps the newest attempt onto a delivery status and an attempt row", () => {
    expect(presentWebhookEvent({ id: "event_1", type: "email.sent", created_at: webhook.created_at, state: "queued", attempt: 2 }).status).toBe("attempting");
    expect(presentWebhookAttempt({ id: "attempt_1", status: 500, response: "no", updated_at: webhook.created_at })).toEqual({
      id: "attempt_1",
      http_status_code: 500,
      response: "no",
      sent_at: webhook.created_at,
    });
  });

  it("decrypts a stored secret and leaves legacy plaintext readable", () => {
    const secret = "whsec_plain";
    expect(presentStoredWebhook({ ...webhook, secret }, "app-secret").signing_secret).toBe(secret);
    const stored = encrypt(secret, "app-secret");
    expect(presentStoredWebhook({ ...webhook, secret: stored }, "app-secret").signing_secret).toBe(secret);
  });
});

describe("webhook delivery log", () => {
  it("rejects before and groups attempts by event", async () => {
    const db = client([{ id: "event_1", type: "email.bounced", created_at: webhook.created_at, state: "sent", attempt: 1 }]);
    await expect(listWebhookEvents(db, "tenant_1", "webhook_1", { before: "event_0" })).rejects.toMatchObject({
      name: "validation_error",
      statusCode: 400,
    });
    const page = await listWebhookEvents(db, "tenant_1", "webhook_1", { limit: 1, after: "event_9" });
    expect(page.data[0]).toMatchObject({ object: "webhook_event", id: "event_1", status: "success" });
    expect(page.has_more).toBe(false);
    const listed = db.queries.at(-1);
    expect(listed?.sql).toContain("group by e.id");
    expect(listed?.params).toEqual(["tenant_1", "webhook_1", "event_9", 2]);
  });

  it("builds the delivery payload from the email row and keeps the event time", async () => {
    const db = client([{
      id: "event_1",
      request_id: "req_1",
      type: "email.bounced",
      email_id: "email_1",
      data: { bounce: { type: "Permanent", subType: "General", message: "550" } },
      created_at: "2026-09-01T00:00:00.000Z",
      email_created_at: "2026-09-01T00:00:01.000Z",
      from_email: "hello@example.com",
      from_name: "Hello",
      subject: "Hi",
      message_id: "<m@example.com>",
      tags: { order: "1" },
      broadcast_id: null,
      template_id: null,
      to: ["you@example.com"],
      state: "failed",
      attempt: 3,
      next_attempt_at: null,
    }]);
    const detail = await webhookEventDetail(db, "tenant_1", "webhook_1", "event_1");
    expect(detail.status).toBe("failed");
    expect(detail.payload.created_at).toBe("2026-09-01T00:00:00.000Z");
    expect(detail.payload.data).toMatchObject({
      email_id: "email_1",
      from: "Hello <hello@example.com>",
      to: ["you@example.com"],
      bounce: { type: "Permanent" },
    });
    expect(db.queries[0]?.params).toEqual(["tenant_1", "webhook_1", "event_1"]);
  });

  it("returns attempt rows as http status, response, and sent time", async () => {
    const db = client([{ id: "attempt_1", status: 200, response: "ok", updated_at: webhook.created_at }]);
    const page = await webhookEventAttempts(db, "tenant_1", "webhook_1", "event_1");
    expect(page.data).toEqual([{ id: "attempt_1", http_status_code: 200, response: "ok", sent_at: webhook.created_at }]);
  });

  it("queues one extra delivery for the event in the path", async () => {
    const db = client([{ id: "event_1", request_id: "req_1" }]);
    const queued = await queueWebhookReplay(db, {
      tenantId: "tenant_1",
      webhookId: "webhook_1",
      eventId: "event_1",
      requestId: "req_2",
    });
    expect(queued).toEqual({ queued: true, event_id: "event_1" });
    const insert = db.queries.find((query) => query.sql.includes("insert into webhook_attempts"));
    expect(insert?.params).toEqual([expect.stringMatching(/^attempt_/), "tenant_1", "req_1", "webhook_1", "event_1"]);
    expect(db.queries[0]?.params[2]).toBe("event_1");
  });

  it("stores the previous ciphertext for 24 hours and returns the new secret", async () => {
    const stored = encrypt("whsec_b2xk", "app-secret");
    const db = client([{ ...webhook, secret: stored }]);
    const rotated = await rotateWebhookSecret(db, "tenant_1", "webhook_1", "app-secret");
    expect(rotated.signing_secret?.startsWith("whsec_")).toBe(true);
    const update = db.queries.find((query) => query.sql.includes("update webhooks"));
    expect(decrypt(String(update?.params[2]), "app-secret")).toBe(rotated.signing_secret);
    expect(update?.params[3]).toBe(stored);
    expect(update?.sql).toContain("interval '24 hours'");
  });

  it("encrypts a legacy plaintext secret before keeping it as the previous one", async () => {
    const db = client([{ ...webhook, secret: "legacy-plain-secret" }]);
    await rotateWebhookSecret(db, "tenant_1", "webhook_1", "app-secret");
    const update = db.queries.find((query) => query.sql.includes("update webhooks"));
    expect(String(update?.params[3]).startsWith("enc:v2:")).toBe(true);
    expect(decrypt(String(update?.params[3]), "app-secret")).toBe("legacy-plain-secret");
  });

  it("reads the newest attempt by time, so a replay decides the status", async () => {
    const db = client([]);
    await listWebhookEvents(db, "tenant_1", "webhook_1", {});
    expect(db.queries[0]?.sql).toContain("order by a.created_at desc, a.id desc");
    expect(db.queries[0]?.sql).not.toContain("order by a.attempt desc");
  });
});
