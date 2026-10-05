import { z } from "zod";

export const formHoneypot = "website";
export const formSuccess = { object: "form_submission" as const, message: "Thank you. Check your email if confirmation is needed." };
const origin = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}, "Use an exact HTTP or HTTPS origin");
const redirect = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "Use an HTTPS redirect URL without credentials");
const fields = z.object({
  name: z.string().trim().min(1).max(120),
  topic_ids: z.array(z.string().min(1)).min(1).max(100),
  properties: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/).max(120)
    .refine((key) => !["email", "first_name", "last_name", "website", "__proto__", "constructor", "prototype"].includes(key))).max(100).default([]),
  double_opt_in: z.boolean().default(true),
  from_email: z.string().email().max(320),
  allowed_origins: z.array(origin).min(1).max(50),
  redirect_url: redirect.nullable().optional().default(null),
}).strict();
export const formSchema = fields;
export const formUpdateSchema = fields.partial();
export const formSubmissionSchema = z.object({
  email: z.string().email().max(320).transform((value) => value.toLowerCase()),
  first_name: z.string().max(120).optional(), last_name: z.string().max(120).optional(),
});
export type FormInput = z.infer<typeof formSchema>;
export type FormUpdate = z.infer<typeof formUpdateSchema>;
export type FormRecord = FormInput & {
  id: string; tenant_id: string; key: string; created_at: string; updated_at: string; deleted_at: string | null;
};
export type Form = Omit<FormRecord, "tenant_id" | "deleted_at"> & { object: "form" };
export type Confirmation = {
  object: "confirmation"; form_name: string; confirmed: boolean;
  brand: { product_name: string; logo_url: string | null; primary_color: string; background_color: string; text_color: string };
};
export type Confirmed = { object: "confirmation"; confirmed: true; redirect_url: string | null };
