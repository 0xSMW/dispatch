import "dotenv/config";
import { hash, keyHash } from "@dispatch/core";
import { connect, tx } from "./index.js";

const db = connect();
const pepper = process.env.API_KEY_PEPPER ?? "dev-pepper-change-before-deploy";
const tenantId = "tenant_dev";
const userId = "user_dev";
const roleId = "role_owner";
const membershipId = "member_dev";
const domainId = "domain_dev";
const keyId = "key_dev";
const webhookId = "webhook_dev";
const secret = process.env.DISPATCH_API_KEY ?? "sk_local_dispatch_dev_key_change_before_deploy";
const prefix = secret.slice(0, 12);

try {
  await tx(db, async (client) => {
    await client.query(
      `insert into tenants (id, name) values ($1, $2)
       on conflict (id) do update set name = excluded.name`,
      [tenantId, "Local"]
    );

    await client.query(
      `insert into users (id, tenant_id, email, name)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, email) do update set name = excluded.name, deactivated_at = null, updated_at = now()`,
      [userId, tenantId, "operator@example.test", "Operator"]
    );

    await client.query(
      `insert into roles (id, tenant_id, name, permissions)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, name) do update set permissions = excluded.permissions, deleted_at = null, updated_at = now()`,
      [roleId, tenantId, "owner", JSON.stringify(["full"])]
    );

    await client.query(
      `insert into memberships (id, tenant_id, user_id, role_id)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, user_id) do update set role_id = excluded.role_id, disabled_at = null, updated_at = now()`,
      [membershipId, tenantId, userId, roleId]
    );

    await client.query(
      `insert into domains (id, tenant_id, name, region, status, records, checked_at)
       values ($1, $2, $3, $4, 'verified', $5, now())
       on conflict (tenant_id, name) do update set status = 'verified', checked_at = now()`,
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
        hash("local-webhook-secret").slice(0, 32)
      ]
    );
  });
  console.log("seeded");
} finally {
  await db.end();
}
