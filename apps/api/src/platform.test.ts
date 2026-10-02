import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@dispatchmail/db";
import { checkPassword, hashPassword } from "@dispatchmail/core";
import { permitted, present, presentKey, presentMe, presentSession, presentSystem, presentUser, readOnly, registerPlatform, removed } from "./platform.js";
import { signinLimit } from "./rate.js";

// The Redis counter in memory: failures per lowercased email.
function memorySignins() {
  const counts = new Map<string, number>();
  const key = (email: string) => email.trim().toLowerCase();
  return {
    counts,
    take: async (email: string) => {
      counts.set(key(email), (counts.get(key(email)) ?? 0) + 1);
      return counts.get(key(email))! <= signinLimit;
    },
    release: async (email: string) => void (counts.has(key(email)) && counts.set(key(email), counts.get(key(email))! - 1)),
  };
}

describe("platform presenters", () => {
  it("returns flat resources with an object name and Resend-style deletes", () => {
    expect(present("role", { id: "role_1", name: "Owner" })).toEqual({ object: "role", id: "role_1", name: "Owner" });
    expect(removed("membership", "member_1")).toEqual({ object: "membership", id: "member_1", deleted: true });
    expect(presentUser({ id: "user_1", deactivated_at: null })).toMatchObject({ object: "user", active: true });
    expect(presentUser({ id: "user_1", deactivated_at: "2026-10-01" }).active).toBe(false);
  });

  it("includes the session token only on create", () => {
    expect(presentSession({ id: "sess_1" }, "sess_secret")).toEqual({ object: "session", id: "sess_1", token: "sess_secret" });
    expect(presentSession({ id: "sess_1" })).not.toHaveProperty("token");
  });

  it("presents me the same way for keys and sessions", () => {
    expect(presentMe({ tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" })).toEqual({
      object: "me",
      tenant_id: "tenant_1",
      api_key_id: "key_1",
      scope: "full",
      user: null,
      session_id: null,
    });
  });

  it("folds state counts into the system body", () => {
    const system = presentSystem({
      provider: "fake",
      concurrency: 5,
      jobs: [{ state: "ready", count: 2 }],
      attempts: [{ state: "queued", count: 1 }],
      runs: [],
      logs: { count: 4 },
      webhooks: { enabled_webhooks: 1 },
    });
    expect(system).toMatchObject({ object: "system", worker: { backlog: { ready: 2 } }, webhooks: { attempts: { queued: 1 }, enabled_webhooks: 1 } });
  });

  it("presents an API key with its permission, masked token, and total uses", () => {
    expect(
      presentKey({
        id: "key_1",
        name: "Production",
        prefix: "sk_abc123",
        scope: "send",
        domain_id: null,
        created_at: "2026-10-01",
        last_used_at: null,
        total_uses: 12,
      }),
    ).toMatchObject({ object: "api_key", token: "sk_abc123...", permission: "sending_access", total_uses: 12 });
  });
});

describe("platform routes", () => {
  async function build() {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    // True when the one full-access member is the row being removed.
    const last = { value: false };
    const db = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("r.permissions ? 'full'")) return { rows: [{ total: 1, remaining: last.value ? 0 : 1 }] };
        if (sql.startsWith("select * from users")) return { rows: [{ id: params[1], email: "ada@example.com", name: "Ada" }] };
        if (sql.includes("from send_jobs j") && sql.includes("j.id = $2")) return { rows: [{ id: "job_1", state: "ready" }] };
        if (sql.startsWith("update users set deactivated_at")) return { rows: params[1] === "user_1" ? [{ id: "user_1" }] : [] };
        if (sql.startsWith("update memberships set disabled_at")) return { rows: params[1] === "member_1" ? [{ id: "member_1", user_id: "user_1" }] : [] };
        if (sql.includes("from tenants where id = $1")) return { rows: [{ id: "tenant_1", name: "Local" }] };
        if (sql.includes("as user_exists")) return { rows: [{ user_exists: true, role_exists: true }] };
        if (sql.includes("not (permissions ? 'full')")) return { rows: params[1] === "role_viewer" ? [{ "?column?": 1 }] : [] };
        return { rows: [] };
      }),
    } as unknown as Db;
    const app = Fastify();
    app.addHook("preHandler", async (request) => {
      request.auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" };
    });
    registerPlatform(app, {
      db,
      paging: () => ({}),
      flushTelemetry: async () => undefined,
      validKey: async () => null,
      sessionsEnabled: () => true,
      signins: memorySignins(),
    });
    await app.ready();
    return { app, queries, last };
  }

  it("serves the moved routes without /v1 and filters email jobs on $2", async () => {
    const { app, queries } = await build();
    for (const url of ["/setup", "/me", "/users", "/roles", "/memberships", "/sessions", "/audit-logs", "/usage", "/timeline", "/system"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: "/v1/users" })).statusCode).toBe(404);

    await app.inject({ method: "GET", url: "/email-jobs?email_id=email_1" });
    const jobs = queries.at(-1)!;
    expect(jobs.sql).toContain("j.email_id = $2");
    expect(jobs.params.slice(0, 2)).toEqual(["tenant_1", "email_1"]);

    const job = await app.inject({ method: "GET", url: "/email-jobs/job_1" });
    expect(job.json()).toEqual({ object: "email_job", id: "job_1", state: "ready" });
    expect((await app.inject({ method: "DELETE", url: "/users/user_1" })).json()).toEqual({ object: "user", id: "user_1", deleted: true });
    // Deactivating a user ends their sessions in the same request.
    expect(queries.at(-1)!.sql).toContain("update sessions set revoked_at = now()");
    expect(queries.at(-1)!.params).toEqual(["tenant_1", "user_1", ""]);
    expect((await app.inject({ method: "DELETE", url: "/users/user_x" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/sessions/sess_x" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/memberships/member_x" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/roles/role_x" })).statusCode).toBe(404);
  });

  it("refuses to overwrite a live role by creating one with its name", async () => {
    const { app, queries } = await build();
    const response = await app.inject({ method: "POST", url: "/roles", payload: { name: "Admin", permissions: ["read"] } });
    expect(response.statusCode).toBe(409);
    expect(queries.find((query) => query.sql.startsWith("insert into roles"))!.sql).toContain("where roles.deleted_at is not null");
  });

  it("ends a removed member's sessions, so adding them back does not revive old ones", async () => {
    const { app, queries } = await build();
    expect((await app.inject({ method: "DELETE", url: "/memberships/member_1" })).statusCode).toBe(200);
    expect(queries.some((query) => query.sql.startsWith("update sessions set revoked_at"))).toBe(true);
  });

  it("scopes setup to the caller's tenant and refuses to recreate an existing user", async () => {
    const { app, queries } = await build();
    const setup = await app.inject({ method: "GET", url: "/setup" });
    expect(setup.json()).toMatchObject({ object: "setup", ready: true, tenant: { id: "tenant_1" } });
    const setupQueries = queries.filter((query) => /from (tenants|domains|api_keys|users)/.test(query.sql));
    expect(setupQueries).toHaveLength(4);
    expect(setupQueries.every((query) => query.params[0] === "tenant_1")).toBe(true);

    const again = await app.inject({ method: "POST", url: "/users", payload: { email: "ada@example.com", name: "Ada" } });
    expect(again.statusCode).toBe(409);
    expect(queries.at(-1)!.sql).toContain("on conflict (tenant_id, email) do nothing");
  });

  it("refuses to remove, deactivate, or demote the last member with full access", async () => {
    const { app, queries, last } = await build();
    last.value = true;
    for (const [method, url, payload] of [
      ["DELETE", "/memberships/member_1", undefined],
      ["DELETE", "/users/user_1", undefined],
      ["PATCH", "/users/user_1", { active: false }],
      ["DELETE", "/roles/role_1", undefined],
    ] as const) {
      const response = await app.inject({ method, url, payload });
      expect(response.statusCode, `${method} ${url}`).toBe(409);
      expect(response.json().message).toContain("last member with full access");
    }
    expect(queries.some((query) => query.sql.startsWith("update "))).toBe(false);
    // With another full-access member, the same delete goes through to the update.
    last.value = false;
    await app.inject({ method: "DELETE", url: "/users/user_1" });
    expect(queries.some((query) => query.sql.startsWith("update users set deactivated_at"))).toBe(true);
    const check = queries.find((query) => query.sql.includes("r.permissions ? 'full'"))!;
    expect(check.params).toEqual(["tenant_1", "member_1", "", ""]);
  });

  it("never counts a viewer as full access", async () => {
    const { app, queries, last } = await build();
    last.value = true;
    // Moving the last admin to the Viewer role is a demotion like any other.
    const demote = await app.inject({ method: "POST", url: "/memberships", payload: { user_id: "user_1", role_id: "role_viewer" } });
    expect(demote.statusCode).toBe(409);
    expect(queries.some((query) => query.sql.startsWith("insert into memberships"))).toBe(false);
    // Moving them to another full-access role needs no check.
    await app.inject({ method: "POST", url: "/memberships", payload: { user_id: "user_1", role_id: "role_admin" } });
    expect(queries.some((query) => query.sql.startsWith("insert into memberships"))).toBe(true);
  });

  it("pages usage on a column that does not move", async () => {
    const { app, queries } = await build();
    await app.inject({ method: "GET", url: "/usage" });
    expect(queries.at(-1)!.sql).toContain("order by created_at desc");
    expect(queries.at(-1)!.sql).not.toContain("order by updated_at");
  });

  it("orders joined lists by a qualified id", async () => {
    const { app, queries } = await build();
    await app.inject({ method: "GET", url: "/memberships" });
    expect(queries.at(-1)!.sql).toContain("order by m.created_at desc, m.id desc");
  });
});

