import { createHash } from "node:crypto";
import { email, object, text, type Mapping, type RawBody } from "./types.js";

/** Database Webhooks do not include a delivery ID or signing timestamp. */
export function supabaseEventId(body: RawBody): string {
  let commitTimestamp = "";
  try {
    const parsed = object(JSON.parse(typeof body === "string" ? body : Buffer.from(body).toString("utf8")));
    commitTimestamp = text(parsed?.commit_timestamp) ?? "";
  } catch {
    // Invalid bodies can still be assigned a stable ID for failed-delivery bookkeeping.
  }
  return createHash("sha256").update(body).update(commitTimestamp).digest("hex");
}

export function mapSupabase(payload: unknown): Mapping {
  const envelope = object(payload);
  if (!envelope) return { action: "ignored", reason: "invalid_payload" };
  if (envelope.schema !== "auth" || envelope.table !== "users" || (envelope.type !== "INSERT" && envelope.type !== "UPDATE")) {
    return { action: "ignored", reason: "unsupported_event" };
  }
  const user = object(envelope.record);
  const id = text(user?.id);
  if (!user || !id) return { action: "ignored", reason: "invalid_payload" };
  const recipient = email(user.email);
  if (!recipient) return { action: "ignored", reason: "no_contact" };
  const metadata = object(user.raw_user_meta_data);
  const contact = {
    ...(typeof metadata?.first_name === "string" ? { first_name: metadata.first_name } : {}),
    ...(typeof metadata?.last_name === "string" ? { last_name: metadata.last_name } : {}),
    properties: { supabase_user_id: id }
  };
  return {
    action: "upsert", lookup: { email: recipient }, contact,
    event: {
      name: envelope.type === "INSERT" ? "supabase.user.created" : "supabase.user.updated",
      // Do not propagate encrypted_password, tokens, or arbitrary auth record fields.
      data: { user_id: id, email: recipient, ...contact }
    }
  };
}
