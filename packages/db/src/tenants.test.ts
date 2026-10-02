import { describe, expect, it, vi } from "vitest";
import { checkPassword, keyHash } from "@dispatchmail/core";
import type { Db } from "./index.js";
import { createTenant } from "./tenants.js";

function fake() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return { rows: [], rowCount: 1 };
  });
  const db = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Db;
  return { db, queries };
}

describe("createTenant", () => {
  it("creates a tenant, an admin, the Admin and Viewer roles, and one full-access key, and nothing else", async () => {
    const { db, queries } = fake();
    const created = await createTenant(db, { name: " Acme ", email: "Ada@Acme.com", password: "a long private password", pepper: "pepper-pepper-pepper" });
    const tables = queries.filter((query) => query.sql.startsWith("insert into")).map((query) => query.sql.split(" ")[2]);
    expect(tables).toEqual(["tenants", "users", "roles", "roles", "memberships", "api_keys"]);
    expect(queries.some((query) => /insert into (domains|webhooks)/.test(query.sql))).toBe(false);

    expect(created.email).toBe("ada@acme.com");
    expect(created.api_key.startsWith("sk_")).toBe(true);
    const key = queries.find((query) => query.sql.startsWith("insert into api_keys"))!;
    // Only the hash is stored, and the key records who it belongs to.
    expect(key.params).not.toContain(created.api_key);
    expect(key.params[3]).toBe(keyHash(created.api_key, "pepper-pepper-pepper"));
    expect(key.params[4]).toBe(created.user_id);
    const roles = queries.filter((query) => query.sql.startsWith("insert into roles"));
    expect(roles.map((query) => [query.sql.match(/'(\w+)'/)![1], query.params[2]])).toEqual([
      ["Admin", '["full"]'],
      ["Viewer", '["read"]'],
    ]);
    // The first user is an Admin.
    const membership = queries.find((query) => query.sql.startsWith("insert into memberships"))!;
    expect(membership.params[3]).toBe(roles[0]!.params[0]);

    // The password is stored only as a scrypt hash.
    const user = queries.find((query) => query.sql.startsWith("insert into users"))!;
    expect(user.params).not.toContain("a long private password");
    expect(await checkPassword("a long private password", String(user.params[4]))).toBe(true);
  });

  it("wants a password of 12 to 200 characters", async () => {
    const { db, queries } = fake();
    await expect(createTenant(db, { name: "Acme", email: "a@b.co", password: "short", pepper: "p" })).rejects.toThrow(/password/);
    expect(queries).toEqual([]);
  });

  it("wants a name and an email address", async () => {
    const { db } = fake();
    await expect(createTenant(db, { name: " ", email: "a@b.co", password: "a long private password", pepper: "p" })).rejects.toThrow(/name/);
    await expect(createTenant(db, { name: "Acme", email: "nope", password: "a long private password", pepper: "p" })).rejects.toThrow(/email/);
  });
});