describe("permitted", () => {
  it("lets full access call anything", () => {
    expect(permitted(["full"], "DELETE", "/domains/:id")).toBe(true);
    expect(permitted(["full", "read"], "POST", "/emails")).toBe(true);
  });

  it("lets read access call GET routes and its own account, and nothing else", () => {
    expect(permitted(["read"], "GET", "/emails/:id")).toBe(true);
    expect(permitted(["read"], "HEAD", "/emails")).toBe(true);
    expect(permitted(["read"], "GET", "/me")).toBe(true);
    expect(permitted(["read"], "POST", "/me/password")).toBe(true);
    expect(permitted(["read"], "DELETE", "/sessions/:id")).toBe(true);
    for (const [method, route] of [
      ["POST", "/emails"],
      ["PATCH", "/emails/:id"],
      ["POST", "/emails/:id/share"],
      ["POST", "/templates/:id/render"],
      ["DELETE", "/domains/:id"],
      ["POST", "/users"],
      ["PATCH", "/users/:id"],
      ["POST", "/contacts/imports"],
      ["POST", "/broadcasts/:id/send"],
    ]) {
      expect(permitted(["read"], method!, route!), `${method} ${route}`).toBe(false);
    }
  });

  it("gives a role with neither full nor read nothing", () => {
    expect(permitted([], "GET", "/emails")).toBe(false);
    expect(permitted(["send"], "POST", "/emails")).toBe(false);
  });

  it("calls a session user without full access read-only, and never an API key", () => {
    expect(readOnly({ user_id: "user_1", permissions: ["read"] })).toBe(true);
    expect(readOnly({ user_id: "user_1", permissions: ["full"] })).toBe(false);
    expect(readOnly({ permissions: [] })).toBe(false);
    expect(readOnly(undefined)).toBe(false);
  });
});

