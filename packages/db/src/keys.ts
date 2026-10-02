import { timingSafeEqual } from "node:crypto";
import { keyHash } from "@dispatchmail/core";
import type { Queryable } from "./index.js";

export type ApiKeyRow = {
  id: string;
  tenant_id: string;
  hash: string;
  scope: "full" | "send";
  domain_id: string | null;
  domain_name: string | null;
  last_used_at: string | null;
};

// Looks up an unrevoked API key by its 12-character prefix and checks the
// peppered hash in constant time. Returns null for an unknown, revoked, or wrong key.
export async function findApiKey(db: Queryable, secret: string, pepper: string) {
  const prefix = secret.slice(0, 12);
  const row = await db.query<ApiKeyRow>(
    `select k.id, k.tenant_id, k.hash, k.scope, k.last_used_at, k.domain_id, d.name as domain_name
     from api_keys k
     left join domains d on d.id = k.domain_id and d.tenant_id = k.tenant_id
     where k.prefix = $1 and k.revoked_at is null
     limit 1`,
    [prefix],
  );
  const apiKey = row.rows[0];
  if (!apiKey || !keyMatches(apiKey.hash, secret, pepper)) return null;
  return apiKey;
}

export function keyMatches(stored: string, secret: string, pepper: string) {
  const left = Buffer.from(stored, "hex");
  const right = Buffer.from(keyHash(secret, pepper), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
