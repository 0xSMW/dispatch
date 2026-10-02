import { createHmac, timingSafeEqual } from "node:crypto";

// Standard Webhooks verification, the scheme Svix and resend.webhooks.verify() use.
// Kept here instead of importing verifyWebhook() from @dispatchmail/core, because a value
// import of core pulls zod and node:dns into the SDK bundle.

export type WebhookHeaders = { id: string; timestamp: string; signature: string };

export type VerifyInput = {
  payload: string;
  headers: WebhookHeaders;
  webhookSecret: string;
};

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const tolerance = 5 * 60;

export function verifyWebhook<T = unknown>({ payload, headers, webhookSecret }: VerifyInput): T {
  if (!headers?.id || !headers.timestamp || !headers.signature) {
    throw new WebhookVerificationError("Missing required headers");
  }
  const timestamp = Number(headers.timestamp);
  if (!Number.isInteger(timestamp)) throw new WebhookVerificationError("Invalid Signature Headers");
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > tolerance) throw new WebhookVerificationError("Message timestamp too old");
  if (timestamp > now + tolerance) throw new WebhookVerificationError("Message timestamp too new");

  const key = Buffer.from(webhookSecret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${payload}`).digest();
  const matched = headers.signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matched) throw new WebhookVerificationError("No matching signature found");
  return JSON.parse(payload) as T;
}
