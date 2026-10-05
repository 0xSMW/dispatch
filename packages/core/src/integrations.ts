import { z } from "zod";

export const integrationSettingsSchema = z.object({
  map_plan: z.boolean().optional(),
  delete_contact: z.boolean().optional(),
  secret_header: z.string().regex(/^[a-zA-Z0-9-]{1,78}$/).optional(),
  stripe_restricted_key: z.string().min(1).max(1000).nullable().optional(),
}).strict();
export const integrationSchema = z.object({
  provider: z.enum(["stripe", "clerk", "supabase", "webhook"]),
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  secret: z.string().min(1).max(4096),
  settings: integrationSettingsSchema.default({}),
}).strict();
export const integrationUpdateSchema = integrationSchema.omit({ provider: true, slug: true }).partial();
export type IntegrationInput = z.infer<typeof integrationSchema>;
export type IntegrationUpdate = z.infer<typeof integrationUpdateSchema>;
export type IntegrationRecord = {
  id: string; tenant_id: string; provider: IntegrationInput["provider"]; name: string; slug: string;
  token_hash: string; secret: string; settings: z.infer<typeof integrationSettingsSchema>;
  last_received_at: string | null; created_at: string; updated_at: string; deleted_at: string | null;
};
export type Integration = Omit<IntegrationRecord, "tenant_id" | "deleted_at" | "token_hash" | "secret" | "settings"> & {
  object: "integration"; settings: Omit<IntegrationRecord["settings"], "stripe_restricted_key">; has_restricted_key: boolean;
};
export type InboundDelivery = {
  id: string; tenant_id: string; integration_id: string; provider_event_id: string;
  status: string; event_name: string | null; contact_id: string | null; error: string | null; created_at: string;
};
