import { decrypt, encrypt, encrypted, hash } from "@dispatchmail/core";
import { webhookId } from "./signatures.js";
import { supabaseEventId } from "./supabase.js";
import { header, object, text, type Headers, type RawBody } from "./types.js";

export interface InboundCredentials {
  signingSecret: string;
  stripeRestrictedKey?: string | null;
}

export interface StoredInboundCredentials {
  signingSecret: string;
  stripeRestrictedKey?: string | null;
}

export interface InboundIdentityInput {
  provider: "stripe" | "clerk" | "supabase" | "webhook";
  body: RawBody;
  headers: Headers;
}

function nonempty(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Inbound credentials and application secret must be nonempty");
  }
}

function validate(values: InboundCredentials, appSecret: string): void {
  nonempty(appSecret);
  nonempty(values.signingSecret);
  if (values.stripeRestrictedKey !== undefined && values.stripeRestrictedKey !== null) {
    nonempty(values.stripeRestrictedKey);
  }
}

export function encryptCredentials(
  values: InboundCredentials, appSecret: string
): StoredInboundCredentials {
  validate(values, appSecret);
  return {
    signingSecret: encrypt(values.signingSecret, appSecret),
    ...(values.stripeRestrictedKey !== undefined ? {
      stripeRestrictedKey: values.stripeRestrictedKey === null
        ? null : encrypt(values.stripeRestrictedKey, appSecret)
    } : {})
  };
}

export function decryptCredentials(
  values: StoredInboundCredentials, appSecret: string
): InboundCredentials {
  validate(values, appSecret);
  if (!encrypted(values.signingSecret)
    || (typeof values.stripeRestrictedKey === "string" && !encrypted(values.stripeRestrictedKey))) {
    throw new Error("Inbound credentials must be encrypted");
  }
  try {
    const result: InboundCredentials = {
      signingSecret: decrypt(values.signingSecret, appSecret),
      ...(values.stripeRestrictedKey !== undefined ? {
        stripeRestrictedKey: values.stripeRestrictedKey === null
          ? null : decrypt(values.stripeRestrictedKey, appSecret)
      } : {})
    };
    validate(result, appSecret);
    return result;
  } catch {
    // Do not propagate crypto errors or any supplied credential values.
    throw new Error("Inbound credentials could not be decrypted");
  }
}

export function inboundTokenHash(token: string): string {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Inbound token must be nonempty");
  }
  return hash(token);
}

/**
 * Identity only, never authentication. The receiver must verify the original
 * bytes with the existing signatures before using this ID as a replay key.
 */
export function inboundEventId(input: InboundIdentityInput): string | null {
  switch (input.provider) {
    case "stripe":
      try {
        const body = typeof input.body === "string" ? input.body : Buffer.from(input.body).toString("utf8");
        return text(object(JSON.parse(body))?.id) ?? null;
      } catch {
        return null;
      }
    case "clerk":
      return header(input.headers, "svix-id") ?? null;
    case "webhook":
      return webhookId(input.headers) ?? null;
    case "supabase":
      return supabaseEventId(input.body);
  }
}
