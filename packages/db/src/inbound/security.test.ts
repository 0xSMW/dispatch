import { createCipheriv, createHash } from "node:crypto";
import { decrypt, encrypt, encrypted, hash } from "@dispatchmail/core";
import { describe, expect, it } from "vitest";
import {
  decryptCredentials, encryptCredentials, inboundEventId, inboundTokenHash,
  type InboundCredentials, type StoredInboundCredentials
} from "./security.js";
import { webhookId } from "./signatures.js";
import { supabaseEventId } from "./supabase.js";
import { header, type Headers } from "./types.js";

const appSecret = "synthetic_application_secret";
const credentials = Object.freeze({
  signingSecret: "synthetic_signing_secret",
  stripeRestrictedKey: "synthetic_restricted_key"
});

// Synthetic read-compatibility fixture only; production encryption stays in core.
function legacy(value: string): string {
  const iv = Buffer.alloc(12, 7);
  const key = createHash("sha256").update(appSecret).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

function failure(action: () => unknown): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  for (const value of [appSecret, credentials.signingSecret, credentials.stripeRestrictedKey]) {
    expect((caught as Error).message).not.toContain(value);
  }
}

describe("inbound credential storage", () => {
  it("uses core encryption with fresh IVs and leaves credentials untouched", () => {
    const stored = encryptCredentials(credentials, appSecret);
    const again = encryptCredentials(credentials, appSecret);
    for (const field of ["signingSecret", "stripeRestrictedKey"] as const) {
      expect(encrypted(stored[field]!)).toBe(true);
      expect(decrypt(stored[field]!, appSecret)).toBe(credentials[field]);
      expect(stored[field]).not.toContain(credentials[field]);
      expect(again[field]).not.toBe(stored[field]);
    }
    expect(decryptCredentials(Object.freeze(stored), appSecret)).toEqual(credentials);
    expect(credentials).toEqual({
      signingSecret: "synthetic_signing_secret", stripeRestrictedKey: "synthetic_restricted_key"
    });
  });

  it.each([{}, { stripeRestrictedKey: null }])("preserves optional key shape %j", (optional) => {
    const input = Object.freeze({ signingSecret: credentials.signingSecret, ...optional });
    const stored = encryptCredentials(input, appSecret);
    expect(Object.hasOwn(stored, "stripeRestrictedKey")).toBe(Object.hasOwn(input, "stripeRestrictedKey"));
    expect(decryptCredentials(stored, appSecret)).toEqual(input);
  });

  it("reads existing core v1 and v2 values without changing their format", () => {
    expect(decryptCredentials({
      signingSecret: legacy(credentials.signingSecret),
      stripeRestrictedKey: encrypt(credentials.stripeRestrictedKey, appSecret)
    }, appSecret)).toEqual(credentials);
    expect(decryptCredentials({
      signingSecret: encrypt(credentials.signingSecret, appSecret),
      stripeRestrictedKey: legacy(credentials.stripeRestrictedKey)
    }, appSecret)).toEqual(credentials);
  });

  it("rejects empty credentials, invalid optional keys and empty application secrets", () => {
    for (const input of [
      { ...credentials, signingSecret: "" }, { ...credentials, stripeRestrictedKey: "" },
      { ...credentials, signingSecret: null }, { ...credentials, stripeRestrictedKey: 42 }
    ]) {
      failure(() => encryptCredentials(input as InboundCredentials, appSecret));
      failure(() => decryptCredentials(input as StoredInboundCredentials, appSecret));
    }
    failure(() => encryptCredentials(credentials, ""));
    failure(() => decryptCredentials(encryptCredentials(credentials, appSecret), ""));
  });

  it("rejects plaintext in either stored field instead of core's legacy fallback", () => {
    const stored = encryptCredentials(credentials, appSecret);
    failure(() => decryptCredentials(credentials, appSecret));
    failure(() => decryptCredentials({ ...stored, signingSecret: credentials.signingSecret }, appSecret));
    failure(() => decryptCredentials({ ...stored, stripeRestrictedKey: credentials.stripeRestrictedKey }, appSecret));
  });

  it("rejects malformed ciphertext, wrong keys and encrypted empty credentials without leaks", () => {
    const stored = encryptCredentials(credentials, appSecret);
    for (const value of ["enc:v1:bad", "enc:v2:bad", "enc:v2:a.b.c", encrypt("", appSecret)]) {
      failure(() => decryptCredentials({ ...stored, signingSecret: value }, appSecret));
      failure(() => decryptCredentials({ ...stored, stripeRestrictedKey: value }, appSecret));
    }
    failure(() => decryptCredentials(stored, "synthetic_wrong_key"));
  });
});

