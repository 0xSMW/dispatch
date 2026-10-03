import "@dispatchmail/core/env";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  id,
  keyHash,
  makeKey,
  renderTemplate,
  sign,
  verify,
} from "@dispatchmail/core";
import { connect, executeAutomationRun, tx, unsubscribeToken, type Db } from "@dispatchmail/db";
import { schema } from "../../../packages/db/src/schema.js";
import type { FastifyInstance } from "fastify";

// Live tests against a real Postgres and Redis, named in the environment or the local .env:
// TEST_DATABASE_URL (a database these tests may empty), TEST_REDIS_URL, and optionally
// TEST_ADMIN_DATABASE_URL, a database on the same server used to create the test one when it is
// missing. Without the first two, every test here is skipped.
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
const redisUrl = process.env.TEST_REDIS_URL ?? "";
const live = Boolean(databaseUrl && redisUrl);
if (process.env.REQUIRE_INTEGRATION_TESTS === "true" && !live) {
  throw new Error(
    "TEST_DATABASE_URL and TEST_REDIS_URL are required for integration tests",
  );
}
const databaseName = live ? new URL(databaseUrl).pathname.slice(1) : "";
const adminUrl =
  process.env.TEST_ADMIN_DATABASE_URL ??
  (live
    ? Object.assign(new URL(databaseUrl), { pathname: "/postgres" }).toString()
    : "");

let db: Db;
let app: FastifyInstance;
let tick: () => Promise<{ jobs: number; runs: number; attempts: number }>;
let closeApi: () => Promise<void>;
let closeWorker: () => Promise<void>;
let fullKey = "";
let turn = Promise.resolve();
let releaseTurn = () => {};

function takeTurn() {
  let release = () => {};
  const previous = turn;
  turn = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return previous.then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  });
}

beforeAll(async () => {
  if (!live) return;
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.RATE_LIMIT_PER_SECOND = "1000";
  // The per-address limit on sign-in would refuse a burst before the per-email lockout sees it.
  process.env.AUTH_RATE_LIMIT_PER_SECOND = "1000";
  process.env.TELEMETRY_FLUSH_MS = "600000";
  process.env.FAKE_PROVIDER_TERMINAL_DELAY_MS = "0";
  process.env.FAKE_PROVIDER_DELAYED_DELAY_MS = "0";
  await ensureDatabase();
  db = connect(databaseUrl);
  await db.query(schema);
  const api = await import("./server.js");
  const worker = await import("../../worker/src/worker.js");
  app = api.app;
  closeApi = api.close;
  tick = worker.tick;
  closeWorker = worker.close;
});

beforeEach(async () => {
  const release = await takeTurn();
  releaseTurn = release;
  try {
    await truncate();
    fullKey = await seedTenant();
  } catch (error) {
    release();
    throw error;
  }
});

afterEach(() => {
  releaseTurn();
});

afterAll(async () => {
  if (closeApi) await closeApi();
  if (closeWorker) await closeWorker();
  if (db) await db.end();
});

