import { contactSchema } from "@dispatchmail/core";

/** The receiver must keep these bytes unchanged until verification completes. */
export type RawBody = string | Uint8Array;
/** Header names are normalized to lower case by the receiver. */
export type Headers = Readonly<Record<string, string | readonly string[] | undefined>>;
export type Verification = {
  body: RawBody;
  headers: Headers;
  secret: string;
  /** Current Unix time in seconds, supplied by the caller, never read from a clock. */
  now: number;
};

export type ContactLookup =
  | { email: string }
  | { property: "stripe_customer_id" | "clerk_user_id" | "supabase_user_id"; value: string };
/** Merge properties into existing values; never replace preferences or other properties. */
export type ContactPatch = {
  first_name?: string | null;
  last_name?: string | null;
  properties?: Record<string, unknown>;
};
export type InboundEvent = { name: string; data: Record<string, unknown> };
export type Mapping =
  // Upserts must use the receiver's live/deleted/absent lookup rule, never revive.
  | { action: "upsert"; lookup: ContactLookup; contact: ContactPatch; event: InboundEvent }
  // Retention and deletion are lookup-only: neither may create or revive a contact.
  | { action: "retain" | "delete"; lookup: ContactLookup; event: InboundEvent }
  | { action: "ignored"; reason: "unsupported_event" | "invalid_payload" | "no_contact" };

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function email(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = contactSchema.shape.email.safeParse(value.trim());
  return parsed.success ? parsed.data : undefined;
}

export function header(headers: Headers, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  // A list must not silently select one conflicting security header.
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
