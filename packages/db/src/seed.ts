import "@dispatchmail/core/env";
import { readFile } from "node:fs/promises";
import { ApiError, devPassword, encrypt, hashPassword, keyHash, makeWebhookSecret, requireSecret, seedKey, seedPassword } from "@dispatchmail/core";
import { connect, tx } from "./index.js";
import { installLibrary, type LibraryInstallEntry } from "./templates.js";

const db = connect();
const pepper = requireSecret("API_KEY_PEPPER");
const tenantId = "tenant_dev";
const userId = "user_dev";
const roleId = "role_owner";
const viewerId = "role_viewer";
const membershipId = "member_dev";
const domainId = "domain_dev";
const keyId = "key_dev";
const webhookId = "webhook_dev";
// Refuses to run in production with no key, or with the public development key.
const secret = seedKey();
const prefix = secret.slice(0, 12);
// The same rule for the operator's password: DISPATCH_PASSWORD, or the development password
// outside production.
const password = seedPassword();
const passwordHash = await hashPassword(password);

const library = JSON.parse(
  await readFile(new URL("../../templates/library.json", import.meta.url), "utf8"),
) as { version?: string; templates: LibraryInstallEntry[] };

try {
  await tx(db, async (client) => {
    await client.query(
      `insert into tenants (id, name) values ($1, $2)
       on conflict (id) do update set name = excluded.name`,
      [tenantId, "Local"]
    );

    await client.query(
      `insert into users (id, tenant_id, email, name, password_hash)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, email) do update set name = excluded.name, password_hash = coalesce(users.password_hash, excluded.password_hash), updated_at = now()`,
      [userId, tenantId, "operator@example.test", "Operator", passwordHash]
    );
    // Seeding again keeps an existing password, and leaves a deactivated operator deactivated
    // and a changed role changed, so a rerun cannot undo what an admin did.
    // The development password is public, so it is printed. A private one is not.
    console.log(`user operator@example.test, password ${password === devPassword ? password : "from DISPATCH_PASSWORD"}`);

    await client.query(
      `insert into roles (id, tenant_id, name, permissions)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, name) do update set permissions = excluded.permissions, deleted_at = null, updated_at = now()`,
      [roleId, tenantId, "Admin", JSON.stringify(["full"])]
    );

    await client.query(
      `insert into roles (id, tenant_id, name, permissions)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, name) do update set permissions = excluded.permissions, deleted_at = null, updated_at = now()`,
      [viewerId, tenantId, "Viewer", JSON.stringify(["read"])]
    );

    await client.query(
      `insert into memberships (id, tenant_id, user_id, role_id)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, user_id) do nothing`,
      [membershipId, tenantId, userId, roleId]
    );

    await client.query(
      `insert into domains (id, tenant_id, name, region, status, records, checked_at, open_tracking, click_tracking)
       values ($1, $2, $3, $4, 'verified', $5, now(), true, true)
       on conflict (tenant_id, name) do update set status = 'verified', checked_at = now(), open_tracking = true, click_tracking = true`,
      [
        domainId,
        tenantId,
        "example.com",
        process.env.AWS_REGION ?? "us-east-1",
        JSON.stringify([
          { type: "TXT", name: "example.com", value: "v=spf1 include:amazonses.com ~all", status: "valid" },
          { type: "CNAME", name: "links.example.com", value: "links.localhost", status: "valid" }
        ])
      ]
    );

    await client.query(
      `insert into api_keys (id, tenant_id, name, prefix, hash, scope)
       values ($1, $2, $3, $4, $5, 'full')
       on conflict (id) do update set prefix = excluded.prefix, hash = excluded.hash, revoked_at = null`,
      [keyId, tenantId, "local", prefix, keyHash(secret, pepper)]
    );
    console.log(`DISPATCH_API_KEY=${secret}`);

    await client.query(
      `insert into webhooks (id, tenant_id, url, events, secret)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update set url = excluded.url, events = excluded.events, updated_at = now()`,
      [
        webhookId,
        tenantId,
        process.env.WEBHOOK_URL ?? "http://localhost:8787/webhooks",
        JSON.stringify(["email.sent", "email.delivered", "email.bounced", "email.complained", "email.failed"]),
        // A Standard Webhooks secret, stored encrypted like one the API creates. An existing
        // seeded webhook keeps the secret it has.
        encrypt(makeWebhookSecret(), requireSecret("APP_SECRET"))
      ]
    );

    // A template the tenant made under a library alias is kept. The seed skips that one entry
    // instead of failing, which would roll back the tenant, key, and domain with it.
    for (const entry of library.templates) {
      try {
        await installLibrary(client, tenantId, [entry], library.version ?? "1.0.0");
      } catch (error) {
        if (!(error instanceof ApiError) || error.statusCode !== 409) throw error;
        console.log(`kept ${entry.slug}: the template under this alias did not come from the library`);
      }
    }
  });
  console.log("seeded");
} finally {
  await db.end();
}
