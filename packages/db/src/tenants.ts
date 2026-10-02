import { ApiError, hashPassword, id, keyHash, makeKey, passwordSchema } from "@dispatchmail/core";
import type { Db } from "./index.js";
import { tx } from "./index.js";
import { installLibrary, type LibraryInstallEntry } from "./templates.js";

export type NewTenant = {
  name: string;
  /** The first user, who signs in to the dashboard with this email and password. */
  email: string;
  password: string;
  userName?: string;
  pepper: string;
  library?: { version?: string; templates: LibraryInstallEntry[] };
};

/**
 * A tenant with one admin, an Admin and a Viewer role, and one full-access key, and nothing
 * else: no sample domain and no sample webhook. This is how a production install gets its first
 * tenant. The key is returned once and stored only as a hash.
 */
export async function createTenant(db: Db, input: NewTenant) {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) throw new ApiError("validation_error", 422, "A tenant needs a name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError("validation_error", 422, "The first user needs an email address");
  if (!passwordSchema.safeParse(input.password).success) throw new ApiError("validation_error", 422, "The first user needs a password of 12 to 200 characters");
  const { secret, prefix } = makeKey();
  const passwordHash = await hashPassword(input.password);
  return tx(db, async (client) => {
    const tenantId = id("tenant");
    const userId = id("user");
    const roleId = id("role");
    await client.query("insert into tenants (id, name) values ($1, $2)", [tenantId, name]);
    await client.query("insert into users (id, tenant_id, email, name, password_hash) values ($1, $2, $3, $4, $5)", [
      userId,
      tenantId,
      email,
      input.userName?.trim() || email.split("@")[0],
      passwordHash,
    ]);
    await client.query("insert into roles (id, tenant_id, name, permissions) values ($1, $2, 'Admin', $3)", [
      roleId,
      tenantId,
      JSON.stringify(["full"]),
    ]);
    await client.query("insert into roles (id, tenant_id, name, permissions) values ($1, $2, 'Viewer', $3)", [
      id("role"),
      tenantId,
      JSON.stringify(["read"]),
    ]);
    await client.query("insert into memberships (id, tenant_id, user_id, role_id) values ($1, $2, $3, $4)", [
      id("member"),
      tenantId,
      userId,
      roleId,
    ]);
    await client.query(
      "insert into api_keys (id, tenant_id, name, prefix, hash, scope, created_by) values ($1, $2, 'owner', $3, $4, 'full', $5)",
      [id("key"), tenantId, prefix, keyHash(secret, input.pepper), userId],
    );
    for (const entry of input.library?.templates ?? []) {
      await installLibrary(client, tenantId, [entry], input.library?.version ?? "1.0.0");
    }
    return { tenant_id: tenantId, user_id: userId, email, api_key: secret };
  });
}
