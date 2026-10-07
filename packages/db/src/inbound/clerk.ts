import { email, object, text, type Mapping } from "./types.js";

export type ClerkOptions = {
  /** Off by default. This is contact deletion, not privacy erasure. */
  deleteContact?: boolean;
};

export function mapClerk(payload: unknown, options: ClerkOptions = {}): Mapping {
  const envelope = object(payload);
  const type = text(envelope?.type);
  if (!type || !["user.created", "user.updated", "user.deleted"].includes(type)) {
    return { action: "ignored", reason: type ? "unsupported_event" : "invalid_payload" };
  }
  const user = object(envelope?.data);
  const id = text(user?.id);
  if (!user || !id) return { action: "ignored", reason: "invalid_payload" };
  if (type === "user.deleted") {
    return {
      action: options.deleteContact === true ? "delete" : "retain",
      lookup: { property: "clerk_user_id", value: id },
      event: { name: "clerk.user.deleted", data: { user_id: id } }
    };
  }
  const primary = text(user.primary_email_address_id);
  const addresses = Array.isArray(user.email_addresses) ? user.email_addresses : [];
  const address = addresses.map(object).find((entry) => primary && entry?.id === primary);
  const recipient = email(address?.email_address);
  // Never choose an arbitrary secondary address or turn a phone-only account into a contact.
  if (!recipient) return { action: "ignored", reason: "no_contact" };
  const contact = {
    ...(typeof user.first_name === "string" || user.first_name === null ? { first_name: user.first_name } : {}),
    ...(typeof user.last_name === "string" || user.last_name === null ? { last_name: user.last_name } : {}),
    properties: { clerk_user_id: id }
  };
  return {
    action: "upsert", lookup: { email: recipient }, contact,
    event: { name: `clerk.${type}`, data: { user_id: id, email: recipient, ...contact } }
  };
}
