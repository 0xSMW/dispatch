import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Dispatch, type Result } from "../../packages/sdk/src/index.js";
import type { Usage } from "./common.js";

export async function access(u: Usage): Promise<void> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const env = { DISPATCH_API_URL: u.url, DISPATCH_BASE_URL: u.url, DISPATCH_API_KEY: u.key };
  const contactPath = (email: string) => `/contacts/${encodeURIComponent(email)}`;
  const stored = async (id: string, name: string, removed: boolean) => {
    const rows = await u.sql("select first_name, deleted_at from contacts where id=$1 and tenant_id=$2", [id, u.tenant]);
    u.check(rows.length === 1 && rows[0].first_name === name && Boolean(rows[0].deleted_at) === removed, `${name} contact persisted${removed ? " and deleted" : ""}`);
  };
  const cli = async (...args: string[]) => JSON.parse(await u.command("pnpm", ["exec", "tsx", "apps/cli/src/cli.ts", "--api-url", u.url, "--api-key", u.key, "--json", "contacts", ...args], { cwd: root }));
  const segment = await u.api("POST", "/segments", { name: `${u.run} CLI contacts` });
  u.clean(`/segments/${segment.id}`);
  const cliEmail = `usage-${u.run}-cli@example.net`;
  const created = await cli("create", cliEmail, "--first-name", "Usage CLI", "--last-name", u.run, "--segment-id", segment.id);
  u.clean(contactPath(cliEmail));
  u.check((await cli("get", cliEmail)).id === created.id, "CLI retrieves its contact by email");
  const page = await cli("list", "--segment-id", segment.id, "--limit", "100");
  u.check(page.data.some((row: any) => row.id === created.id), "CLI lists its contact");
  await stored(created.id, "Usage CLI", false);
  u.check((await cli("delete", cliEmail, "--yes")).deleted, "CLI deletes its contact");
  await stored(created.id, "Usage CLI", true);

  const client = new Dispatch({ apiKey: u.key, baseUrl: u.url });
  const data = async <T>(pending: Promise<Result<T>>): Promise<T> => {
    const result = await pending;
    u.check(!result.error, "TypeScript SDK request succeeds");
    return result.data!;
  };
  const tsEmail = `usage-${u.run}-typescript@example.net`;
  const ts = await data(client.contacts.create({ email: tsEmail, firstName: "Usage TypeScript", lastName: u.run }));
  u.clean(contactPath(tsEmail));
  u.check((await data(client.contacts.get(tsEmail))).id === ts.id, "TypeScript SDK retrieves its contact");
  u.check((await data(client.contacts.list({ q: tsEmail, limit: 100 }))).data.some(row => row.id === ts.id), "TypeScript SDK lists its contact");
  await stored(ts.id, "Usage TypeScript", false);
  u.check((await data(client.contacts.remove(tsEmail))).deleted, "TypeScript SDK deletes its contact");
  await stored(ts.id, "Usage TypeScript", true);

  for (const language of ["Python", "Go"] as const) {
    const marker = `${u.run}-${language.toLowerCase()}`;
    u.clean(contactPath(`usage-${marker}@example.net`));
    const output = language === "Python"
      ? await u.command("python3", ["scripts/usage/client.py", marker], { cwd: root, env: { ...env, PYTHONPATH: join(root, "packages/sdk-python") } })
      : await u.command("go", ["run", ".", marker], { cwd: join(root, "scripts/usage/go"), env });
    const result = JSON.parse(output);
    u.check(result.id && result.listed && result.deleted, `${language} SDK creates, gets, lists and deletes its contact`);
    await stored(result.id, `Usage ${language}`, true);
  }

  const boundary = await u.api("POST", "/contacts", { email: `usage-${u.run}-boundary@example.net`, first_name: "Boundary", last_name: u.run });
  u.clean(`/contacts/${boundary.id}`);
  const bootstrap = await u.command("pnpm", ["db:bootstrap", "--name", `${u.run} foreign tenant`, "--email", `usage-${u.run}-admin@example.net`, "--password", randomBytes(24).toString("base64url"), "--user-name", "Usage foreign admin"], { cwd: root });
  const foreignKey = bootstrap.match(/^DISPATCH_API_KEY=(.+)$/m)?.[1] ?? "";
  u.check(foreignKey, "Product bootstrap returns a separate fixture key");
  const foreignKeys = await u.api("GET", "/api-keys?limit=100", undefined, 200, foreignKey);
  u.check(foreignKeys.data.length === 1, "Fresh foreign tenant has only its bootstrap key");
  try {
    const foreign = await u.api("GET", "/setup", undefined, 200, foreignKey);
    u.check(foreign.tenant.id !== u.tenant, "Bootstrap tenant is separate");
    await u.api("GET", `/contacts/${boundary.id}`, undefined, 404, foreignKey);
    await u.api("PATCH", `/contacts/${boundary.id}`, { first_name: "Foreign denied" }, 404, foreignKey);
    await stored(boundary.id, "Boundary", false);
  } finally {
    await u.api("DELETE", `/api-keys/${foreignKeys.data[0].id}`, undefined, 200, foreignKey);
  }

  const roles = await u.api("GET", "/roles?limit=100");
  const viewerRole = roles.data.find((row: any) => row.name === "Viewer");
  u.check(viewerRole, "Viewer role is available");
  const email = `usage-${u.run}-viewer@example.net`, password = randomBytes(24).toString("base64url");
  const viewer = await u.api("POST", "/users", { email, password, name: `${u.run} viewer` });
  u.clean(`/users/${viewer.id}`);
  const membership = await u.api("POST", "/memberships", { user_id: viewer.id, role_id: viewerRole.id });
  u.clean(`/memberships/${membership.id}`);
  const session = await u.api("POST", "/sessions", { email, password }, 200, "");
  u.check(session.token, "Viewer signs in with its password");
  await u.api("GET", `/contacts/${boundary.id}`, undefined, 200, session.token);
  await u.api("PATCH", `/contacts/${boundary.id}`, { first_name: "Viewer denied" }, 403, session.token);
  await stored(boundary.id, "Boundary", false);

  const key = await u.api("POST", "/api-keys", { name: `${u.run} disposable key`, scope: "full" });
  u.clean(`/api-keys/${key.id}`);
  await u.api("GET", `/contacts/${boundary.id}`, undefined, 200, key.token);
  await u.api("DELETE", `/api-keys/${key.id}`);
  await u.api("GET", `/contacts/${boundary.id}`, undefined, 403, key.token);
  const revoked = await u.sql("select revoked_at is not null as revoked from api_keys where id=$1 and tenant_id=$2", [key.id, u.tenant]);
  u.check(revoked[0]?.revoked, "Revoked key is persisted and denied");
  await u.api("DELETE", `/memberships/${membership.id}`);
  await u.api("GET", "/me", undefined, 401, session.token);
  await u.api("DELETE", `/users/${viewer.id}`);
  const users = await u.sql("select deactivated_at is not null as inactive from users where id=$1 and tenant_id=$2", [viewer.id, u.tenant]);
  u.check(users[0]?.inactive, "Owned viewer is deactivated");
}
