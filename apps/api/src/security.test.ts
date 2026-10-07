import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { keyHash } from "@dispatchmail/core";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@dispatchmail/db", async (original) => ({
  ...(await original<typeof import("@dispatchmail/db")>()),
  connect: () => ({ query, end: vi.fn() }),
}));

let server: typeof import("./server.js");
beforeAll(async () => {
  vi.stubEnv("API_KEY_PEPPER", "security-test-pepper");
  vi.stubEnv("APP_SECRET", "security-test-secret");
  vi.stubEnv("COUNTER_BACKEND", "postgres");
  vi.stubEnv("WORKER_RUNTIME", "vercel");
  vi.stubEnv("NODE_ENV", "test");
  server = await import("./server.js");
});
afterAll(async () => {
  await server?.close();
  vi.unstubAllEnvs();
});

describe("API credential boundaries", () => {
  it("consults persisted revocation on every authentication even after a successful lookup", async () => {
    const secret = "dm_test_revoked_secret";
    query.mockResolvedValueOnce({
      rows: [
        {
          id: "key_1",
          tenant_id: "tenant_1",
          hash: keyHash(secret, "security-test-pepper"),
          scope: "full",
        },
      ],
    });
    expect(await server.validKey(secret)).toMatchObject({ id: "key_1" });
    // Another instance revokes the key. This instance receives no invalidation message.
    query.mockResolvedValueOnce({ rows: [] });
    expect(await server.validKey(secret)).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("k.revoked_at is null");
  });

  it("redacts tracking credentials in nested event pages, webhook payloads and attempt responses", () => {
    const event = {
      data: [
        {
          type: "email.clicked",
          data: {
            token: "replayable-tracking-token",
            recipient: "ada@example.com",
            count: 3,
            url: "https://user:password@example.com/private?access_token=credential",
            nested: {
              tracking_token: "nested-token",
              message:
                "Opened https://track.example/open/replayable-tracking-token",
            },
          },
        },
      ],
      payload: {
        data: {
          unsubscribe_url:
            "https://track.example/unsubscribe/sealed-credential",
        },
      },
      response_body: JSON.stringify({
        token: "echoed-tracking-token",
        url: "https://track.example/click/replayable-tracking-token",
      }),
    };
    const shown = server.presentEvent(event, true);
    expect(JSON.stringify(shown)).not.toMatch(
      /replayable-tracking-token|nested-token|sealed-credential|echoed-tracking-token|password|access_token=credential/,
    );
    expect(shown).toMatchObject({
      data: [
        {
          type: "email.clicked",
          data: {
            recipient: "ada@example.com",
            count: 3,
            token: "[redacted]",
            url: "https://example.com/…",
          },
        },
      ],
    });
    expect(server.presentEvent(event, false)).toBe(event);
    for (const response of ["bare-replay-token", JSON.stringify({ message: "innocuous-key-token" })]) {
      const attempt = { id: "attempt_1", status: 200, response, response_body: response };
      expect(server.presentEvent(attempt, true)).toEqual({
        id: "attempt_1", status: 200, response: "[redacted]", response_body: "[redacted]",
      });
      expect(server.presentEvent(attempt, false)).toBe(attempt);
    }
  });
});