describe.skipIf(!live)("accept", () => {
  it("merges concurrent settings patches atomically without changing another tenant", async () => {
    const otherKey = await seedTenant();
    const results = await Promise.all([
      call(fullKey, "PATCH", "/settings", { import_trigger_automations: true }),
      call(fullKey, "PATCH", "/settings", { sandbox_domains: ["atomic.test"] }),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect((await call(fullKey, "GET", "/settings")).json).toMatchObject({
      import_trigger_automations: true,
      sandbox_domains: ["atomic.test"],
    });
    expect((await call(otherKey, "GET", "/settings")).json).toMatchObject({
      import_trigger_automations: false,
      sandbox_domains: [],
    });
  });

  it("keeps tenant settings across repeated migrations and refuses viewer writes", async () => {
    const original = await call(fullKey, "GET", "/settings");
    expect(original.json).toMatchObject({
      import_trigger_automations: false,
      sandbox_domains: [],
    });
    const changed = await call(fullKey, "PATCH", "/settings", {
      import_trigger_automations: true,
    });
    expect(changed.status).toBe(200);
    await call(fullKey, "PATCH", "/settings", { sandbox_domains: ["qa.test"] });
    await db.query(schema);
    await db.query(schema);
    expect((await call(fullKey, "GET", "/settings")).json).toMatchObject({
      import_trigger_automations: true,
      sandbox_domains: ["qa.test"],
    });
    const viewer = await teammate("Viewer");
    const session = await signInAs(viewer.email, viewer.password);
    expect((await call(session.token, "GET", "/settings")).status).toBe(200);
    expect(
      (
        await call(session.token, "PATCH", "/settings", {
          import_trigger_automations: false,
        })
      ).status,
    ).toBe(403);
  });

  it("signs in with a password, and lets a viewer read but not write or see secrets", async () => {
    await teammate("Admin");
    const viewer = await teammate("Viewer");
    const webhook = await call(fullKey, "POST", "/webhooks", {
      endpoint: "http://127.0.0.1:9/hooks/secret-path",
      events: ["email.sent"],
    });
    expect(webhook.status).toBe(200);
    const session = await signInAs(viewer.email, viewer.password);
    expect(session.status).toBe(200);

    // The real preHandler, not a test stand-in, decides.
    expect((await call(session.token, "GET", "/emails")).status).toBe(200);
    expect(
      (await call(session.token, "POST", "/emails", letter())).status,
    ).toBe(403);
    expect(
      (
        await call(session.token, "PATCH", `/webhooks/${webhook.json.id}`, {
          enabled: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(session.token, "POST", "/roles", {
          name: "Sneaky",
          permissions: ["full"],
        })
      ).status,
    ).toBe(403);
    const shown = await call(
      session.token,
      "GET",
      `/webhooks/${webhook.json.id}`,
    );
    expect(shown.status).toBe(200);
    expect(shown.json.signing_secret).toBeUndefined();
    expect(shown.json.endpoint).toBe("http://127.0.0.1:9/…");
    expect((await call(session.token, "GET", "/me")).json.scope).toBe("read");
    expect(
      (
        await call(session.token, "POST", "/me/password", {
          current_password: "not the password",
          password: "another long password",
        })
      ).status,
    ).toBe(422);

    // Ending its own session is the one delete a viewer may make.
    const me = await call(session.token, "GET", "/me");
    expect(
      (await call(session.token, "DELETE", `/sessions/${me.json.session_id}`))
        .status,
    ).toBe(200);
    expect((await call(session.token, "GET", "/emails")).status).toBe(401);
  });

  it("refuses an email after 10 failed sign-ins, counting attempts that arrive together", async () => {
    const admin = await teammate("Admin");
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        signInAs(admin.email, "wrong password here"),
      ),
    );
    expect(results.filter((result) => result.status === 401)).toHaveLength(10);
    expect(results.filter((result) => result.status === 429)).toHaveLength(5);
    expect((await signInAs(admin.email, admin.password)).status).toBe(429);
  });

  it("applies the schema again after an admin renamed the Viewer role", async () => {
    await db.query(schema);
    const tenant = (
      await db.query<{ id: string }>("select id from tenants limit 1")
    ).rows[0]!.id;
    const viewer = (
      await db.query<{ id: string }>(
        "select id from roles where tenant_id = $1 and name = 'Viewer'",
        [tenant],
      )
    ).rows[0]!;
    expect(
      (await call(fullKey, "PATCH", `/roles/${viewer.id}`, { name: "Support" }))
        .status,
    ).toBe(200);
    await db.query(schema);
    const roles = await db.query<{ name: string }>(
      "select name from roles where tenant_id = $1 and permissions = '[\"read\"]'::jsonb",
      [tenant],
    );
    expect(roles.rows.map((row) => row.name)).toEqual(["Support"]);
  });

  it("makes one contact when two events for a new address arrive together", async () => {
    const sends = await Promise.all(
      ["Ada", "Grace"].map((name) =>
        post(fullKey, "/events/send", {
          event: "user.created",
          email: "new@example.com",
          payload: { first_name: name },
        }),
      ),
    );
    expect(sends.map((send) => send.status)).toEqual([202, 202]);
    const contacts = await db.query<{ first_name: string }>(
      "select first_name from contacts where lower(email) = 'new@example.com'",
    );
    expect(contacts.rows).toHaveLength(1);
    expect(["Ada", "Grace"]).toContain(contacts.rows[0]!.first_name);
  });

  it("lets a send key send, then returns 403 after that key is revoked", async () => {
    const created = await post(fullKey, "/api-keys", {
      name: "send",
      scope: "send",
    });
    expect(created.status).toBe(200);
    const secret = created.json.token as string;
    const keyId = created.json.id as string;

    const sent = await post(secret, "/emails", letter());
    expect(sent.status).toBe(200);
    expect(sent.json.id).toEqual(expect.any(String));

    const removed = await app.inject({
      method: "DELETE",
      url: `/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${fullKey}` },
    });
    expect(removed.statusCode).toBe(200);

    const again = await post(
      secret,
      "/emails",
      letter({ to: "again@example.com" }),
    );
    expect(again.status).toBe(403);
  });

  it("replays the same idempotency key and rejects a different body", async () => {
    const body = letter();
    const headers = { "idempotency-key": "idem-accept-1" };
    const first = await post(fullKey, "/emails", body, headers);
    const second = await post(fullKey, "/emails", body, headers);
    expect(first.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);

    const conflict = await post(
      fullKey,
      "/emails",
      letter({ subject: "Different" }),
      headers,
    );
    expect(conflict.status).toBe(409);

    const stored = await db.query("select id from emails");
    expect(stored.rows).toEqual([{ id: first.json.id }]);
  });

  it("stores inline attachment metadata after its parent transactional email", async () => {
    const sent = await post(
      fullKey,
      "/emails",
      letter({
        attachments: [
          {
            filename: "a.txt",
            content: "YQ==",
            disposition: "inline",
            content_id: "logo",
          },
        ],
      }),
    );
    expect(sent.status).toBe(200);
    expect(sent.json.id).toEqual(expect.any(String));
    expect(sent.json).not.toHaveProperty("emails");
    const stored = await db.query(
      `select a.filename, a.content_id, a.disposition, a.size_bytes
       from email_attachments a join emails e on e.id = a.email_id where e.id = $1`,
      [sent.json.id],
    );
    expect(stored.rows).toEqual([
      {
        filename: "a.txt",
        content_id: "logo",
        disposition: "inline",
        size_bytes: 1,
      },
    ]);
  });

  it("replays a batch and rejects a batch that includes an attachment", async () => {
    const body = {
      emails: [
        letter({ to: "one@example.com", subject: "One" }),
        letter({ to: "two@example.com", subject: "Two" }),
      ],
    };
    const headers = { "idempotency-key": "idem-batch-1" };
    const first = await post(fullKey, "/emails/batch", body, headers);
    const second = await post(fullKey, "/emails/batch", body, headers);
    expect(first.status).toBe(200);
    const ids = first.json.data.map((email: { id: string }) => email.id);
    expect(second.json.data.map((email: { id: string }) => email.id)).toEqual(
      ids,
    );

    const stored = await db.query(
      "select id from emails order by created_at, id",
    );
    expect(stored.rows.map((row) => row.id).sort()).toEqual([...ids].sort());

    const rejected = await post(fullKey, "/emails/batch", {
      emails: [
        letter({ attachments: [{ filename: "a.txt", content: "YQ==" }] }),
      ],
    });
    expect(rejected.status).toBe(400);
  });

  it("returns 403 for an unverified sender", async () => {
    const response = await post(
      fullKey,
      "/emails",
      letter({ from: "hello@not-verified.test" }),
    );
    expect(response.status).toBe(403);
    const stored = await db.query("select id from emails");
    expect(stored.rows).toEqual([]);
  });

  it("returns 422 when to plus cc is more than 50", async () => {
    const response = await post(
      fullKey,
      "/emails",
      letter({
        to: Array.from({ length: 50 }, (_, index) => `to-${index}@example.com`),
        cc: "cc-0@example.com",
      }),
    );
    expect(response.status).toBe(422);
    const stored = await db.query("select id from emails");
    expect(stored.rows).toEqual([]);
  });

  it("sends to an unsubscribed contact and accepts a suppressed address", async () => {
    const unsubscribed = await post(fullKey, "/contacts", {
      email: "gone@example.com",
      unsubscribed: true,
    });
    expect(unsubscribed.status).toBe(200);
    const contactSend = await post(
      fullKey,
      "/emails",
      letter({ to: "gone@example.com" }),
    );
    expect(contactSend.status).toBe(200);
    const contactRow = await db.query<{ status: string }>(
      "select status from emails where id = $1",
      [contactSend.json.id],
    );
    expect(contactRow.rows[0]?.status).toBe("queued");

    const suppression = await post(fullKey, "/suppressions", {
      email: "manual@example.com",
      reason: "manual",
    });
    expect(suppression.status).toBe(200);
    const suppressedSend = await post(
      fullKey,
      "/emails",
      letter({ to: "manual@example.com" }),
    );
    expect(suppressedSend.status).toBe(200);
    const suppressedRow = await db.query<{ status: string }>(
      "select status from emails where id = $1",
      [suppressedSend.json.id],
    );
    expect(suppressedRow.rows[0]?.status).toBe("suppressed");
    const events = await db.query<{ type: string }>(
      "select type from email_events where email_id = $1",
      [suppressedSend.json.id],
    );
    expect(events.rows.map((row) => row.type)).toContain("email.suppressed");
  });

  it("stores the rendered template on the email", async () => {
    const template = {
      name: "Welcome",
      alias: "welcome",
      subject: "Hello {{name}}",
      text: "Hi {{name}}",
      variables: ["name"],
    };
    const created = await post(fullKey, "/templates", {
      ...template,
      publish: true,
    });
    expect(created.status).toBe(200);

    const sent = await post(fullKey, "/emails", {
      from: "hello@example.com",
      to: "ada@example.com",
      template: "welcome",
      variables: { name: "Ada" },
    });
    expect(sent.status).toBe(200);

    const rendered = renderTemplate(template, { name: "Ada" });
    const stored = await db.query<{ subject: string; text: string }>(
      "select subject, text from emails where id = $1",
      [sent.json.id],
    );
    expect(stored.rows[0]).toEqual({
      subject: rendered.subject,
      text: rendered.text,
    });
  });

  it("leaves a future send scheduled after one worker tick", async () => {
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const sent = await post(
      fullKey,
      "/emails",
      letter({ scheduled_at: scheduledAt }),
    );
    expect(sent.status).toBe(200);
    const storedBefore = await db.query<{ status: string }>(
      "select status from emails where id = $1",
      [sent.json.id],
    );
    expect(storedBefore.rows[0]?.status).toBe("scheduled");

    await tick();

    const stored = await db.query<{ status: string }>(
      "select status from emails where id = $1",
      [sent.json.id],
    );
    expect(stored.rows[0]?.status).toBe("scheduled");
  });
});

describe.skipIf(!live)("contact timeline", () => {
  it("pages thirty runs without skipped or repeated rows, including equal timestamps and case-insensitive email events", async () => {
    const contact = await post(fullKey, "/contacts", {
      email: "ada@example.com",
    });
    const flow = await post(fullKey, "/automations", {
      name: "History",
      enabled: false,
      steps: [
        { key: "start", type: "trigger", config: { event_name: "history" } },
      ],
      connections: [],
    });
    expect([contact.status, flow.status]).toEqual([200, 200]);
    const tenant = (
      await db.query<{ tenant_id: string }>(
        "select tenant_id from contacts where id = $1",
        [contact.json.id],
      )
    ).rows[0]!.tenant_id;
    await tx(db, async (client) => {
      for (let i = 0; i < 30; i++) {
        const eventId = id("ce");
        await client.query(
          "insert into custom_events (id, tenant_id, request_id, name, email, created_at) values ($1, $2, 'req_history', 'history', 'ADA@EXAMPLE.COM', '2026-10-01')",
          [eventId, tenant],
        );
        await client.query(
          `insert into automation_runs (id, tenant_id, automation_id, event_id, state, created_at, updated_at)
           values ($1, $2, $3, $4, $5, '2026-10-01', '2026-10-02')`,
          [
            id("run"),
            tenant,
            flow.json.id,
            eventId,
            ["done", "failed", "stopped"][i % 3],
          ],
        );
      }
      await client.query(
        "insert into custom_events (id, tenant_id, request_id, name, email) values ($1, $2, 'req_internal', '@contact.updated', 'ada@example.com')",
        [id("ce"), tenant],
      );
    });
    const sent = await post(
      fullKey,
      "/emails",
      letter({ to: ["ADA@example.com", "ada@example.com"] }),
    );
    expect(sent.status).toBe(200);
    await db.query(
      "insert into email_events (id, tenant_id, email_id, type, provider_event_id) values ($1, $2, $3, 'email.delivered', $4)",
      [id("event"), tenant, sent.json.id, id("provider")],
    );
    const rows: Array<{
      id: string;
      type: string;
      label: string;
      created_at: string;
      automation_id: string | null;
      run_id: string | null;
    }> = [];
    let after = "";
    for (let pages = 0; pages < 20; pages++) {
      const page = await call(
        fullKey,
        "GET",
        `/contacts/${contact.json.id}/activity?limit=7${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      expect(page.status).toBe(200);
      rows.push(...page.json.data);
      if (!page.json.has_more) break;
      after = page.json.data.at(-1).id;
    }
    expect(rows).toHaveLength(92);
    expect(new Set(rows.map((row) => row.id)).size).toBe(92);
    expect(rows.filter((row) => row.type === "event.fired")).toHaveLength(30);
    expect(
      rows.filter((row) => row.type === "automation.run.started"),
    ).toHaveLength(30);
    const ended = rows.filter((row) => row.type === "automation.run.completed");
    expect(ended).toHaveLength(30);
    expect(new Set(ended.map((row) => row.label))).toEqual(
      new Set(["done", "failed", "stopped"]),
    );
    expect(
      ended.every(
        (row) =>
          row.automation_id === flow.json.id &&
          row.id === `${row.run_id}:completed`,
      ),
    ).toBe(true);
    expect(rows.filter((row) => row.type === "email.delivered")).toHaveLength(
      1,
    );
    expect(rows.some((row) => row.label === "@contact.updated")).toBe(false);
    for (let i = 1; i < rows.length; i++)
      expect(
        new Date(rows[i - 1]!.created_at).getTime(),
      ).toBeGreaterThanOrEqual(new Date(rows[i]!.created_at).getTime());
  });
});

async function audience() {
  const topic = await post(fullKey, "/topics", {
    name: "News",
    default_subscription: "opt_in",
  });
  const first = await post(fullKey, "/contacts", {
    email: "ada@example.com",
    first_name: "Ada",
  });
  const second = await post(fullKey, "/contacts", {
    email: "bob@example.com",
    first_name: "Bob",
  });
  expect([topic.status, first.status, second.status]).toEqual([
    200, 200, 200,
  ]);
  return {
    topic: topic.json.id as string,
    first: first.json.id as string,
    second: second.json.id as string,
  };
}

async function stored(emailId: string) {
  const result = await db.query<{
    headers: Record<string, string>;
    html: string;
    html_tracked: string;
    text: string;
    status: string;
  }>(
    "select headers, html, html_tracked, text, status from emails where id = $1",
    [emailId],
  );
  return result.rows[0]!;
}

function link(headers: Record<string, string>) {
  return new URL(headers["List-Unsubscribe"]!.slice(1, -1)).pathname;
}

describe.skipIf(!live)("marketing", () => {
  it.each(["topic", "global", "deleted_topic"])(
    "isolates a split recipient's %s unsubscribe and replays the whole request",
    async (mode) => {
      const contacts = await audience();
      const body = letter({
        to: ["ada@example.com", "bob@example.com"],
        cc: ["ADA@example.com"],
        topic_id: contacts.topic,
        html: '<a href="{{UNSUBSCRIBE_URL}}">Leave</a><a href="https://example.net/read">Read</a><p>{{name}}</p>',
        text: "{{{DISPATCH_UNSUBSCRIBE_URL}}}",
        headers: {
          "list-unsubscribe": "caller",
          "LIST-UNSUBSCRIBE-POST": "caller",
        },
      });
      const sent = await post(fullKey, "/emails", body, {
        "idempotency-key": "marketing-split",
      });
      expect(sent.status).toBe(200);
      expect(sent.json.emails).toHaveLength(2);
      expect(sent.json.id).toBe(sent.json.emails[0].id);
      const replay = await post(fullKey, "/emails", body, {
        "idempotency-key": "marketing-split",
      });
      expect(replay.json.emails).toEqual(sent.json.emails);
      expect((await db.query("select id from emails")).rows).toHaveLength(2);
      const first = await stored(sent.json.emails[0].id);
      const second = await stored(sent.json.emails[1].id);
      expect(link(first.headers)).not.toBe(link(second.headers));
      expect(first.headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click",
      );
      expect(first.headers).not.toHaveProperty("list-unsubscribe");
      expect(first.html).toContain("/unsubscribe?token=");
      expect(first.html).toContain("{{name}}");
      expect(first.html_tracked).toContain("/click/");
      expect(first.text).toContain("/unsubscribe?token=");
      const recipients = await db.query(
        "select email_id, email, kind from email_recipients order by email",
      );
      expect(recipients.rows).toEqual([
        {
          email_id: sent.json.emails[0].id,
          email: "ada@example.com",
          kind: "to",
        },
        {
          email_id: sent.json.emails[1].id,
          email: "bob@example.com",
          kind: "to",
        },
      ]);
      const page = await app.inject({
        method: "GET",
        url: link(first.headers),
      });
      expect(page.statusCode).toBe(200);
      expect(
        page
          .json()
          .topics.some((row: { id: string }) => row.id === contacts.topic),
      ).toBe(true);
      if (mode === "deleted_topic")
        expect(
          (await call(fullKey, "DELETE", `/topics/${contacts.topic}`)).status,
        ).toBe(200);
      const action =
        mode === "global"
          ? { unsubscribe_all: true }
          : { "List-Unsubscribe": "One-Click" };
      const left = await Promise.all([
        post("", link(first.headers), action),
        post("", link(first.headers), action),
      ]);
      expect(left.map((row) => row.status)).toEqual([200, 200]);
      const states = await db.query<{
        email: string;
        unsubscribed_at: Date | null;
        status: string;
      }>(
        `select c.email, c.unsubscribed_at, coalesce(s.status, 'subscribed') as status
       from contacts c left join topic_subscriptions s on s.contact_id = c.id and s.topic_id = $1
       order by c.email`,
        [contacts.topic],
      );
      expect(states.rows[1]).toEqual({
        email: "bob@example.com",
        unsubscribed_at: null,
        status: "subscribed",
      });
      if (mode === "topic")
        expect(states.rows[0]).toEqual({
          email: "ada@example.com",
          unsubscribed_at: null,
          status: "unsubscribed",
        });
      else expect(states.rows[0]?.unsubscribed_at).not.toBeNull();
      const events = await db.query(
        "select email_id from email_events where type = 'email.unsubscribed'",
      );
      expect(events.rows).toEqual([{ email_id: sent.json.emails[0].id }]);
    },
  );

  it("protects scheduled updates and cancels after a late topic opt-out without sending", async () => {
    const contacts = await audience();
    const sent = await post(
      fullKey,
      "/emails",
      letter({
        to: "ada@example.com",
        topic_id: contacts.topic,
        text: "{{UNSUBSCRIBE_URL}}",
        scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    expect(sent.status).toBe(200);
    expect(sent.json).not.toHaveProperty("emails");
    const updated = await call(fullKey, "PATCH", `/emails/${sent.json.id}`, {
      text: "{{{RESEND_UNSUBSCRIBE_URL}}}",
      headers: { "LIST-UNSUBSCRIBE": "caller" },
    });
    expect(updated.status).toBe(200);
    const email = await stored(sent.json.id);
    expect(email.text).toContain("/unsubscribe?token=");
    expect(email.headers).not.toHaveProperty("LIST-UNSUBSCRIBE");
    expect(
      (await post("", link(email.headers), { "List-Unsubscribe": "One-Click" }))
        .status,
    ).toBe(200);
    await db.query(
      "update emails set scheduled_at = now() - interval '1 second' where id = $1",
      [sent.json.id],
    );
    await db.query(
      "update send_jobs set available_at = now() - interval '1 second' where email_id = $1",
      [sent.json.id],
    );
    await tick();
    expect((await stored(sent.json.id)).status).toBe("cancelled");
    const job = await db.query(
      "select state, error from send_jobs where email_id = $1",
      [sent.json.id],
    );
    expect(job.rows[0]).toEqual({ state: "done", error: "opted_out" });
    const events = await db.query<{
      type: string;
      data: { failed?: { reason: string } };
    }>("select type, data from email_events where email_id = $1", [
      sent.json.id,
    ]);
    expect(events.rows.some((row) => row.type === "email.sent")).toBe(false);
    expect(
      events.rows.find((row) => row.type === "email.failed")?.data.failed
        ?.reason,
    ).toBe("opted_out");
  });

  it("creates an opted-out contact only when an unknown address uses its link, without reviving deleted rows", async () => {
    const contacts = await audience();
    const sent = await post(
      fullKey,
      "/emails",
      letter({ to: "new@example.com", topic_id: contacts.topic }),
    );
    expect(sent.status).toBe(200);
    expect(
      (
        await db.query(
          "select id from contacts where email = 'new@example.com'",
        )
      ).rows,
    ).toHaveLength(0);
    await post("", link((await stored(sent.json.id)).headers), {
      "List-Unsubscribe": "One-Click",
    });
    const opted = await db.query(
      "select c.deleted_at, s.status from contacts c join topic_subscriptions s on s.contact_id = c.id where c.email = 'new@example.com'",
    );
    expect(opted.rows).toEqual([{ deleted_at: null, status: "unsubscribed" }]);
    const deleted = await post(
      fullKey,
      "/emails",
      letter({ to: "gone@example.com", topic_id: contacts.topic }),
    );
    const gone = await post(fullKey, "/contacts", {
      email: "gone@example.com",
    });
    await call(fullKey, "DELETE", `/contacts/${gone.json.id}`);
    expect(
      (
        await post("", link((await stored(deleted.json.id)).headers), {
          unsubscribe_all: true,
        })
      ).status,
    ).toBe(200);
    const row = await db.query(
      "select deleted_at, unsubscribed_at from contacts where id = $1",
      [gone.json.id],
    );
    expect(row.rows[0].deleted_at).not.toBeNull();
    expect(row.rows[0].unsubscribed_at).not.toBeNull();
  });

  it("isolates each split batch item and preserves opt-in-topic behavior for new addresses", async () => {
    const contacts = await audience();
    const batch = await post(
      fullKey,
      "/emails/batch",
      [
        letter({
          topic_id: contacts.topic,
          to: ["ada@example.com", "bob@example.com"],
        }),
        letter({ to: ["one@example.com", "two@example.com"] }),
      ],
      { "idempotency-key": "marketing-batch" },
    );
    expect(batch.status).toBe(200);
    expect(batch.json.data).toHaveLength(2);
    expect(batch.json.data[0].emails).toHaveLength(2);
    expect(batch.json.data[1]).not.toHaveProperty("emails");
    expect((await db.query("select id from emails")).rows).toHaveLength(3);
    const topic = await post(fullKey, "/topics", {
      name: "Opt-in only",
      default_subscription: "opt_out",
    });
    const sent = await post(
      fullKey,
      "/emails",
      letter({ topic_id: topic.json.id, to: "unknown@example.com" }),
    );
    expect(sent.status).toBe(200);
    expect((await stored(sent.json.id)).status).toBe("queued");
    expect(
      (
        await db.query(
          "select id from contacts where email = 'unknown@example.com'",
        )
      ).rows,
    ).toHaveLength(0);
  });

  it("aggregates automation steps from stored attribution and backfills legacy messages only once", async () => {
    const template = await post(fullKey, "/templates", {
      name: "Metrics",
      alias: "metrics",
      subject: "Metrics",
      html: "<p>Hello</p>",
      publish: true,
    });
    expect(template.status).toBe(200);
    const flow = await post(fullKey, "/automations", {
      name: "Metrics",
      enabled: true,
      steps: [
        { key: "start", type: "trigger", config: { event_name: "measure" } },
        {
          key: "one",
          type: "send_email",
          config: { from: "hello@example.com", template: "metrics" },
        },
        {
          key: "two",
          type: "send_email",
          config: { from: "hello@example.com", template: "metrics" },
        },
      ],
      connections: [
        { from: "start", to: "one", type: "default" },
        { from: "one", to: "two", type: "default" },
      ],
    });
    expect(flow.status).toBe(200);
    expect(
      (
        await post(fullKey, "/events/send", {
          event: "measure",
          email: "ada@example.com",
        })
      ).status,
    ).toBe(202);
    await tick();
    await tick();
    const messages = await db.query<{
      id: string;
      automation_step: string;
      html_tracked: string;
    }>(
      "select id, automation_step, html_tracked from emails where automation_id = $1 order by automation_step",
      [flow.json.id],
    );
    expect(messages.rows.map((row) => row.automation_step)).toEqual([
      "one",
      "two",
    ]);
    const pixel = new URL(
      messages.rows[0]!.html_tracked.match(/src="([^"]+\/open\/[^"]+)"/)![1]!,
    );
    expect(
      (await app.inject({ method: "GET", url: pixel.pathname })).statusCode,
    ).toBe(200);
    expect(
      (
        await db.query(
          "select email_id from email_events where type = 'email.opened'",
        )
      ).rows,
    ).toEqual([{ email_id: messages.rows[0]!.id }]);
    const query = new URLSearchParams({
      dimensions: "step",
      automation_id: flow.json.id,
      metrics: "sent,delivered,opened,open_rate",
      end_date: new Date(Date.now() + 1000).toISOString(),
    });
    const metrics = await call(fullKey, "GET", `/emails/metrics?${query}`);
    expect(metrics.status).toBe(200);
    const rows = metrics.json.data.sort(
      (a: { automation_step: string }, b: { automation_step: string }) =>
        a.automation_step.localeCompare(b.automation_step),
    );
    expect(rows).toEqual([
      {
        automation_id: flow.json.id,
        automation_step: "one",
        sent: 1,
        delivered: 1,
        opened: 1,
        open_rate: 100,
      },
      {
        automation_id: flow.json.id,
        automation_step: "two",
        sent: 1,
        delivered: 1,
        opened: 0,
        open_rate: 0,
      },
    ]);
    expect(
      (await call(fullKey, "GET", "/emails/metrics?dimensions=step")).status,
    ).toBe(422);
    const tagged = await post(
      fullKey,
      "/emails",
      letter({ tags: { automation_id: flow.json.id } }),
    );
    expect(tagged.status).toBe(200);
    await db.query(
      "update emails set created_at = '2026-10-01', automation_id = null, automation_step = null where id = $1",
      [messages.rows[0]!.id],
    );
    await db.query(
      "update emails set created_at = '2026-10-01' where id = $1",
      [tagged.json.id],
    );
    await db.query(schema);
    expect(
      (
        await db.query(
          "select automation_id, automation_step from emails where id = $1",
          [messages.rows[0]!.id],
        )
      ).rows[0],
    ).toEqual({
      automation_id: flow.json.id,
      automation_step: null,
    });
    expect(
      (
        await db.query("select automation_id from emails where id = $1", [
          tagged.json.id,
        ])
      ).rows[0].automation_id,
    ).toBeNull();
    const before = await db.query<{ version: string }>(
      "select xmin::text as version from emails where id = $1",
      [messages.rows[0]!.id],
    );
    await db.query(schema);
    const after = await db.query<{ version: string }>(
      "select xmin::text as version from emails where id = $1",
      [messages.rows[0]!.id],
    );
    expect(after.rows[0]?.version).toBe(before.rows[0]?.version);
  });

  it("renders automation recipient context and skips a later marketing step after one-click", async () => {
    const contacts = await audience();
    const template = await post(fullKey, "/templates", {
      name: "Lifecycle",
      alias: "lifecycle",
      subject: "Hi {{{FIRST_NAME}}}",
      text: "Hello {{{FIRST_NAME}}}. {{{UNSUBSCRIBE_URL}}}",
      publish: true,
    });
    expect(template.status).toBe(200);
    const receipt = await post(fullKey, "/templates", {
      name: "Receipt",
      alias: "receipt",
      subject: "Receipt",
      text: "Receipt for {{{FIRST_NAME}}}",
      publish: true,
    });
    expect(receipt.status).toBe(200);
    const automation = await post(fullKey, "/automations", {
      name: "Lifecycle",
      enabled: true,
      steps: [
        { key: "start", type: "trigger", config: { event_name: "joined" } },
        {
          key: "first",
          type: "send_email",
          config: {
            from: "hello@example.com",
            template: "lifecycle",
            topic_id: contacts.topic,
          },
        },
        { key: "wait", type: "delay", config: { duration: "1 hour" } },
        {
          key: "second",
          type: "send_email",
          config: {
            from: "hello@example.com",
            template: "lifecycle",
            topic_id: contacts.topic,
          },
        },
        {
          key: "receipt",
          type: "send_email",
          config: { from: "hello@example.com", template: "receipt" },
        },
      ],
      connections: [
        { from: "start", to: "first", type: "default" },
        { from: "first", to: "wait", type: "default" },
        { from: "wait", to: "second", type: "default" },
        { from: "second", to: "receipt", type: "default" },
      ],
    });
    expect(automation.status).toBe(200);
    expect(
      (
        await post(fullKey, "/events/send", {
          event: "joined",
          email: "ada@example.com",
          payload: {
            FIRST_NAME: "Mallory",
            UNSUBSCRIBE_URL: "https://evil.example",
          },
        })
      ).status,
    ).toBe(202);
    await tick();
    await tick();
    const emails = await db.query<{ id: string }>(
      "select id from emails order by created_at",
    );
    expect(emails.rows).toHaveLength(1);
    const email = await stored(emails.rows[0]!.id);
    expect(email.text).toContain("Hello Ada");
    expect(email.text).not.toContain("evil.example");
    expect(
      (await post("", link(email.headers), { "List-Unsubscribe": "One-Click" }))
        .status,
    ).toBe(200);
    await db.query(
      "update automation_runs set resume_at = now() - interval '1 second' where state = 'waiting'",
    );
    await tick();
    const steps = await db.query(
      "select state, data from automation_steps where step_key = 'second'",
    );
    expect(steps.rows[0]).toMatchObject({ data: { skipped: "opted_out" } });
    expect((await stored(steps.rows[0].data.email_id)).status).toBe("failed");
    expect(
      (
        await db.query("select id from send_jobs where email_id = $1", [
          steps.rows[0].data.email_id,
        ])
      ).rows,
    ).toHaveLength(0);
    const transactional = await db.query(
      "select text, headers from emails where text = 'Receipt for Ada'",
    );
    expect(transactional.rows).toEqual([
      { text: "Receipt for Ada", headers: {} },
    ]);
  });
});

describe.skipIf(!live)("delivery", () => {
  it("delivers one signed unsubscribe webhook and one event for each automation transition", async () => {
    const received: Array<{
      url: string;
      body: string;
      id: string;
      timestamp: string;
      signature: string;
    }> = [];
    const server = createServer((request, response) =>
      recordWebhook(request, response, received),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("webhook server did not bind");
    try {
      const endpoint = await post(fullKey, "/webhooks", {
        url: `http://127.0.0.1:${address.port}/ok`,
        events: [
          "email.unsubscribed",
          "automation.run.started",
          "automation.run.completed",
          "automation.run.failed",
        ],
      });
      expect(endpoint.status).toBe(200);
      const topic = await post(fullKey, "/topics", {
        name: "News",
        default_subscription: "opt_in",
      });
      const sent = await post(
        fullKey,
        "/emails",
        letter({ topic_id: topic.json.id }),
      );
      expect(sent.status).toBe(200);
      const email = (
        await db.query<{ headers: Record<string, string> }>(
          "select headers from emails where id = $1",
          [sent.json.id],
        )
      ).rows[0]!;
      const unsubscribe = new URL(
        email.headers["List-Unsubscribe"]!.slice(1, -1),
      ).pathname;
      expect(
        (await post("", unsubscribe, { "List-Unsubscribe": "One-Click" }))
          .status,
      ).toBe(200);
      expect(
        (await post("", unsubscribe, { "List-Unsubscribe": "One-Click" }))
          .status,
      ).toBe(200);
      const flow = await post(fullKey, "/automations", {
        name: "Complete",
        enabled: true,
        steps: [
          { key: "start", type: "trigger", config: { event_name: "complete" } },
        ],
        connections: [],
      });
      const failed = await post(fullKey, "/automations", {
        name: "Fail",
        enabled: true,
        steps: [
          { key: "start", type: "trigger", config: { event_name: "fail" } },
          {
            key: "send",
            type: "send_email",
            config: { from: "hello@example.com", template: "missing-template" },
          },
        ],
        connections: [{ from: "start", to: "send", type: "default" }],
      });
      const cancelled = await post(fullKey, "/automations", {
        name: "Cancel",
        enabled: true,
        steps: [
          { key: "start", type: "trigger", config: { event_name: "cancel" } },
          { key: "wait", type: "delay", config: { duration: "1 hour" } },
        ],
        connections: [{ from: "start", to: "wait", type: "default" }],
      });
      expect([flow.status, failed.status, cancelled.status]).toEqual([
        200, 200, 200,
      ]);
      await post(fullKey, "/events/send", {
        event: "complete",
        email: "ada@example.com",
      });
      await post(fullKey, "/events/send", {
        event: "fail",
        email: "ada@example.com",
      });
      await post(fullKey, "/events/send", {
        event: "cancel",
        email: "ada@example.com",
      });
      await tick();
      expect(
        (await post(fullKey, `/automations/${cancelled.json.id}/stop`, {}))
          .status,
      ).toBe(200);
      await tick();
      await tick();
      const bodies = received.map((row) => JSON.parse(row.body));
      expect(
        bodies.filter((body) => body.type === "email.unsubscribed"),
      ).toHaveLength(1);
      expect(
        bodies.filter((body) => body.type === "automation.run.started"),
      ).toHaveLength(3);
      expect(
        bodies.filter((body) => body.type === "automation.run.completed"),
      ).toHaveLength(2);
      expect(
        bodies.filter((body) => body.type === "automation.run.failed"),
      ).toHaveLength(1);
      for (const row of received)
        expect(
          verify(
            row.body,
            endpoint.json.signing_secret,
            row.id,
            row.timestamp,
            row.signature,
          ),
        ).toBe(true);
      const ended = bodies.find(
        (body) =>
          body.type === "automation.run.completed" &&
          body.data.automation_id === flow.json.id,
      );
      expect(ended.data).toMatchObject({
        automation_id: flow.json.id,
        contact_id: expect.any(String),
        state: "done",
      });
      expect(ended.data.run_id).toMatch(/^run_/);
      expect(
        bodies.find(
          (body) =>
            body.type === "automation.run.completed" &&
            body.data.automation_id === cancelled.json.id,
        )?.data.state,
      ).toBe("stopped");
      const before = received.length;
      await tick();
      expect(received).toHaveLength(before);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["one_click", "preferences", "global", "deleted_topic", "broadcast", "legacy_broadcast"])(
    "delivers only to subscribed endpoints once for the %s unsubscribe path",
    async (mode) => {
      const contacts = await audience();
      const received: Parameters<typeof recordWebhook>[2] = [];
      const server = createServer((request, response) => recordWebhook(request, response, received));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("webhook server did not bind");
      try {
        const endpoint = await post(fullKey, "/webhooks", {
          url: `http://127.0.0.1:${address.port}/ok`, events: ["email.unsubscribed"],
        });
        const unrelated = await post(fullKey, "/webhooks", {
          url: `http://127.0.0.1:${address.port}/unrelated`, events: ["automation.run.started"],
        });
        const disabled = await post(fullKey, "/webhooks", {
          url: `http://127.0.0.1:${address.port}/disabled`, events: ["email.unsubscribed"], enabled: false,
        });
        const otherKey = await seedTenant();
        const other = await post(otherKey, "/webhooks", {
          url: `http://127.0.0.1:${address.port}/other`, events: ["email.unsubscribed"],
        });
        expect([endpoint.status, unrelated.status, disabled.status, other.status]).toEqual([200, 200, 200, 200]);
        const sent = await post(fullKey, "/emails", letter({ to: "ada@example.com", topic_id: contacts.topic }));
        expect(sent.status).toBe(200);
        let path = link((await stored(sent.json.id)).headers);
        const tenant = (await db.query<{ tenant_id: string }>("select tenant_id from contacts where id = $1", [contacts.first])).rows[0]!.tenant_id;
        if (mode.includes("broadcast")) {
          const broadcastId = id("broadcast");
          await db.query(
            "insert into broadcasts (id, tenant_id, name, from_email, topic_id) values ($1, $2, 'History', 'hello@example.com', $3)",
            [broadcastId, tenant, contacts.topic],
          );
          await db.query(
            "insert into broadcast_recipients (id, tenant_id, broadcast_id, contact_id, email_id, email) values ($1, $2, $3, $4, $5, 'ada@example.com')",
            [id("br"), tenant, broadcastId, contacts.first, sent.json.id],
          );
          const token = unsubscribeToken({
            tenant_id: tenant, contact_id: contacts.first, broadcast_id: broadcastId,
            ...(mode === "broadcast" ? { email_id: sent.json.id } : {}),
          }, process.env.APP_SECRET ?? "dev-secret-change-before-deploy");
          path = `/unsubscribe/${encodeURIComponent(token)}`;
        }
        if (mode === "deleted_topic") {
          expect((await call(fullKey, "DELETE", `/topics/${contacts.topic}`)).status).toBe(200);
        }
        if (mode === "preferences") {
          // A last opt-in must neither count as an unsubscribe nor queue a delivery.
          expect((await post("", path, { topics: [
            { id: contacts.topic, subscription: "opt_out" },
            { id: contacts.topic, subscription: "opt_in" },
          ] })).status).toBe(200);
          expect((await db.query("select id from email_events where type = 'email.unsubscribed'")).rows).toHaveLength(0);
          expect((await db.query("select id from webhook_attempts")).rows).toHaveLength(0);
          expect((await db.query("select status from topic_subscriptions where contact_id = $1", [contacts.first])).rows).toEqual([{ status: "subscribed" }]);
        }
        const action = mode === "global" ? { unsubscribe_all: true } : mode === "preferences" ? { topics: [
          { id: contacts.topic, subscription: "opt_in" },
          { id: contacts.topic, subscription: "opt_out" },
        ] } : { "List-Unsubscribe": "One-Click" };
        expect((await Promise.all([post("", path, action), post("", path, action)])).map((row) => row.status)).toEqual([200, 200]);
        const attempts = await db.query(
          `select a.webhook_id, e.email_id from webhook_attempts a join email_events e on e.id = a.event_id
           where e.type = 'email.unsubscribed'`,
        );
        expect(attempts.rows).toEqual([{ webhook_id: endpoint.json.id, email_id: sent.json.id }]);
        if (mode.includes("broadcast")) {
          expect((await db.query("select unsubscribed_at from broadcast_recipients where email_id = $1", [sent.json.id])).rows[0]!.unsubscribed_at).not.toBeNull();
        }
        await tick();
        await tick();
        expect(received).toHaveLength(1);
        expect(received[0]!.url).toBe("/ok");
        const delivery = received[0]!;
        expect(JSON.parse(delivery.body)).toMatchObject({ type: "email.unsubscribed", data: { email_id: sent.json.id } });
        expect(verify(delivery.body, endpoint.json.signing_secret, delivery.id, delivery.timestamp, delivery.signature)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.each(["delay", "event", "timeout", "recovery"])(
    "does not repeat lifecycle transitions after %s resumption and retries",
    async (mode) => {
      const endpoint = await post(fullKey, "/webhooks", {
        url: "http://127.0.0.1:1/unused",
        events: ["automation.run.started", "automation.run.completed", "automation.run.failed"],
      });
      const flow = await post(fullKey, "/automations", {
        name: "Resume", enabled: true,
        steps: [
          { key: "start", type: "trigger", config: { event_name: "resume" } },
          mode === "delay"
            ? { key: "wait", type: "delay", config: { duration: "1 hour" } }
            : { key: "wait", type: "wait_for_event", config: { event_name: "wake", timeout: "1 hour" } },
        ],
        connections: [{ from: "start", to: "wait", type: "default" }],
      });
      expect([endpoint.status, flow.status]).toEqual([200, 200]);
      await post(fullKey, "/events/send", { event: "resume", email: "ada@example.com" });
      // Execute directly so webhook attempts stay queued, without network retries.
      const run = (await db.query<{ id: string; tenant_id: string }>("select id, tenant_id from automation_runs")).rows[0]!;
      await executeAutomationRun(db, run.tenant_id, run.id);
      expect((await db.query("select state from automation_runs where id = $1", [run.id])).rows).toEqual([{ state: "waiting" }]);
      expect((await db.query("select id from email_events where type = 'automation.run.started'")).rows).toHaveLength(1);
      expect((await db.query("select id from email_events where type = 'automation.run.completed'")).rows).toHaveLength(0);
      if (mode === "event") {
        await post(fullKey, "/events/send", { event: "wake", email: "ADA@example.com" });
      } else {
        await db.query(
          `update automation_runs set state = $2, resume_data = $3::jsonb, updated_at = now() - interval '6 minutes'
           where id = $1`,
          [run.id, mode === "recovery" ? "running" : "ready", JSON.stringify({ timed_out: mode !== "delay" })],
        );
      }
      await executeAutomationRun(db, run.tenant_id, run.id);
      await executeAutomationRun(db, run.tenant_id, run.id);
      const events = await db.query<{ type: string; data: Record<string, unknown> }>(
        "select type, data from email_events where type like 'automation.run.%' order by type",
      );
      expect(events.rows.map((row) => row.type)).toEqual(["automation.run.completed", "automation.run.started"]);
      for (const event of events.rows) expect(event.data).toMatchObject({
        automation_id: flow.json.id, run_id: run.id, contact_id: expect.any(String),
        state: event.type === "automation.run.started" ? "ready" : "done",
      });
      expect((await db.query("select webhook_id from webhook_attempts")).rows).toEqual([
        { webhook_id: endpoint.json.id }, { webhook_id: endpoint.json.id },
      ]);
      expect((await db.query("select state from automation_steps where run_id = $1", [run.id])).rows).toEqual([{ state: "done" }]);
    },
  );

  it("rolls back enrollment and stop together with failed event insertion or fanout", async () => {
    const endpoint = await post(fullKey, "/webhooks", {
      url: "http://127.0.0.1:1/unused", events: ["automation.run.started", "automation.run.completed"],
    });
    const flow = await post(fullKey, "/automations", {
      name: "Atomic", enabled: true,
      steps: [{ key: "start", type: "trigger", config: { event_name: "atomic" } }],
      connections: [],
    });
    expect([endpoint.status, flow.status]).toEqual([200, 200]);
    try {
      await db.query(`
        create function lifecycle_reject_start() returns trigger language plpgsql as $$
          begin if new.type = 'automation.run.started' then raise exception 'synthetic start failure'; end if; return new; end $$;
        create trigger lifecycle_reject_start before insert on email_events for each row execute function lifecycle_reject_start();
      `);
      expect((await post(fullKey, "/events/send", { event: "atomic", email: "ada@example.com" })).status).toBe(500);
      expect((await db.query("select id from contacts")).rows).toHaveLength(0);
      expect((await db.query("select id from custom_events")).rows).toHaveLength(0);
      expect((await db.query("select id from automation_runs")).rows).toHaveLength(0);
      expect((await db.query("select id from webhook_attempts")).rows).toHaveLength(0);
      await db.query("drop trigger lifecycle_reject_start on email_events; drop function lifecycle_reject_start()");
      expect((await post(fullKey, "/events/send", { event: "atomic", email: "ada@example.com" })).status).toBe(202);
      await db.query(`
        create function lifecycle_reject_terminal() returns trigger language plpgsql as $$
          begin if exists (select 1 from email_events where id = new.event_id and type = 'automation.run.completed')
            then raise exception 'synthetic terminal fanout failure'; end if; return new; end $$;
        create trigger lifecycle_reject_terminal before insert on webhook_attempts for each row execute function lifecycle_reject_terminal();
      `);
      expect((await post(fullKey, `/automations/${flow.json.id}/stop`, {})).status).toBe(500);
      expect((await db.query("select enabled from automations where id = $1", [flow.json.id])).rows).toEqual([{ enabled: true }]);
      expect((await db.query("select state from automation_runs")).rows).toEqual([{ state: "ready" }]);
      expect((await db.query("select id from email_events where type = 'automation.run.completed'")).rows).toHaveLength(0);
      await db.query("drop trigger lifecycle_reject_terminal on webhook_attempts; drop function lifecycle_reject_terminal()");
      expect((await post(fullKey, `/automations/${flow.json.id}/stop`, {})).status).toBe(200);
      expect((await post(fullKey, `/automations/${flow.json.id}/stop`, {})).status).toBe(200);
      expect((await db.query("select state from automation_runs")).rows).toEqual([{ state: "stopped" }]);
      expect((await db.query("select id from email_events where type = 'automation.run.completed'")).rows).toHaveLength(1);
      expect((await db.query("select id from webhook_attempts")).rows).toHaveLength(2);
    } finally {
      await db.query(`
        drop trigger if exists lifecycle_reject_start on email_events;
        drop function if exists lifecycle_reject_start();
        drop trigger if exists lifecycle_reject_terminal on webhook_attempts;
        drop function if exists lifecycle_reject_terminal();
      `);
    }
  });

  it("serializes a stop against completion without two terminal events", async () => {
    const flow = await post(fullKey, "/automations", {
      name: "Race", enabled: true,
      steps: [{ key: "start", type: "trigger", config: { event_name: "race" } }],
      connections: [],
    });
    expect(flow.status).toBe(200);
    await post(fullKey, "/events/send", { event: "race", email: "ada@example.com" });
    const run = (await db.query<{ id: string; tenant_id: string }>("select id, tenant_id from automation_runs")).rows[0]!;
    const [, stop] = await Promise.all([
      executeAutomationRun(db, run.tenant_id, run.id),
      post(fullKey, `/automations/${flow.json.id}/stop`, {}),
    ]);
    expect(stop.status).toBe(200);
    const state = (await db.query<{ state: string }>("select state from automation_runs where id = $1", [run.id])).rows[0]!.state;
    expect(["done", "stopped"]).toContain(state);
    expect((await db.query("select data from email_events where type = 'automation.run.completed'")).rows).toEqual([{
      data: { automation_id: flow.json.id, run_id: run.id, contact_id: expect.any(String), state },
    }]);
    await executeAutomationRun(db, run.tenant_id, run.id);
    expect((await db.query("select id from email_events where type like 'automation.run.%'")).rows).toHaveLength(2);
  });

  it("writes a bounce event and a suppression row from one worker tick", async () => {
    const sent = await post(
      fullKey,
      "/emails",
      letter({ to: "bounce@example.com" }),
    );
    expect(sent.status).toBe(200);

    await tick();

    const events = await db.query<{ type: string }>(
      "select type from email_events where email_id = $1 order by created_at",
      [sent.json.id],
    );
    expect(events.rows.map((row) => row.type)).toContain("email.bounced");
    const suppressed = await db.query(
      "select email, reason from suppressions where removed_at is null",
    );
    expect(suppressed.rows).toEqual([
      { email: "bounce@example.com", reason: "email.bounced" },
    ]);
  });

  it("writes open and click events when the tracking urls are fetched", async () => {
    const sent = await post(
      fullKey,
      "/emails",
      letter({
        html: `<p><a href="https://example.com/docs">Docs</a></p>`,
        text: undefined,
      }),
    );
    expect(sent.status).toBe(200);

    const stored = await db.query<{
      html: string;
      html_tracked: string | null;
    }>("select html, html_tracked from emails where id = $1", [sent.json.id]);
    expect(stored.rows[0]?.html ?? "").not.toContain("/click/");
    const html = stored.rows[0]?.html_tracked ?? "";
    const click = new URL(
      html.match(/href="(https?:\/\/[^"]+\/click\/[^"]+)"/)?.[1] ?? "",
    );
    const open = new URL(
      html.match(/src="(https?:\/\/[^"]+\/open\/[^"]+)"/)?.[1] ?? "",
    );

    const opened = await app.inject({
      method: "GET",
      url: `${open.pathname}${open.search}`,
    });
    const clicked = await app.inject({
      method: "GET",
      url: `${click.pathname}${click.search}`,
    });
    expect(opened.statusCode).toBe(200);
    expect(clicked.statusCode).toBe(302);

    const events = await db.query<{ type: string }>(
      "select type from email_events where email_id = $1 order by created_at",
      [sent.json.id],
    );
    expect(events.rows.map((row) => row.type)).toEqual(
      expect.arrayContaining(["email.opened", "email.clicked"]),
    );
  });

  it("verifies a delivered webhook with sign and queues a second attempt after a refusal", async () => {
    const received: Array<{
      url: string;
      body: string;
      id: string;
      timestamp: string;
      signature: string;
    }> = [];
    const server = createServer((request, response) =>
      recordWebhook(request, response, received),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("webhook server did not bind");
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const accepted = await post(fullKey, "/webhooks", {
        url: `${base}/ok`,
        events: ["email.sent"],
      });
      const refused = await post(fullKey, "/webhooks", {
        url: `${base}/refuse`,
        events: ["email.sent"],
      });
      expect(accepted.status).toBe(200);
      expect(refused.status).toBe(200);

      const sent = await post(
        fullKey,
        "/emails",
        letter({ to: "webhook@example.com" }),
      );
      expect(sent.status).toBe(200);
      await tick();

      const delivery = received.find((call) => call.url === "/ok");
      expect(delivery).toBeTruthy();
      const signed = sign(
        delivery!.body,
        accepted.json.signing_secret,
        delivery!.id,
        Number(delivery!.timestamp),
      );
      expect(signed.signature).toBe(delivery!.signature);
      expect(
        verify(
          delivery!.body,
          accepted.json.signing_secret,
          delivery!.id,
          delivery!.timestamp,
          delivery!.signature,
        ),
      ).toBe(true);

      const attempts = await db.query<{ attempt: number; state: string }>(
        "select attempt, state from webhook_attempts where webhook_id = $1 order by attempt",
        [refused.json.id],
      );
      expect(attempts.rows).toEqual([
        { attempt: 1, state: "failed" },
        { attempt: 2, state: "queued" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

async function call(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) {
  const response = await app.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "dispatch-accept-test",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.statusCode,
    json: response.body ? response.json() : null,
  };
}

// A user with a password and a role, made through the API the way the team page makes one. The
// email is new on every run, because sign-in counters live in Redis and outlast the truncate.
async function teammate(
  role: "Admin" | "Viewer",
  password = "a long private password",
) {
  const roles = await call(fullKey, "GET", "/roles");
  let found = (roles.json.data as Array<{ id: string; name: string }>).find(
    (row) => row.name === role,
  );
  if (!found)
    found = (
      await call(fullKey, "POST", "/roles", {
        name: role,
        permissions: [role === "Admin" ? "full" : "read"],
      })
    ).json;
  const email = `${role.toLowerCase()}-${id("run").slice(4, 14)}@example.com`;
  const user = await call(fullKey, "POST", "/users", {
    email,
    name: role,
    password,
  });
  expect(user.status).toBe(200);
  expect(
    (
      await call(fullKey, "POST", "/memberships", {
        user_id: user.json.id,
        role_id: found!.id,
      })
    ).status,
  ).toBe(200);
  return { email, password, id: user.json.id as string };
}

async function signInAs(email: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { "content-type": "application/json" },
    payload: { email, password },
  });
  return {
    status: response.statusCode,
    token: response.statusCode === 200 ? (response.json().token as string) : "",
  };
}

async function ensureDatabase() {
  const admin = connect(adminUrl);
  try {
    const existing = await admin.query(
      "select 1 from pg_database where datname = $1",
      [databaseName],
    );
    if (existing.rowCount === 0)
      await admin.query(
        `create database "${databaseName.replaceAll('"', '""')}"`,
      );
  } finally {
    await admin.end();
  }
}

async function truncate() {
  const tables = await db.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public'",
  );
  if (tables.rowCount === 0) return;
  const list = tables.rows
    .map((row) => `"${row.tablename.replaceAll('"', '""')}"`)
    .join(", ");
  const sql = `truncate ${list} restart identity cascade`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await db.query(sql);
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      if (code !== "40P01" || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function seedTenant() {
  const tenantId = id("tenant");
  const secret = makeKey().secret;
  const pepper =
    process.env.API_KEY_PEPPER ?? "dev-pepper-change-before-deploy";
  await tx(db, async (client) => {
    await client.query("insert into tenants (id, name) values ($1, $2)", [
      tenantId,
      "Test",
    ]);
    await client.query(
      "insert into domains (id, tenant_id, name, region, status, open_tracking, click_tracking) values ($1, $2, 'example.com', 'us-west-2', 'verified', true, true)",
      [id("domain"), tenantId],
    );
    await client.query(
      "insert into api_keys (id, tenant_id, name, prefix, hash, scope) values ($1, $2, 'full', $3, $4, 'full')",
      [id("key"), tenantId, secret.slice(0, 12), keyHash(secret, pepper)],
    );
  });
  return secret;
}

function letter(overrides: Record<string, unknown> = {}) {
  return {
    from: "hello@example.com",
    to: "you@example.com",
    subject: "Hello",
    text: "Hi",
    ...overrides,
  };
}

async function post(
  secret: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "user-agent": "dispatch-accept-test",
      ...headers,
    },
    payload: body,
  });
  return { status: response.statusCode, json: response.json() };
}

function recordWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  received: Array<{
    url: string;
    body: string;
    id: string;
    timestamp: string;
    signature: string;
  }>,
) {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    received.push({
      url: request.url ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
      id: request.headers["dispatch-webhook-id"]?.toString() ?? "",
      timestamp:
        request.headers["dispatch-webhook-timestamp"]?.toString() ?? "",
      signature:
        request.headers["dispatch-webhook-signature"]?.toString() ?? "",
    });
    if (request.url === "/refuse") {
      response.writeHead(500);
      response.end("no");
      return;
    }
    response.writeHead(200);
    response.end("ok");
  });
}
