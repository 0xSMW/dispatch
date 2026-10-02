import {
  ApiError,
  checkPassword,
  hash,
  hashPassword,
  id,
  makeKey,
  membershipSchema,
  passwordChangeSchema,
  roleSchema,
  roleUpdateSchema,
  sessionSchema,
  userSchema,
  userUpdateSchema,
} from "@dispatchmail/core";
import { paginate, presentPage, softDelete, type Db, type PagingParams } from "@dispatchmail/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Signins } from "./rate.js";

type Row = Record<string, unknown>;

export function present<T extends Row>(object: string, row: T) {
  return { object, ...row };
}

// Refuses a change that would leave the tenant with no active member who has full access, since
// nobody could then sign in to the dashboard to undo it. `without` names what the change takes
// away: a membership, a user, or a role.
export async function assertFullAccessRemains(db: Pick<Db, "query">, tenantId: string, without: { membership?: string; user?: string; role?: string }) {
  const row = await db.query<{ total: number; remaining: number }>(
    `select count(*)::int as total,
            (count(*) filter (where m.id <> $2 and m.user_id <> $3 and m.role_id <> $4))::int as remaining
     from memberships m
     join users u on u.id = m.user_id and u.deactivated_at is null
     join roles r on r.id = m.role_id and r.deleted_at is null
     where m.tenant_id = $1 and m.disabled_at is null and r.permissions ? 'full'`,
    [tenantId, without.membership ?? "", without.user ?? "", without.role ?? ""],
  );
  const counts = row.rows[0];
  if (counts && counts.total > 0 && counts.remaining === 0) {
    throw new ApiError("conflict", 409, "This is the last member with full access. Give another member full access first.");
  }
}

// What a dashboard user's role lets them call. Full access calls anything. Read access calls GET
// routes and looks after its own account: changing its password and signing out.
export function permitted(permissions: string[], method: string, route: string) {
  if (permissions.includes("full")) return true;
  if (!permissions.includes("read")) return false;
  if (method === "GET" || method === "HEAD") return true;
  return (method === "POST" && route === "/me/password") || (method === "DELETE" && route === "/sessions/:id");
}

// A dashboard user who can only read. Secrets are left out of what they are shown.
export function readOnly(auth?: { user_id?: string; permissions?: string[] }) {
  return Boolean(auth?.user_id) && !(auth?.permissions ?? []).includes("full");
}

export function removed(object: string, resourceId: string) {
  return { object, id: resourceId, deleted: true as const };
}

export function presentUser(row: Row & { deactivated_at?: unknown }) {
  return { ...present("user", row), active: !row.deactivated_at };
}

export function presentSession(row: Row, token?: string) {
  return token ? { ...present("session", row), token } : present("session", row);
}

export function presentMe(auth: {
  tenant_id: string;
  api_key_id: string;
  scope: string;
  session_id?: string;
  user_id?: string;
  permissions?: string[];
  user?: Row | null;
}) {
  return {
    object: "me" as const,
    tenant_id: auth.tenant_id,
    api_key_id: auth.api_key_id,
    // A viewer's session is "read", so a client that trusts the scope does not offer writes.
    scope: readOnly(auth) ? "read" : auth.scope,
    user: auth.user ?? null,
    session_id: auth.session_id ?? null,
  };
}

export type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scope: "full" | "send";
  domain_id: string | null;
  created_at: string | Date;
  last_used_at: string | Date | null;
  total_uses: number;
  created_by?: string | null;
  creator?: string | null;
};

export function presentKey(row: KeyRow) {
  return {
    object: "api_key" as const,
    id: row.id,
    name: row.name,
    token: `${row.prefix}...`,
    permission: row.scope === "send" ? ("sending_access" as const) : ("full_access" as const),
    domain_id: row.domain_id ?? null,
    total_uses: Number(row.total_uses ?? 0),
    last_used_at: row.last_used_at ?? null,
    created_at: row.created_at,
    // The user who made the key in the dashboard, and their email. Null for a key made with another key.
    created_by: row.created_by ?? null,
    creator: row.creator ?? null,
  };
}

