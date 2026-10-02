import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { forward, listener, maxBody, passthrough, signed as isSigned, unregister } from "../../../src/commands/webhooks/listen.js";
import type { Api } from "../../../src/lib/client.js";
import { setNonInteractive, spies } from "../../helpers.js";

vi.mock("@dispatchmail/sdk", async () => ({
  ...(await import("../../helpers.js")).sdk,
  verifyWebhook: (await import("../../../../../packages/sdk/src/verify.js")).verifyWebhook,
}));

function request(method: string, body: string, headers: Record<string, string> = {}) {
  return Object.assign(Readable.from([Buffer.from(body)]), { method, headers }) as unknown as IncomingMessage;
}

function response() {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      out.status = status;
      out.headers = headers ?? {};
      return res;
    },
    end(body?: string) {
      out.body = body ?? "";
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, out };
}

const event = JSON.stringify({ type: "email.delivered", created_at: "2026-10-01T00:00:00Z", data: { email_id: "email_1" } });
const signed = {
  "content-type": "application/json",
  "webhook-id": "msg_1",
  "webhook-timestamp": "1790000000",
  "webhook-signature": "v1,abc",
  host: "127.0.0.1:4318",
  connection: "keep-alive",
  "content-length": "99",
};

describe("forward", () => {
  const fetch = vi.fn();
  beforeEach(() => vi.stubGlobal("fetch", fetch));
  afterEach(() => vi.unstubAllGlobals());

  it("returns the target's own status and body", async () => {
    fetch.mockResolvedValue(new Response("created", { status: 201 }));
    expect(await forward("http://localhost:3000/hooks", Buffer.from(event), { "webhook-id": "msg_1" })).toEqual({
      status: 201,
      body: "created",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://localhost:3000/hooks");
    expect(init).toMatchObject({ method: "POST", headers: { "webhook-id": "msg_1" } });
    expect(Buffer.from(init.body).toString()).toBe(event);
  });

  it("passes a target's 500 through so Dispatch retries", async () => {
    fetch.mockResolvedValue(new Response("boom", { status: 500 }));
    expect((await forward("http://localhost:3000/hooks", Buffer.from(event), {})).status).toBe(500);
  });

  it("maps an unreachable target to 502", async () => {
    fetch.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    expect((await forward("http://localhost:3000/hooks", Buffer.from(event), {})).status).toBe(502);
  });

  it("maps a timeout to 504", async () => {
    fetch.mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    expect((await forward("http://localhost:3000/hooks", Buffer.from(event), {})).status).toBe(504);
  });
});

describe("listener", () => {
  beforeEach(() => setNonInteractive());
  afterEach(() => vi.unstubAllGlobals());

  it("drops hop-by-hop headers and keeps the signature headers", () => {
    expect(passthrough(signed)).toEqual({
      "content-type": "application/json",
      "webhook-id": "msg_1",
      "webhook-timestamp": "1790000000",
      "webhook-signature": "v1,abc",
    });
  });

  it("rejects anything but POST", async () => {
    const { res, out } = response();
    await listener({ globals: {} })(request("GET", ""), res);
    expect(out.status).toBe(405);
  });

  it("prints one NDJSON line per event and answers 200 without a forward target", async () => {
    const { stdout } = spies();
    const { res, out } = response();
    await listener({ globals: {} })(request("POST", event, signed), res);
    expect(out.status).toBe(200);
    expect(JSON.parse(stdout())).toMatchObject({
      type: "email.delivered",
      resource_id: "email_1",
      payload: { data: { email_id: "email_1" } },
      forwarded: null,
    });
  });

  it("forwards the raw body with signature headers and returns the target's status", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const { stdout } = spies();
    const { res, out } = response();
    await listener({ forwardTo: "http://localhost:3000/hooks", globals: {} })(request("POST", event, signed), res);
    expect(out.status).toBe(401);
    expect(fetch.mock.calls[0]![1].headers).toMatchObject({ "webhook-signature": "v1,abc" });
    expect(JSON.parse(stdout()).forwarded).toEqual({ url: "http://localhost:3000/hooks", status: 401 });
  });

  it("rejects a request without a valid signature and does not forward it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { stdout } = spies();
    const secret = `whsec_${Buffer.from("local-secret").toString("base64")}`;
    const verify = (payload: string, headers: Record<string, unknown>) => isSigned(secret, payload, headers as never);
    const { res, out } = response();
    await listener({ forwardTo: "http://localhost:3000/hooks", globals: {}, verify })(request("POST", event, signed), res);
    expect(out.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(stdout()).toBe("");

    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.from("local-secret")).update(`msg_2.${timestamp}.${event}`).digest("base64");
    const good = { "webhook-id": "msg_2", "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
    const accepted = response();
    await listener({ globals: {}, verify })(request("POST", event, good), accepted.res);
    expect(accepted.out.status).toBe(200);
  });

  it("answers 413 to a body over the limit and 400 to one that breaks off, without throwing", async () => {
    spies();
    const big = response();
    await listener({ globals: {} })(request("POST", "x".repeat(maxBody + 1)), big.res);
    expect(big.out.status).toBe(413);

    const broken = Object.assign(
      Readable.from(
        (async function* () {
          yield Buffer.from("{");
          throw new Error("aborted");
        })(),
      ),
      { method: "POST", headers: {} },
    ) as unknown as IncomingMessage;
    const cut = response();
    await expect(listener({ globals: {} })(broken, cut.res)).resolves.toBeUndefined();
    expect(cut.out.status).toBe(400);
  });

  it("says so when the temporary webhook could not be deleted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = { webhooks: { remove: async () => ({ data: null, error: { name: "not_found", statusCode: 404, message: "gone" }, headers: {} }) } };
    await unregister(api as unknown as Api, "wh_9");
    expect(error.mock.calls[0]![0]).toContain("Could not delete webhook wh_9");
    error.mockRestore();
  });

  it("answers 502 to Dispatch when the forward target is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    spies();
    const { res, out } = response();
    await listener({ forwardTo: "http://localhost:3000/hooks", globals: {} })(request("POST", event, signed), res);
    expect(out.status).toBe(502);
  });
});
