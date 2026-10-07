import { createHmac } from "node:crypto";
import { signWebhook } from "@dispatchmail/core";
import { describe, expect, it, vi } from "vitest";
import { verifyClerk, verifyStripe, verifySupabase, verifyWebhook, webhookId } from "./signatures.js";
import type { RawBody, Verification } from "./types.js";

const now = 1_800_000_000;
const body = '{\n  "message": "héllo", "n": 1\n}\n';
const stripeSecret = "synthetic_stripe_signing_secret";
const standardSecret = `whsec_${Buffer.from("synthetic_standard_signing_secret").toString("base64")}`;

function stripe(raw: RawBody = body, time = now): Verification {
  const signature = createHmac("sha256", stripeSecret).update(`${time}.`).update(raw).digest("hex");
  return { body: raw, secret: stripeSecret, now, headers: { "stripe-signature": `t=${time},v1=${signature}` } };
}

function standard(prefix: "svix" | "webhook", raw: RawBody = body, time = now): Verification {
  const signature = createHmac("sha256", Buffer.from(standardSecret.slice(6), "base64"))
    .update(`msg_synthetic.${time}.`).update(raw).digest("base64");
  return {
    body: raw, secret: standardSecret, now,
    headers: {
      [`${prefix}-id`]: "msg_synthetic", [`${prefix}-timestamp`]: String(time),
      [`${prefix}-signature`]: `v1,${signature}`
    }
  };
}

describe("Stripe raw-body verification", () => {
  it("verifies strings and bytes without JSON normalization", () => {
    expect(verifyStripe(stripe())).toBe(true);
    expect(verifyStripe(stripe(Buffer.from(body)))).toBe(true);
    const raw = Uint8Array.from([0x7b, 0xff, 0x7d, 0x0a]);
    expect(verifyStripe(stripe(raw))).toBe(true);
    expect(verifyStripe({ ...stripe(raw), body: Buffer.from(raw).toString("utf8") })).toBe(false);
  });

  it("rejects tampering, whitespace changes and the wrong signing secret", () => {
    expect(verifyStripe({ ...stripe(), body: body.replace("héllo", "bye") })).toBe(false);
    expect(verifyStripe({ ...stripe(), body: JSON.stringify(JSON.parse(body)) })).toBe(false);
    expect(verifyStripe({ ...stripe(), body: body.trim() })).toBe(false);
    expect(verifyStripe({ ...stripe(), secret: "other" })).toBe(false);
  });

  it("accepts any valid v1 rotation signature and ignores other versions", () => {
    const request = stripe();
    const valid = request.headers["stripe-signature"];
    expect(verifyStripe({ ...request, headers: { "stripe-signature": `v0=garbage,v1=${"0".repeat(64)}, ${valid}` } })).toBe(true);
    expect(verifyStripe({ ...request, headers: { "stripe-signature": String(valid).replace("v1=", "v0=") } })).toBe(false);
    expect(verifyStripe({ ...request, headers: { "stripe-signature": `${valid},v1=bad` } })).toBe(true);
  });

  it("checks the inclusive 300 second window in both directions", () => {
    for (const offset of [-300, 0, 300]) expect(verifyStripe(stripe(body, now + offset))).toBe(true);
    for (const offset of [-301, 301]) expect(verifyStripe(stripe(body, now + offset))).toBe(false);
    expect(verifyStripe({ ...stripe(), now: NaN })).toBe(false);
    expect(verifyStripe({ ...stripe(), now: Infinity })).toBe(false);
  });

  it("rejects missing, repeated or malformed security headers", () => {
    const request = stripe();
    for (const value of [undefined, "", "v1=bad", `t=,v1=${"0".repeat(64)}`, `t=NaN,v1=${"0".repeat(64)}`,
      `t=${now + 0.5},v1=${"0".repeat(64)}`, `t=9007199254740992,v1=${"0".repeat(64)}`,
      `${request.headers["stripe-signature"]},t=${now}`]) {
      expect(verifyStripe({ ...request, headers: { "stripe-signature": value } })).toBe(false);
    }
    expect(verifyStripe({ ...request, headers: { "stripe-signature": [String(request.headers["stripe-signature"])] } })).toBe(false);
    expect(verifyStripe({ ...request, secret: "" })).toBe(false);
  });
});

