import { z } from "zod";

const addressPattern = /^\s*(?:"?([^"<>]*?)"?\s*)<([^<>\s]+)>\s*$/;

export function parseAddress(value: string) {
  const match = value.match(addressPattern);
  const email = (match ? match[2] : value).trim();
  const name = match?.[1]?.trim() || null;
  return { email, name };
}

export const address = z
  .string()
  .max(998)
  .refine((value) => !/[\r\n]/.test(value), "must not contain line breaks")
  .refine((value) => z.string().email().safeParse(parseAddress(value).email).success, "must be email@domain or Name <email@domain>");

export const addresses = z.union([address, z.array(address).min(1).max(50)]);

export const templateRef = z
  .union([
    z.string().min(1).max(120),
    z.object({ id: z.string().min(1).max(120), variables: z.record(z.string(), z.unknown()).optional() })
  ])
  .transform((value): { id: string; variables?: Record<string, unknown> } => (typeof value === "string" ? { id: value } : value));