describe("inbound opaque token hashes", () => {
  it("calls the existing hash without trimming, case folding or changing token grammar", () => {
    const tokens = ["synthetic_token", "SYNTHETIC_TOKEN", " synthetic_token ", " "];
    for (const token of tokens) {
      expect(inboundTokenHash(token)).toBe(hash(token));
      expect(inboundTokenHash(token)).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(new Set(tokens.map(inboundTokenHash)).size).toBe(tokens.length);
    expect(() => inboundTokenHash("")).toThrow("Inbound token must be nonempty");
  });
});

describe("inbound provider identities (not authentication)", () => {
  it("reads Stripe IDs from original strings and byte views without mutating input", () => {
    const body = `{\n "id": "evt_synthetic", "ignored": "é"\n}\n`;
    const bytes = Buffer.from(`prefix${body}suffix`).subarray(6, 6 + Buffer.byteLength(body));
    const before = Buffer.from(bytes);
    for (const raw of [body, bytes, Uint8Array.from(bytes)]) {
      expect(inboundEventId({ provider: "stripe", body: raw, headers: {} })).toBe("evt_synthetic");
      expect(inboundEventId({ provider: "stripe", body: raw, headers: {} })).toBe("evt_synthetic");
    }
    expect(bytes).toEqual(before);
  });

  it.each(["not json", "null", "[]", "{}", '{"id":""}', '{"id":42}', '{"id":null}', '{"id":{}}'])(
    "returns null for missing or malformed Stripe identity %s", (body) => {
      expect(inboundEventId({ provider: "stripe", body, headers: {} })).toBeNull();
    }
  );

  it("uses only Clerk's existing single-valued svix-id header", () => {
    for (const headers of [
      {}, { "svix-id": "" }, { "svix-id": ["msg_a", "msg_b"] },
      { "webhook-id": "not_clerk" }, { "svix-id": "msg_synthetic" }
    ] satisfies Headers[]) {
      expect(inboundEventId({ provider: "clerk", body: "not json", headers }))
        .toBe(header(headers, "svix-id") ?? null);
    }
  });

  it("preserves Standard Webhooks family precedence and conflicting array refusal", () => {
    const cases: [Headers, string | null][] = [
      [{}, null],
      [{ "svix-id": "svix_synthetic" }, "svix_synthetic"],
      [{ "webhook-id": "webhook_synthetic", "svix-id": "svix_synthetic" }, "webhook_synthetic"],
      [{ "webhook-timestamp": "123", "svix-id": "svix_synthetic" }, null],
      [{ "webhook-signature": ["one", "two"], "svix-id": "svix_synthetic" }, null],
      [{ "webhook-id": ["one", "two"], "svix-id": "svix_synthetic" }, null],
      [{ "svix-id": ["one", "two"] }, null],
      [{ "webhook-id": "", "svix-id": "svix_synthetic" }, null]
    ];
    for (const [headers, expected] of cases) {
      Object.freeze(headers);
      expect(inboundEventId({ provider: "webhook", body: "not json", headers })).toBe(expected);
      expect(inboundEventId({ provider: "webhook", body: "not json", headers })).toBe(webhookId(headers) ?? null);
    }
  });

  it("delegates Supabase hashing to the original raw-body/commit-timestamp helper", () => {
    const body = '{\n "commit_timestamp": "2026-10-04T12:00:00Z", "record": {"id":"synthetic"}\n}\n';
    const bodies = [
      body, JSON.stringify(JSON.parse(body)), body.replace("12:00:00", "12:00:01"),
      '{"record":{}}', "not json", Uint8Array.from([0xff, 0, 0xfe])
    ];
    const identities = bodies.map((raw) => {
      const before = typeof raw === "string" ? raw : Uint8Array.from(raw);
      const input = { provider: "supabase" as const, body: raw, headers: {} };
      const id = inboundEventId(input);
      expect(id).toBe(supabaseEventId(raw));
      expect(inboundEventId(input)).toBe(id);
      expect(raw).toEqual(before);
      return id;
    });
    expect(new Set(identities).size).toBe(bodies.length);
  });
});