export function presentSystem(input: {
  provider: string;
  concurrency: number;
  jobs: Array<{ state: string; count: number }>;
  attempts: Array<{ state: string; count: number }>;
  runs: Array<{ state: string; count: number }>;
  logs: Row | undefined;
  webhooks: Row | undefined;
  sending?: { region: string; max_24_hour: number; max_per_second: number; sent_24_hour: number; sandbox: boolean } | null;
  smtp?: { host: string | null; port: number; tls_port: number };
}) {
  const counts = (rows: Array<{ state: string; count: number }>) => Object.fromEntries(rows.map((row) => [row.state, row.count]));
  return {
    object: "system" as const,
    ok: true,
    provider: input.provider,
    worker: { backlog: counts(input.jobs), concurrency: input.concurrency },
    webhooks: { attempts: counts(input.attempts), ...(input.webhooks ?? {}) },
    automations: counts(input.runs),
    logs: input.logs ?? null,
    sending: input.sending ?? null,
    smtp: input.smtp ?? null,
  };
}

export function registerPlatform(
  app: FastifyInstance,
  deps: {
    db: Db;
    paging: (request: FastifyRequest) => PagingParams;
    flushTelemetry: () => Promise<void>;
    validKey: (secret: string) => Promise<{ tenant_id: string; scope: string } | null>;
    sessionsEnabled: () => boolean;
    signins: Signins;
    quota?: (region: string) => Promise<{ max_24_hour: number; max_per_second: number; sent_24_hour: number; sandbox: boolean }>;
  },
) {
  const { db, paging, flushTelemetry, validKey, sessionsEnabled, signins } = deps;

  // A deactivated user must lose access at once, not when their session runs out in 30 days.
  // A password change ends every session but the one that made it.
  async function revokeSessions(tenantId: string, userId: string, keep = "") {
    await db.query("update sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and revoked_at is null and id <> $3", [
      tenantId,
      userId,
      keep,
    ]);
  }

  async function startSession(tenantId: string, user: Row & { id: string }) {
    const token = `sess_${makeKey().secret}`;
    const row = await db.query(
      `insert into sessions (id, tenant_id, user_id, token_hash, expires_at)
       values ($1, $2, $3, $4, now() + interval '30 days')
       returning id, user_id, expires_at, created_at`,
      [id("sess"), tenantId, user.id, hash(token)],
    );
    return { ...presentSession(row.rows[0], token), user };
  }

  const tooMany = () => new ApiError("rate_limit_exceeded", 429, "Too many failed sign-in attempts. Try again in 15 minutes.");

  // Onboarding state. With a key it describes the caller's own tenant. Without one (allowed
  // only when public setup is on) it says whether the install has been seeded, and no more:
  // no names, addresses, or key prefixes go to an anonymous caller.
  app.get("/setup", async (request) => {
    const tenantId = request.auth?.tenant_id;
    if (!tenantId) {
      const seeded = await db.query("select 1 from tenants limit 1");
      return { object: "setup", ready: Boolean(seeded.rows[0]), tenant: null, domain: null, api_key: null, user: null };
    }
    const [tenant, domain, key, user] = await Promise.all([
      db.query("select id, name from tenants where id = $1", [tenantId]),
      db.query("select id, name, status from domains where tenant_id = $1 and deleted_at is null order by created_at asc limit 1", [tenantId]),
      db.query("select id, name, prefix, scope from api_keys where tenant_id = $1 and revoked_at is null order by created_at asc limit 1", [tenantId]),
      db.query("select id, email, name from users where tenant_id = $1 and deactivated_at is null order by created_at asc limit 1", [tenantId]),
    ]);
    return {
      object: "setup",
      ready: Boolean(tenant.rows[0]),
      tenant: tenant.rows[0] ?? null,
      domain: domain.rows[0] ?? null,
      api_key: key.rows[0] ?? null,
      user: user.rows[0] ?? null,
    };
  });

  // Signs in with an email and password. A wrong password and an unknown email get the same
  // error, and both pay for one scrypt derivation.
  app.post("/sessions", async (request) => {
    const input = sessionSchema.parse(request.body);
    if (!input.password) return keySession(input.email, input.api_key!);
    if (!(await signins.take(input.email))) throw tooMany();
    const users = await db.query<{ id: string; tenant_id: string; email: string; name: string; role: string; permissions: string[]; password_hash: string }>(
      `select u.id, u.tenant_id, u.email, u.name, r.name as role, r.permissions, u.password_hash
       from users u
       join memberships m on m.tenant_id = u.tenant_id and m.user_id = u.id and m.disabled_at is null
       join roles r on r.tenant_id = u.tenant_id and r.id = m.role_id and r.deleted_at is null
       where lower(u.email) = lower($1) and u.deactivated_at is null and u.password_hash is not null
       order by u.created_at asc
       limit 10`,
      [input.email],
    );
    let found: (typeof users.rows)[number] | undefined;
    for (const row of users.rows) {
      if (await checkPassword(input.password, row.password_hash)) {
        found = row;
        break;
      }
    }
    if (!users.rows.length) await checkPassword(input.password, null);
    if (!found) throw new ApiError("invalid_credentials", 401, "Invalid email or password");
    await signins.release(input.email);
    const { tenant_id: tenantId, password_hash: _hash, ...user } = found;
    return startSession(tenantId, user);
  });

  // The old exchange of an email and a full-access key, for local development and tests only.
  async function keySession(email: string, secret: string) {
    if (!sessionsEnabled()) {
      throw new ApiError("forbidden", 403, "Passwordless local sessions are disabled");
    }
    const apiKey = await validKey(secret);
    if (!apiKey || apiKey.scope !== "full") throw new ApiError("invalid_api_key", 403, "Invalid API key");
    const user = await db.query(
      `select u.id, u.email, u.name, r.name as role, r.permissions
       from users u
       join memberships m on m.user_id = u.id and m.disabled_at is null
       join roles r on r.id = m.role_id and r.deleted_at is null
       where u.tenant_id = $1 and u.email = $2 and u.deactivated_at is null
       limit 1`,
      [apiKey.tenant_id, email],
    );
    if (!user.rows[0]) throw new ApiError("not_found", 404, "User not found");
    return startSession(apiKey.tenant_id, user.rows[0] as Row & { id: string });
  }

  // A sending key can read who it is. The CLI signs in and checks keys through this route.
  app.get("/me", { config: { scope: "send" } }, async (request) => {
    const auth = request.auth!;
    if (!auth.user_id) return presentMe(auth);
    const row = await db.query(
      `select u.id, u.email, u.name, r.name as role, r.permissions
       from users u
       join memberships m on m.user_id = u.id and m.disabled_at is null
       join roles r on r.id = m.role_id and r.deleted_at is null
       where u.tenant_id = $1 and u.id = $2`,
      [auth.tenant_id, auth.user_id],
    );
    return presentMe({ ...auth, user: row.rows[0] ?? null });
  });

  // The signed-in user changes their own password. Open to every role, a viewer included.
  app.post("/me/password", async (request) => {
    const auth = request.auth!;
    if (!auth.user_id) throw new ApiError("forbidden", 403, "Sign in as a user to change a password");
    const input = passwordChangeSchema.parse(request.body);
    const current = await db.query<{ email: string; password_hash: string | null }>(
      "select email, password_hash from users where tenant_id = $1 and id = $2",
      [auth.tenant_id, auth.user_id],
    );
    const email = current.rows[0]?.email ?? auth.user_id;
    if (!(await signins.take(email))) throw tooMany();
    if (!(await checkPassword(input.current_password, current.rows[0]?.password_hash))) {
      throw new ApiError("validation_error", 422, "The current password is wrong");
    }
    await signins.release(email);
    const row = await db.query(
      `update users set password_hash = $3, updated_at = now()
       where tenant_id = $1 and id = $2
       returning id, email, name, created_at, updated_at, deactivated_at`,
      [auth.tenant_id, auth.user_id, await hashPassword(input.password)],
    );
    await revokeSessions(auth.tenant_id, auth.user_id, auth.session_id);
    return presentUser(row.rows[0]);
  });

  app.get("/users", async (request) => {
    const page = await paginate(
      db,
      {
        table: "users",
        tenantId: request.auth!.tenant_id,
        select: "id, email, name, created_at, updated_at, deactivated_at",
        deletedCol: null,
      },
      paging(request),
    );
    return presentPage(page, presentUser);
  });

  app.post("/users", async (request) => {
    const input = userSchema.parse(request.body);
    const row = await db.query(
      `insert into users (id, tenant_id, email, name, password_hash)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, email) do nothing
       returning id, email, name, created_at, updated_at, deactivated_at`,
      [id("user"), request.auth!.tenant_id, input.email, input.name, input.password ? await hashPassword(input.password) : null],
    );
    // Adding an address that exists must not quietly bring a deactivated user back. Reactivate
    // with PATCH /users/:id { "active": true }.
    if (!row.rows[0]) throw new ApiError("validation_error", 409, "A user with this email already exists");
    return presentUser(row.rows[0]);
  });

  app.patch("/users/:id", async (request) => {
    const userId = (request.params as { id: string }).id;
    const input = userUpdateSchema.parse(request.body);
    const current = await db.query("select * from users where tenant_id = $1 and id = $2", [request.auth!.tenant_id, userId]);
    if (!current.rows[0]) throw new ApiError("not_found", 404, "User not found");
    if (input.active === false) await assertFullAccessRemains(db, request.auth!.tenant_id, { user: userId });
    // A new password is how an admin resets a forgotten one.
    const row = await db.query(
      `update users set email = $3, name = $4,
         deactivated_at = case
           when $5::boolean is null then deactivated_at
           when $5 then null
           else coalesce(deactivated_at, now())
         end,
         password_hash = coalesce($6, password_hash),
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning id, email, name, created_at, updated_at, deactivated_at`,
      [
        request.auth!.tenant_id,
        userId,
        input.email ?? current.rows[0].email,
        input.name ?? current.rows[0].name,
        input.active ?? null,
        input.password ? await hashPassword(input.password) : null,
      ],
    );
    if (input.active === false) await revokeSessions(request.auth!.tenant_id, userId);
    else if (input.password) await revokeSessions(request.auth!.tenant_id, userId, request.auth!.session_id);
    return presentUser(row.rows[0]);
  });

  app.delete("/users/:id", async (request) => {
    const userId = (request.params as { id: string }).id;
    await assertFullAccessRemains(db, request.auth!.tenant_id, { user: userId });
    const row = await db.query(
      "update users set deactivated_at = coalesce(deactivated_at, now()), updated_at = now() where tenant_id = $1 and id = $2 returning id",
      [request.auth!.tenant_id, userId],
    );
    if (!row.rows[0]) throw new ApiError("not_found", 404, "User not found");
    await revokeSessions(request.auth!.tenant_id, userId);
    return removed("user", userId);
  });

  app.get("/roles", async (request) => {
    const page = await paginate(
      db,
      {
        table: "roles",
        tenantId: request.auth!.tenant_id,
        select: "id, name, permissions, created_at, updated_at",
        deletedCol: "deleted_at",
      },
      paging(request),
    );
    return presentPage(page, (row) => present("role", row));
  });

  app.post("/roles", async (request) => {
    const input = roleSchema.parse(request.body);
    const row = await db.query(
      `insert into roles (id, tenant_id, name, permissions)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, name) do update set permissions = excluded.permissions, deleted_at = null, updated_at = now()
       where roles.deleted_at is not null
       returning id, name, permissions, created_at, updated_at`,
      [id("role"), request.auth!.tenant_id, input.name, JSON.stringify(input.permissions)],
    );
    // A live role of that name is changed with PATCH, which guards the last full-access member.
    // Overwriting it here let a create turn Admin read-only.
    if (!row.rows[0]) throw new ApiError("conflict", 409, `A role named ${input.name} already exists`);
    return present("role", row.rows[0]);
  });

  app.patch("/roles/:id", async (request) => {
    const roleId = (request.params as { id: string }).id;
    const input = roleUpdateSchema.parse(request.body);
    const current = await db.query("select * from roles where tenant_id = $1 and id = $2 and deleted_at is null", [
      request.auth!.tenant_id,
      roleId,
    ]);
    if (!current.rows[0]) throw new ApiError("not_found", 404, "Role not found");
    if (input.permissions && !input.permissions.includes("full")) await assertFullAccessRemains(db, request.auth!.tenant_id, { role: roleId });
    const row = await db.query(
      `update roles set name = $3, permissions = $4, updated_at = now()
       where tenant_id = $1 and id = $2
       returning id, name, permissions, created_at, updated_at`,
      [
        request.auth!.tenant_id,
        roleId,
        input.name ?? current.rows[0].name,
        JSON.stringify(input.permissions ?? current.rows[0].permissions),
      ],
    );
    return present("role", row.rows[0]);
  });

  app.delete("/roles/:id", async (request) => {
    const roleId = (request.params as { id: string }).id;
    await assertFullAccessRemains(db, request.auth!.tenant_id, { role: roleId });
    const result = await softDelete(db, "roles", request.auth!.tenant_id, roleId);
    if (!result.rowCount) throw new ApiError("not_found", 404, "Role not found");
    return removed("role", roleId);
  });

  app.get("/memberships", async (request) => {
    const page = await paginate(
      db,
      {
        table:
          "memberships m join users u on u.tenant_id = m.tenant_id and u.id = m.user_id join roles r on r.tenant_id = m.tenant_id and r.id = m.role_id",
        tenantId: request.auth!.tenant_id,
        tenantCol: "m.tenant_id",
        deletedCol: "m.disabled_at",
        cursorCol: "m.created_at",
        idCol: "m.id",
        select: "m.id, m.user_id, u.email, u.name, m.role_id, r.name as role, m.created_at, m.updated_at",
      },
      paging(request),
    );
    return presentPage(page, (row) => present("membership", row));
  });

  app.post("/memberships", async (request) => {
    const input = membershipSchema.parse(request.body);
    const refs = await db.query(
      `select
         exists(select 1 from users where tenant_id = $1 and id = $2 and deactivated_at is null) as user_exists,
         exists(select 1 from roles where tenant_id = $1 and id = $3 and deleted_at is null) as role_exists`,
      [request.auth!.tenant_id, input.user_id, input.role_id],
    );
    if (!refs.rows[0]?.user_exists || !refs.rows[0]?.role_exists) {
      throw new ApiError("not_found", 404, "User or role not found");
    }
    // Moving the last full-access member to a lesser role would lock the dashboard too.
    const lesser = await db.query("select 1 from roles where tenant_id = $1 and id = $2 and not (permissions ? 'full')", [request.auth!.tenant_id, input.role_id]);
    if (lesser.rows[0]) await assertFullAccessRemains(db, request.auth!.tenant_id, { user: input.user_id });
    const row = await db.query(
      `insert into memberships (id, tenant_id, user_id, role_id)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, user_id) do update set role_id = excluded.role_id, disabled_at = null, updated_at = now()
       returning id, user_id, role_id, created_at, updated_at`,
      [id("member"), request.auth!.tenant_id, input.user_id, input.role_id],
    );
    return present("membership", row.rows[0]);
  });

  app.delete("/memberships/:id", async (request) => {
    const membershipId = (request.params as { id: string }).id;
    await assertFullAccessRemains(db, request.auth!.tenant_id, { membership: membershipId });
    const row = await db.query(
      "update memberships set disabled_at = coalesce(disabled_at, now()), updated_at = now() where tenant_id = $1 and id = $2 returning id, user_id",
      [request.auth!.tenant_id, membershipId],
    );
    if (!row.rows[0]) throw new ApiError("not_found", 404, "Membership not found");
    // Otherwise adding the membership back would bring back every session the user had.
    await revokeSessions(request.auth!.tenant_id, String(row.rows[0].user_id));
    return removed("membership", membershipId);
  });

  app.get("/sessions", async (request) => {
    const page = await paginate(
      db,
      {
        table: "sessions s join users u on u.id = s.user_id",
        tenantId: request.auth!.tenant_id,
        tenantCol: "s.tenant_id",
        deletedCol: null,
        cursorCol: "s.created_at",
        idCol: "s.id",
        select: "s.id, s.user_id, u.email, s.expires_at, s.last_used_at, s.created_at, s.revoked_at",
      },
      paging(request),
    );
    return presentPage(page, (row) => presentSession(row));
  });

  app.delete("/sessions/:id", async (request) => {
    const sessionId = (request.params as { id: string }).id;
    // A user who can only read may end their own sessions and no one else's.
    const own = readOnly(request.auth) ? request.auth!.user_id : null;
    const row = await db.query(
      "update sessions set revoked_at = coalesce(revoked_at, now()) where tenant_id = $1 and id = $2 and ($3::text is null or user_id = $3) returning id",
      [request.auth!.tenant_id, sessionId, own],
    );
    if (!row.rows[0]) throw new ApiError("not_found", 404, "Session not found");
    return removed("session", sessionId);
  });

  app.get("/audit-logs", async (request) => {
    await flushTelemetry();
    const query = request.query as { action?: string };
    const page = await paginate(
      db,
      {
        table: "audit_logs a left join users u on u.tenant_id = a.tenant_id and u.id = a.actor_user_id",
        tenantId: request.auth!.tenant_id,
        tenantCol: "a.tenant_id",
        deletedCol: null,
        cursorCol: "a.created_at",
        idCol: "a.id",
        where: query.action ? "a.action like $2" : undefined,
        whereParams: query.action ? [`%${query.action.replace(/[\\%_]/g, "\\$&")}%`] : undefined,
        select:
          "a.id, a.request_id, a.actor_user_id, u.email as actor_email, a.api_key_id, a.session_id, a.action, a.target_type, a.target_id, a.data, a.created_at",
      },
      paging(request),
    );
    return presentPage(page, (row) => present("audit_log", row));
  });

  app.get("/email-jobs", async (request) => {
    const query = request.query as { email_id?: string };
    const page = await paginate(
      db,
      "send_jobs j join emails e on e.tenant_id = j.tenant_id and e.id = j.email_id",
      request.auth!.tenant_id,
      paging(request),
      {
        tenantCol: "j.tenant_id",
        createdCol: "j.created_at",
        idCol: "j.id",
        where: query.email_id ? "j.email_id = $2" : undefined,
        params: query.email_id ? [query.email_id] : [],
        select:
          "j.id, j.email_id, e.subject, j.state, j.attempts, j.available_at, j.locked_at, j.error, j.created_at, j.updated_at",
      },
    );
    return presentPage(page, (row) => present("email_job", row));
  });

  app.get("/email-jobs/:id", async (request) => {
    const jobId = (request.params as { id: string }).id;
    const row = await db.query(
      `select j.id, j.email_id, e.subject, j.request_id, j.state, j.attempts, j.available_at, j.locked_at, j.error, j.created_at, j.updated_at
       from send_jobs j
       join emails e on e.tenant_id = j.tenant_id and e.id = j.email_id
       where j.tenant_id = $1 and j.id = $2`,
      [request.auth!.tenant_id, jobId],
    );
    if (!row.rows[0]) throw new ApiError("not_found", 404, "Email job not found");
    return present("email_job", row.rows[0]);
  });

  app.get("/system", async (request) => {
    await flushTelemetry();
    const tenantId = request.auth!.tenant_id;
    const [jobs, attempts, runs, logs, webhooks] = await Promise.all([
      db.query("select state, count(*)::integer as count from send_jobs where tenant_id = $1 group by state order by state", [tenantId]),
      db.query("select state, count(*)::integer as count from webhook_attempts where tenant_id = $1 group by state order by state", [tenantId]),
      db.query("select state, count(*)::integer as count from automation_runs where tenant_id = $1 group by state order by state", [tenantId]),
      db.query("select count(*)::integer as count, coalesce(max(created_at), now()) as last_seen_at from logs where tenant_id = $1", [tenantId]),
      db.query(
        `select count(*) filter (where enabled)::integer as enabled_webhooks,
           count(*) filter (where not enabled)::integer as disabled_webhooks
         from webhooks where tenant_id = $1`,
        [tenantId],
      ),
    ]);
    // The provider's limits for the account. A failed lookup leaves the field empty and the
    // rest of the page still loads.
    const region = process.env.AWS_REGION ?? "us-east-1";
    const quota = deps.quota ? await deps.quota(region).catch(() => null) : null;
    return presentSystem({
      sending: quota ? { region, ...quota } : null,
      smtp: {
        host: process.env.SMTP_HOST || null,
        // Each setting may list several ports. The first is the one to show people.
        port: Number.parseInt(process.env.SMTP_PORT || "587", 10) || 587,
        tls_port: Number.parseInt(process.env.SMTP_TLS_PORT || "465", 10) || 465,
      },
      provider: process.env.SES_PROVIDER ?? "fake",
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
      jobs: jobs.rows,
      attempts: attempts.rows,
      runs: runs.rows,
      logs: logs.rows[0],
      webhooks: webhooks.rows[0],
    });
  });

  app.get("/usage", async (request) => {
    await flushTelemetry();
    // Paged on created_at, which never moves. updated_at changes as counters increment, and a
    // row that moved between two page requests was repeated or skipped.
    const page = await paginate(db, "usage_counters", request.auth!.tenant_id, paging(request), {
      createdCol: "created_at",
      select: "id, name, period, value::bigint::text as value, updated_at",
    });
    return presentPage(page, (row) => present("usage_counter", row));
  });

  app.get("/timeline", async (request) => {
    await flushTelemetry();
    const source = `(
      select 'email' as kind, id, tenant_id, request_id, status as name, subject as summary, created_at from emails
      union all
      select 'email_event' as kind, id, tenant_id, request_id, type as name, coalesce(email_id, '') as summary, created_at from email_events
      union all
      select 'custom_event' as kind, id, tenant_id, request_id, name, coalesce(email, '') as summary, created_at from custom_events where deleted_at is null
      union all
      select 'received_email' as kind, id, tenant_id, request_id, 'email.received' as name, subject as summary, created_at from received_emails
      union all
      select 'webhook_attempt' as kind, id, tenant_id, request_id, state as name, webhook_id as summary, created_at from webhook_attempts
      union all
      select 'automation_run' as kind, id, tenant_id, null as request_id, state as name, automation_id as summary, created_at from automation_runs
      union all
      select 'api_log' as kind, id, tenant_id, request_id, method || ' ' || status::text as name, path as summary, created_at from logs
    ) items`;
    const page = await paginate(db, source, request.auth!.tenant_id, paging(request), {
      select: "kind, id, request_id, name, summary, created_at",
    });
    return presentPage(page, (row) => present("timeline_item", row));
  });
}