describe("sign-in and passwords", () => {
  type User = { id: string; tenant_id: string; email: string; name: string; role: string; permissions: string[]; password_hash: string | null };

  async function build(options: { users?: User[]; auth?: Record<string, unknown> | null; sessionsEnabled?: boolean } = {}) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const users = options.users ?? [];
    const db = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("lower(u.email) = lower($1)")) {
          return { rows: users.filter((user) => user.email.toLowerCase() === String(params[0]).toLowerCase() && user.password_hash) };
        }
        if (sql.startsWith("select email, password_hash from users")) return { rows: users.filter((user) => user.id === params[1]) };
        if (sql.startsWith("select * from users")) return { rows: users.filter((user) => user.id === params[1]) };
        if (sql.startsWith("insert into sessions")) return { rows: [{ id: params[0], user_id: params[2], expires_at: "2026-11-01", created_at: "2026-10-02" }] };
        if (sql.startsWith("update users") || sql.startsWith("insert into users")) return { rows: [{ id: "user_1", email: "ada@example.com", name: "Ada" }] };
        if (sql.startsWith("update sessions")) return { rows: [{ id: params[1] }] };
        if (sql.includes("from users u") && sql.includes("u.email = $2")) return { rows: users.filter((user) => user.email === params[1]) };
        return { rows: [] };
      }),
    } as unknown as Db;
    const signins = memorySignins();
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const err = error as { statusCode?: number; name?: string; message: string };
      reply.status(err.statusCode ?? (err.name === "ZodError" ? 400 : 500)).send({ name: err.name, message: err.message });
    });
    app.addHook("preHandler", async (request) => {
      if (options.auth !== null) request.auth = (options.auth ?? { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full" }) as never;
    });
    registerPlatform(app, {
      db,
      paging: () => ({}),
      flushTelemetry: async () => undefined,
      validKey: async (secret) => (secret === "sk_full" ? { tenant_id: "tenant_1", scope: "full" } : null),
      sessionsEnabled: () => options.sessionsEnabled ?? false,
      signins,
    });
    await app.ready();
    return { app, queries, signins };
  }

  const ada = async (): Promise<User> => ({
    id: "user_1",
    tenant_id: "tenant_1",
    email: "ada@example.com",
    name: "Ada",
    role: "Viewer",
    permissions: ["read"],
    password_hash: await hashPassword("a long private password"),
  });

  it("signs in with an email and password and returns the session and the user's permissions", async () => {
    const { app, queries } = await build({ users: [await ada()], auth: null });
    const response = await app.inject({ method: "POST", url: "/sessions", payload: { email: "Ada@Example.com", password: "a long private password" } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ object: "session", user_id: "user_1", user: { id: "user_1", email: "ada@example.com", role: "Viewer", permissions: ["read"] } });
    expect(body.token).toMatch(/^sess_/);
    expect(body.user).not.toHaveProperty("password_hash");
    expect(body.user).not.toHaveProperty("tenant_id");
    // The user query leaves out deactivated users, users with no membership, and users with no password.
    const lookup = queries.find((query) => query.sql.includes("lower(u.email) = lower($1)"))!;
    expect(lookup.sql).toContain("u.deactivated_at is null");
    expect(lookup.sql).toContain("m.disabled_at is null");
    expect(lookup.sql).toContain("r.deleted_at is null");
    expect(lookup.sql).toContain("u.password_hash is not null");
    const insert = queries.find((query) => query.sql.startsWith("insert into sessions"))!;
    expect(insert.params[1]).toBe("tenant_1");
  });

  it("gives a wrong password and an unknown email the same error", async () => {
    const { app } = await build({ users: [await ada()], auth: null });
    const wrong = await app.inject({ method: "POST", url: "/sessions", payload: { email: "ada@example.com", password: "not the password" } });
    const unknown = await app.inject({ method: "POST", url: "/sessions", payload: { email: "nobody@example.com", password: "not the password" } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json()).toMatchObject({ name: "invalid_credentials", message: "Invalid email or password" });
  });

  it("refuses an email after 10 failures, even with the right password, and a success takes back only its own slot", async () => {
    const { app, signins } = await build({ users: [await ada()], auth: null });
    const attempt = (password: string) => app.inject({ method: "POST", url: "/sessions", payload: { email: "ada@example.com", password } });
    expect((await attempt("a long private password")).statusCode).toBe(200);
    expect(signins.counts.get("ada@example.com")).toBe(0);
    for (let index = 0; index < 9; index++) expect((await attempt("wrong password")).statusCode).toBe(401);
    // A success in another tenant, or here, does not wipe the failures. Clearing them let one
    // tenant's known password reset the count that guards another tenant's account.
    expect((await attempt("a long private password")).statusCode).toBe(200);
    expect(signins.counts.get("ada@example.com")).toBe(9);
    expect((await attempt("wrong password")).statusCode).toBe(401);
    const blocked = await attempt("a long private password");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().name).toBe("rate_limit_exceeded");
  });

  it("counts attempts that arrive together before any of them is checked", async () => {
    const { app } = await build({ users: [await ada()], auth: null });
    const results = await Promise.all(
      Array.from({ length: 30 }, () => app.inject({ method: "POST", url: "/sessions", payload: { email: "ada@example.com", password: "wrong password" } })),
    );
    expect(results.filter((result) => result.statusCode === 401)).toHaveLength(10);
    expect(results.filter((result) => result.statusCode === 429)).toHaveLength(20);
  });

  it("keeps the API key exchange for local development only", async () => {
    const off = await build({ users: [await ada()], auth: null });
    const refused = await off.app.inject({ method: "POST", url: "/sessions", payload: { email: "ada@example.com", api_key: "sk_full" } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toContain("Passwordless");

    const on = await build({ users: [await ada()], auth: null, sessionsEnabled: true });
    const exchanged = await on.app.inject({ method: "POST", url: "/sessions", payload: { email: "ada@example.com", api_key: "sk_full" } });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json().token).toMatch(/^sess_/);
  });

  it("changes the signed-in user's password and ends their other sessions", async () => {
    const auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full", user_id: "user_1", session_id: "sess_mine", permissions: ["read"] };
    const { app, queries } = await build({ users: [await ada()], auth });
    const wrong = await app.inject({ method: "POST", url: "/me/password", payload: { current_password: "not it", password: "a brand new password" } });
    expect(wrong.statusCode).toBe(422);
    expect(queries.some((query) => query.sql.startsWith("update users"))).toBe(false);

    const short = await app.inject({ method: "POST", url: "/me/password", payload: { current_password: "a long private password", password: "short" } });
    expect(short.statusCode).toBe(400);

    const changed = await app.inject({ method: "POST", url: "/me/password", payload: { current_password: "a long private password", password: "a brand new password" } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ object: "user", id: "user_1" });
    const update = queries.find((query) => query.sql.startsWith("update users set password_hash"))!;
    expect(await checkPassword("a brand new password", String(update.params[2]))).toBe(true);
    const revoke = queries.at(-1)!;
    expect(revoke.sql).toContain("update sessions set revoked_at = now()");
    expect(revoke.sql).toContain("id <> $3");
    expect(revoke.params).toEqual(["tenant_1", "user_1", "sess_mine"]);
  });

  it("refuses a password change from an API key", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "POST", url: "/me/password", payload: { current_password: "x", password: "a brand new password" } });
    expect(response.statusCode).toBe(403);
  });

  it("lets an admin set a password on create and reset one on update", async () => {
    const auth = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full", user_id: "user_admin", session_id: "sess_admin", permissions: ["full"] };
    const { app, queries } = await build({ users: [await ada()], auth });
    await app.inject({ method: "POST", url: "/users", payload: { email: "grace@example.com", name: "Grace", password: "a long private password" } });
    const insert = queries.find((query) => query.sql.startsWith("insert into users"))!;
    expect(insert.params).not.toContain("a long private password");
    expect(await checkPassword("a long private password", String(insert.params[4]))).toBe(true);

    const reset = await app.inject({ method: "PATCH", url: "/users/user_1", payload: { password: "a reset password here" } });
    expect(reset.statusCode).toBe(200);
    const update = queries.find((query) => query.sql.startsWith("update users set email"))!;
    expect(update.sql).toContain("password_hash = coalesce($6, password_hash)");
    expect(await checkPassword("a reset password here", String(update.params[5]))).toBe(true);
    // Ada's sessions end. Only the session that made the change is spared, and that one is the admin's.
    expect(queries.at(-1)!.params).toEqual(["tenant_1", "user_1", "sess_admin"]);

    // A short password is refused before anything is written.
    const before = queries.length;
    expect((await app.inject({ method: "PATCH", url: "/users/user_1", payload: { password: "short" } })).statusCode).toBe(400);
    expect(queries.slice(before).some((query) => query.sql.startsWith("update"))).toBe(false);
  });

  it("lets a viewer end only their own sessions", async () => {
    const viewer = { tenant_id: "tenant_1", api_key_id: "key_1", scope: "full", user_id: "user_1", session_id: "sess_mine", permissions: ["read"] };
    const { app, queries } = await build({ auth: viewer });
    await app.inject({ method: "DELETE", url: "/sessions/sess_mine" });
    expect(queries.at(-1)!.sql).toContain("($3::text is null or user_id = $3)");
    expect(queries.at(-1)!.params).toEqual(["tenant_1", "sess_mine", "user_1"]);

    const admin = await build({ auth: { ...viewer, permissions: ["full"] } });
    await admin.app.inject({ method: "DELETE", url: "/sessions/sess_other" });
    expect(admin.queries.at(-1)!.params).toEqual(["tenant_1", "sess_other", null]);
  });
});
