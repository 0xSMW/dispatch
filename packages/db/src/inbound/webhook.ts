import { contactUpdateSchema } from "@dispatchmail/core";
import { email, object, text, type Mapping } from "./types.js";

export function webhookSlug(slug: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/.test(slug) && !["stripe", "clerk", "supabase"].includes(slug);
}

export function mapWebhook(payload: unknown, slug = "webhook"): Mapping {
  const envelope = object(payload);
  const event = text(envelope?.event);
  const name = event ? `${slug}.${event}` : "";
  if (!envelope || !webhookSlug(slug) || !event || event.startsWith("@") || name.length > 120) {
    return { action: "ignored", reason: "invalid_payload" };
  }
  const recipient = email(envelope.email);
  if (!recipient) return { action: "ignored", reason: "no_contact" };
  const data = object(envelope.data);
  if (!data) return { action: "ignored", reason: "invalid_payload" };
  const contact = contactUpdateSchema.pick({ first_name: true, last_name: true, properties: true })
    .strict().safeParse(envelope.contact ?? {});
  if (!contact.success) return { action: "ignored", reason: "invalid_payload" };
  return {
    action: "upsert", lookup: { email: recipient }, contact: contact.data,
    event: { name, data }
  };
}
