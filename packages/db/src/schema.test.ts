import { describe, expect, it } from "vitest";
import { schema } from "./schema.js";

describe("schema", () => {
  it("adds password hashes and gives every tenant an Admin and a Viewer role, idempotently", () => {
    expect(schema).toContain("alter table users add column if not exists password_hash text;");
    // The full-access role tenants were made with becomes Admin, unless the tenant has one.
    expect(schema).toMatch(/update roles r set name = 'Admin'[\s\S]*where r\.name = 'owner'[\s\S]*not exists/);
    // A Viewer role for each tenant that never had one. One an admin renamed or deleted is not
    // made again, and no clash can raise. This checks the statement's shape. Only applying the
    // schema twice to a real Postgres proves the second run is clean.
    const viewer = schema.match(/insert into roles[^;]*'Viewer'[^;]*;/)?.[0] ?? "";
    expect(viewer).toMatch(/'Viewer', '\["read"\]'::jsonb\s+from tenants t\s+where not exists \(/);
    expect(viewer).toContain(`r.id = 'role_' || md5(t.id || ':viewer') or r.name = 'Viewer' or r.permissions = '["read"]'::jsonb`);
    expect(viewer).toMatch(/\)\s+on conflict do nothing;$/);
  });
});
