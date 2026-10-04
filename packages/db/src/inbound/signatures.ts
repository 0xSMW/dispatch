import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { header, type Headers, type Verification } from "./types.js";

const tolerance = 300;

function timestamp(value: string | undefined, now: number): value is string {
  if (!value || !/^\d+$/.test(value) || !Number.isFinite(now) || now < 0) return false;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && Math.abs(Math.floor(now) - seconds) <= tolerance;
}

function base64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")
    ? bytes : null;
}

export function verifyStripe({ body, headers, secret, now }: Verification): boolean {
  const value = header(headers, "stripe-signature");
  if (!value || !secret) return false;
  const entries = value.split(",").map((entry) => entry.trim());
  const timestamps = entries.filter((entry) => entry.startsWith("t="));
  if (timestamps.length !== 1) return false;
  const time = timestamps[0]!.slice(2);
  if (!timestamp(time, now)) return false;
  const expected = createHmac("sha256", secret).update(`${time}.`).update(body).digest();
  return entries.some((entry) => {
    if (!/^v1=[a-fA-F0-9]{64}$/.test(entry)) return false;
    const given = Buffer.from(entry.slice(3), "hex");
    return timingSafeEqual(given, expected);
  });
}

/** Same v1 HMAC wire format as core's verifyWebhook, with an explicit clock and raw bytes. */
function verifyStandard(input: Verification, prefix: "svix" | "webhook"): boolean {
  const { body, headers, secret, now } = input;
  const id = header(headers, `${prefix}-id`);
  const time = header(headers, `${prefix}-timestamp`);
  const signatures = header(headers, `${prefix}-signature`);
  const key = base64(secret.replace(/^whsec_/, ""));
  if (!id || !timestamp(time, now) || !signatures || !key) return false;
  const expected = createHmac("sha256", key).update(`${id}.${time}.`).update(body).digest();
  return signatures.split(/\s+/).some((entry) => {
    if (!entry.startsWith("v1,")) return false;
    const given = base64(entry.slice(3));
    return given?.length === expected.length && timingSafeEqual(given, expected);
  });
}

export function verifyClerk(input: Verification): boolean {
  return verifyStandard(input, "svix");
}

export function verifyWebhook(input: Verification): boolean {
  // Select one complete header family. Never combine headers from different families.
  const hasWebhook = ["webhook-id", "webhook-timestamp", "webhook-signature"]
    .some((key) => input.headers[key] !== undefined);
  return verifyStandard(input, hasWebhook ? "webhook" : "svix");
}

/** Database Webhooks have a configured shared header, not Auth Hook/Svix signatures. */
export function verifySupabase(input: Verification & { header: string }): boolean {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(input.header) || !input.secret) return false;
  const value = header(input.headers, input.header);
  if (!value) return false;
  // Hash both strings so the timing-safe comparison always uses equal-length buffers.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(value), digest(input.secret));
}

export function webhookId(headers: Headers): string | undefined {
  const hasWebhook = ["webhook-id", "webhook-timestamp", "webhook-signature"]
    .some((key) => headers[key] !== undefined);
  return header(headers, hasWebhook ? "webhook-id" : "svix-id");
}