describe.each([
  { label: "Clerk", prefix: "svix" as const, verify: verifyClerk },
  { label: "Standard Webhooks", prefix: "webhook" as const, verify: verifyWebhook }
])("$label raw-body verification", ({ prefix, verify }) => {
  it("matches the existing core signer and authenticates unchanged bytes", () => {
    const signed = signWebhook(body, [standardSecret], "msg_synthetic", now);
    const request = standard(prefix);
    expect(request.headers[`${prefix}-signature`]).toBe(signed.signature);
    expect(verify(request)).toBe(true);
    expect(verify(standard(prefix, Buffer.from(body)))).toBe(true);
    const raw = Uint8Array.from([0x7b, 0xff, 0x7d]);
    expect(verify(standard(prefix, raw))).toBe(true);
    expect(verify({ ...standard(prefix, raw), body: Buffer.from(raw).toString("utf8") })).toBe(false);
  });

  it("rejects tampered payloads, normalized whitespace and message IDs", () => {
    const request = standard(prefix);
    expect(verify({ ...request, body: `${body} ` })).toBe(false);
    expect(verify({ ...request, body: JSON.stringify(JSON.parse(body)) })).toBe(false);
    expect(verify({ ...request, headers: { ...request.headers, [`${prefix}-id`]: "another" } })).toBe(false);
    expect(verify({ ...request, secret: `whsec_${Buffer.from("wrong").toString("base64")}` })).toBe(false);
  });

  it("accepts rotation signatures but not matching bytes under the wrong version", () => {
    const request = standard(prefix);
    const key = `${prefix}-signature`;
    const valid = String(request.headers[key]);
    expect(verify({ ...request, headers: { ...request.headers, [key]: `v1,${Buffer.alloc(32).toString("base64")} ${valid}` } })).toBe(true);
    expect(verify({ ...request, headers: { ...request.headers, [key]: `${valid} v2,garbage` } })).toBe(true);
    expect(verify({ ...request, headers: { ...request.headers, [key]: valid.replace("v1,", "v2,") } })).toBe(false);
    expect(verify({ ...request, headers: { ...request.headers, [key]: valid.slice(3) } })).toBe(false);
    expect(verify({ ...request, headers: { ...request.headers, [key]: `${valid}!` } })).toBe(false);
  });

  it("checks the deterministic inclusive timestamp window", () => {
    for (const offset of [-300, 0, 300]) expect(verify(standard(prefix, body, now + offset))).toBe(true);
    for (const offset of [-301, 301]) expect(verify(standard(prefix, body, now + offset))).toBe(false);
    for (const time of ["", "NaN", "1e9", "-1", "9007199254740992"]) {
      expect(verify({ ...standard(prefix), headers: { ...standard(prefix).headers, [`${prefix}-timestamp`]: time } })).toBe(false);
    }
    expect(verify({ ...standard(prefix), now: NaN })).toBe(false);
  });

  it("rejects missing/repeated headers and invalid signing material", () => {
    const request = standard(prefix);
    for (const name of ["id", "timestamp", "signature"]) {
      const key = `${prefix}-${name}`;
      expect(verify({ ...request, headers: { ...request.headers, [key]: undefined } })).toBe(false);
      expect(verify({ ...request, headers: { ...request.headers, [key]: [String(request.headers[key])] } })).toBe(false);
    }
    for (const secret of ["", "whsec_", "whsec_!bad!", "whsec_a"]) expect(verify({ ...request, secret })).toBe(false);
    expect(verify({ ...request, secret: standardSecret.slice(6) })).toBe(true);
  });
});

describe("header family selection", () => {
  it("does not consult an ambient clock for verification", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("Ambient clock used"); });
    try {
      expect(verifyStripe(stripe())).toBe(true);
      expect(verifyClerk(standard("svix"))).toBe(true);
      expect(verifyWebhook(standard("webhook"))).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("supports Svix aliases for Standard Webhooks and extracts the matching ID", () => {
    expect(verifyWebhook(standard("svix"))).toBe(true);
    expect(webhookId(standard("svix").headers)).toBe("msg_synthetic");
    expect(webhookId(standard("webhook").headers)).toBe("msg_synthetic");
    expect(webhookId({ "webhook-id": ["a", "b"] })).toBeUndefined();
    expect(verifyClerk(standard("webhook"))).toBe(false);
  });

  it("never mixes partial families or downgrades a bad webhook family to Svix", () => {
    const request = standard("svix");
    expect(verifyWebhook({ ...request, headers: { ...request.headers, "webhook-id": "other" } })).toBe(false);
    expect(webhookId({ ...request.headers, "webhook-timestamp": String(now) })).toBeUndefined();
    const mixed = { "svix-id": "msg_synthetic", "webhook-timestamp": String(now), "svix-signature": request.headers["svix-signature"] };
    expect(verifyWebhook({ ...request, headers: mixed })).toBe(false);
  });
});

describe("Supabase Database Webhooks shared-header verification", () => {
  const request = { body, headers: { "x-dispatch-secret": "synthetic_shared_secret" }, secret: "synthetic_shared_secret", header: "X-Dispatch-Secret", now };

  it("compares the configured header rather than pretending to authenticate body or time", () => {
    expect(verifySupabase(request)).toBe(true);
    expect(verifySupabase({ ...request, body: "different payload", now: 0 })).toBe(true);
    expect(verifySupabase({ ...request, headers: { "x-dispatch-secret": "synthetic_shared_secreu" } })).toBe(false);
    expect(verifySupabase({ ...request, headers: { "x-dispatch-secret": "synthetic_shared_secret " } })).toBe(false);
  });

  it("rejects missing, repeated, wrong and empty material", () => {
    expect(verifySupabase({ ...request, headers: {} })).toBe(false);
    expect(verifySupabase({ ...request, headers: { "x-dispatch-secret": ["synthetic_shared_secret"] } })).toBe(false);
    expect(verifySupabase({ ...request, header: "authorization" })).toBe(false);
    expect(verifySupabase({ ...request, header: "bad header" })).toBe(false);
    expect(verifySupabase({ ...request, secret: "" })).toBe(false);
    expect(verifySupabase({ ...request, headers: { "x-dispatch-secret": "" } })).toBe(false);
  });
});
