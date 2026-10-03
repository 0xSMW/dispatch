import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@dispatchmail/core";
import {
  acceptBatch,
  acceptEmail,
  clearBrandCache,
  fetchAttachment,
  retrackEmail,
  findBy,
  incrementUsage,
  paginate,
  publishedTemplate,
  softDelete,
  upsertContact
} from "./index.js";

describe("publishedTemplate", () => {
  it("returns published template when found", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: "ver_1",
            template_id: "tpl_1",
            subject: "Welcome",
            html: "<p>Hi</p>",
            text: "Hi",
            variables: ["name"]
          }
        ]
      })
    };
    const template = await publishedTemplate(mockDb, "tenant_1", "welcome");
    expect(template.id).toBe("ver_1");
    expect(template.subject).toBe("Welcome");
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("from templates t"), ["tenant_1", "welcome"]);
  });

  it("throws ApiError 404 when template is missing", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    };
    await expect(publishedTemplate(mockDb, "tenant_1", "missing")).rejects.toThrow(ApiError);
  });
});

describe("upsertContact", () => {
  const stored = {
    id: "cnt_1", email: "ada@example.com", first_name: null, last_name: null, properties: {},
    unsubscribed_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };

  it("handles email string", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [stored]
      })
    };
    const contact = await upsertContact(mockDb, "tenant_1", "ada@example.com");
    expect(contact.id).toBe("cnt_1");
    expect(contact).toMatchObject({ created: true, revived: false, before: null });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into contacts"),
      expect.arrayContaining(["tenant_1", "ada@example.com"])
    );
  });

  it("handles contact object with properties and unsubscribe status", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ ...stored, first_name: "Ada", properties: { plan: "pro" }, unsubscribed_at: "2026-10-01T00:00:00Z" }]
      })
    };
    const contact = await upsertContact(mockDb, "tenant_1", {
      email: "ada@example.com",
      first_name: "Ada",
      properties: { plan: "pro" },
      unsubscribed: true
    });
    expect(contact.unsubscribed_at).toBe("2026-10-01T00:00:00Z");
    expect(mockDb.query.mock.calls[0]![1]!.slice(2)).toEqual(["ada@example.com", "Ada", null, '{"plan":"pro"}', true]);
  });

  it.each([null, "2026-10-02T00:00:00Z"])("locks a conflicting contact and returns its complete previous snapshot (deleted_at=%s)", async (deletedAt) => {
    const before = { ...stored, first_name: "Grace", properties: { plan: "free" }, unsubscribed_at: "2026-10-01T00:00:00Z", deleted_at: deletedAt };
    const after = { ...stored, first_name: "Ada", properties: { plan: "pro" }, unsubscribed_at: before.unsubscribed_at };
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [before] }).mockResolvedValueOnce({ rows: [after] });
    const contact = await upsertContact({ query }, "tenant_1", { email: "ADA@example.com", first_name: "Ada", properties: { plan: "pro" } });
    expect(contact).toEqual({ ...after, created: false, revived: Boolean(deletedAt), before });
    expect(query.mock.calls[1]).toEqual([expect.stringContaining("limit 1 for update"), ["tenant_1", "ada@example.com"]]);
    expect(query.mock.calls[2]![1]).toEqual(["tenant_1", "cnt_1", "Ada", null, true, '{"plan":"pro"}', false, false]);
    expect(before.properties).toEqual({ plan: "free" });
  });

  it("does not invent a before snapshot when a concurrent contact disappears", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(upsertContact({ query }, "tenant_1", "ada@example.com")).rejects.toMatchObject({ name: "conflict", statusCode: 409 });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("incrementUsage", () => {
  it("executes usage counter upsert", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    };
    await incrementUsage(mockDb, "tenant_1", "emails.sent", 5);
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into usage_counters"),
      expect.arrayContaining(["tenant_1", "emails.sent", 5])
    );
  });
});

describe("findBy", () => {
  it("does not filter deleted_at on tables that have no such column", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: "email_1" }] })
    };
    await findBy(mockDb, "emails", "tenant_1", "email_1");
    const sql = mockDb.query.mock.calls[0][0] as string;
    expect(sql).not.toContain("deleted_at");
    expect(sql).toContain("from emails where tenant_id = $1 and id = $2");
  });

  it("finds a record by id and tenant", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "top_1", name: "News" }]
      })
    };
    const record = await findBy(mockDb, "topics", "tenant_1", "top_1");
    expect(record).toEqual({ id: "top_1", name: "News" });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("where tenant_id = $1 and id = $2 and deleted_at is null"),
      ["tenant_1", "top_1"]
    );
  });

  it("throws not_found ApiError if missing", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    };
    await expect(findBy(mockDb, "topics", "tenant_1", "top_missing")).rejects.toThrow("Topic not found");
  });
});

describe("softDelete", () => {
  it("updates deleted_at column", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rowCount: 1 })
    };
    await softDelete(mockDb, "topics", "tenant_1", "top_1");
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("update topics set deleted_at = now()"),
      ["tenant_1", "top_1"]
    );
  });
});

describe("paginate", () => {
  it("pages forward on created_at and id when timestamps match", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { id: "email_2", created_at: "2026-10-01T00:00:00.000Z" },
          { id: "email_1", created_at: "2026-10-01T00:00:00.000Z" }
        ]
      })
    };
    const result = await paginate(mockDb, { table: "emails", tenantId: "tenant_1" }, { limit: 2, after: "email_3" });
    const sql = mockDb.query.mock.calls[0][0] as string;
    expect(sql).toContain("order by created_at desc, id desc");
    expect(sql).toContain("(created_at, id) <");
    expect(result.data.map((row) => row.id)).toEqual(["email_2", "email_1"]);
    expect(result.has_more).toBe(false);
  });

  it("returns backward pages in list order", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { id: "email_1" },
          { id: "email_2" }
        ]
      })
    };
    const result = await paginate(mockDb, { table: "emails", tenantId: "tenant_1" }, { before: "email_3" });
    const sql = mockDb.query.mock.calls[0][0] as string;
    expect(sql).toContain("order by created_at asc, id asc");
    expect(result.data.map((row) => row.id)).toEqual(["email_2", "email_1"]);
  });

  it("rejects after and before together", async () => {
    const mockDb = { query: vi.fn() };
    await expect(
      paginate(mockDb, { table: "emails", tenantId: "tenant_1" }, { after: "email_1", before: "email_2" })
    ).rejects.toMatchObject({ name: "validation_error", statusCode: 400 });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("filters deleted domains when the caller asks", async () => {
    const mockDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await paginate(mockDb, { table: "domains", tenantId: "tenant_1", deletedCol: "deleted_at" }, { limit: 20 });
    expect(mockDb.query.mock.calls[0][0]).toContain("deleted_at is null");
  });

  it("returns list structure with cursor pagination", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "1" }, { id: "2" }]
      })
    };
    const result = await paginate(
      mockDb,
      { table: "emails", tenantId: "tenant_1" },
      { limit: 2 }
    );
    expect(result.object).toBe("list");
    expect(result.has_more).toBe(false);
    expect(result.data).toHaveLength(2);
  });

  it("indicates has_more when rows exceed limit", async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "1" }, { id: "2" }, { id: "3" }]
      })
    };
    const result = await paginate(
      mockDb,
      { table: "emails", tenantId: "tenant_1" },
      { limit: 2 }
    );
    expect(result.has_more).toBe(true);
    expect(result.data).toHaveLength(2);
  });
});

describe("acceptEmail", () => {
  function emailDb() {
    const query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("select settings from tenants")) return Promise.resolve({ rowCount: 1, rows: [{ settings: {} }] });
      if (sql.includes("from domains")) return Promise.resolve({ rowCount: 1, rows: [{ id: "dom_1" }] });
      if (sql.includes("from suppressions")) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes("insert into emails")) {
        return Promise.resolve({
          rows: [{ id: "email_1", request_id: "req_1", from: "hello@example.com", subject: "Hi", status: "queued", scheduled_at: null, created_at: "2026-10-01T00:00:00.000Z" }]
        });
      }
      if (sql.includes("insert into idempotency_keys")) return Promise.resolve({ rowCount: 1, rows: [{ id: "idem_1" }] });
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    return { query, connect: vi.fn() };
  }

  it("writes the email on the caller transaction and does not open another", async () => {
    const client = emailDb();
    const result = await acceptEmail(
      { connect: vi.fn() } as never,
      { from: "hello@example.com", to: "ada@example.com", subject: "Hi", text: "Hello" },
      { tenant_id: "tenant_1", api_key_id: "key_1", request_id: "req_1" },
      { client }
    );
    expect(result).toMatchObject({ email: { id: "email_1" } });
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("insert into emails"), expect.any(Array));
  });

  it("creates the parent email before inserting inline attachment metadata", async () => {
    const client = emailDb();
    const originalQuery = client.query.getMockImplementation()!;
    const emailIds = new Set<string>();
    client.query.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes("insert into emails")) emailIds.add(params[0] as string);
      if (sql.includes("insert into email_attachments")) {
        for (const emailId of params[2] as string[]) {
          if (!emailIds.has(emailId)) throw new Error("email_attachments_email_id_fkey");
        }
      }
      return originalQuery(sql);
    });
    const storeAttachment = vi.fn().mockResolvedValue(undefined);
    await acceptEmail(
      client as never,
      {
        from: "hello@example.com", to: "ada@example.com", subject: "Hi", text: "Hello",
        attachments: [{ filename: "a.txt", content: "YQ==", disposition: "inline", content_id: "logo" }],
      },
      { tenant_id: "tenant_1", request_id: "req_1" },
      { client, storeAttachment },
    );
    const insert = client.query.mock.calls.find((call) => String(call[0]).includes("insert into email_attachments"))!;
    const params = insert[1] as unknown[];
    expect(params[2]).toEqual([...emailIds]);
    expect(params[3]).toEqual(["a.txt"]);
    expect(params[5]).toEqual(["logo"]);
    expect(params[6]).toEqual(["inline"]);
    expect(params[7]).toEqual([1]);
    expect(storeAttachment).toHaveBeenCalledWith((params[9] as string[])[0], Buffer.from("a"));
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("rejects a reused idempotency key that carries a different payload", async () => {
    const client = emailDb();
    client.query.mockImplementation((sql: string) => {
      if (sql.includes("insert into idempotency_keys")) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes("from idempotency_keys")) {
        return Promise.resolve({ rows: [{ request_hash: "other", response_json: null, state: "done" }] });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
    await expect(
      acceptEmail(
        client as never,
        { from: "hello@example.com", to: "ada@example.com", subject: "Hi", text: "Hello" },
        { tenant_id: "tenant_1", request_id: "req_1", idempotency_key: "idem-1" },
        { client }
      )
    ).rejects.toMatchObject({ name: "invalid_idempotent_request", statusCode: 409 });
  });

  it("rejects an idempotency key that is still running", async () => {
    const client = emailDb();
    client.query.mockImplementation((sql: string) => {
      if (sql.includes("insert into idempotency_keys")) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes("from idempotency_keys")) {
        return Promise.resolve({ rows: [{ request_hash: "same", response_json: null, state: "running" }] });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
    const stable = await import("@dispatchmail/core");
    const body = { from: "hello@example.com", to: "ada@example.com", subject: "Hi", text: "Hello" };
    client.query.mockImplementation((sql: string) => {
      if (sql.includes("insert into idempotency_keys")) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.includes("from idempotency_keys")) {
        return Promise.resolve({ rows: [{ request_hash: stable.stableHash(stable.sendSchema.parse(body)), response_json: null, state: "running" }] });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
    await expect(
      acceptEmail(client as never, body, { tenant_id: "tenant_1", request_id: "req_1", idempotency_key: "idem-1" }, { client })
    ).rejects.toMatchObject({ name: "concurrent_idempotent_requests", statusCode: 409 });
  });

  it("rejects a sender outside the API key domain before it writes", async () => {
    const client = emailDb();
    await expect(
      acceptEmail(
        client as never,
        { from: "hello@other.test", to: "ada@example.com", subject: "Hi", text: "Hello" },
        { tenant_id: "tenant_1", request_id: "req_1", domain_name: "example.com" },
        { client }
      )
    ).rejects.toMatchObject({ name: "validation_error", statusCode: 403 });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("stores a display name and generates text from html", async () => {
    const client = emailDb();
    await acceptEmail(
      client as never,
      {
        from: "Acme <hello@example.com>",
        to: "ada@example.com",
        subject: "Hi",
        html: "<p>Hi Ada</p>",
        reply_to: "Team <team@example.com>"
      },
      { tenant_id: "tenant_1", request_id: "req_1" },
      { client }
    );
    const insert = client.query.mock.calls.find((call) => String(call[0]).includes("insert into emails"));
    const params = insert?.[1] as unknown[];
    expect(params[4]).toBe("hello@example.com");
    expect(params[5]).toBe("Acme");
    expect(params[6]).toBe(JSON.stringify(["Team <team@example.com>"]));
    expect(params[8]).toBe("<p>Hi Ada</p>");
    expect(params[10]).toMatch(/Hi Ada/);
  });
});

describe("acceptEmail with a schedule phrase and a template sender", () => {
  function db(extra: (sql: string, params: unknown[]) => unknown = () => undefined) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const custom = extra(sql, params);
      if (custom) return Promise.resolve(custom);
      if (sql.includes("select settings from tenants")) return Promise.resolve({ rowCount: 1, rows: [{ settings: {} }] });
      if (sql.includes("from domains")) return Promise.resolve({ rowCount: 1, rows: [{ id: "dom_1", name: "example.com", sending: "enabled" }] });
      if (sql.includes("insert into emails")) {
        return Promise.resolve({
          rows: [{ id: params[0], request_id: "req_1", from: params[4], subject: "Hi", status: "queued", scheduled_at: null, created_at: "2026-10-01T00:00:00.000Z" }]
        });
      }
      if (sql.includes("insert into idempotency_keys")) return Promise.resolve({ rowCount: 1, rows: [{ id: "idem_1" }] });
      return Promise.resolve({ rowCount: 0, rows: [] });
    });
    return { query, calls };
  }

  it("hashes the body as the client sent it, so a retry of 'in 1 hour' matches", async () => {
    const core = await import("@dispatchmail/core");
    const body = { from: "hello@example.com", to: "ada@example.com", subject: "Hi", text: "Hello", scheduled_at: "in 1 hour" };
    const hashes: unknown[] = [];
    for (const at of ["2026-10-01T10:00:00.000Z", "2026-10-01T10:00:07.000Z"]) {
      const client = db();
      await acceptEmail(
        client as never,
        body,
        { tenant_id: "tenant_1", request_id: "req_1", idempotency_key: "idem-1" },
        { client, prepare: (input) => ({ ...(input as object), scheduled_at: at }) }
      );
      hashes.push(client.calls.find((call) => call.sql.includes("insert into idempotency_keys"))?.params[3]);
    }
    expect(hashes[0]).toBe(core.stableHash(body));
    expect(hashes[1]).toBe(hashes[0]);
  });

  it("takes the sender from the template and holds a restricted key to its domain", async () => {
    clearBrandCache();
    const template = {
      id: "version_1",
      template_id: "template_1",
      subject: "Welcome",
      html: "<p>Hi</p>",
      text: null,
      variables: [],
      from_address: "Acme Team <team@example.com>",
      reply_to: [],
      track: true
    };
    const client = db((sql) => (sql.includes("from templates") ? { rowCount: 1, rows: [template] } : undefined));
    await acceptEmail(
      client as never,
      { to: "ada@example.com", template: "welcome" },
      { tenant_id: "tenant_1", request_id: "req_1" },
      { client }
    );
    const insert = client.calls.find((call) => call.sql.includes("insert into emails"));
    expect(insert?.params[4]).toBe("team@example.com");
    expect(insert?.params[5]).toBe("Acme Team");
    expect(client.calls.find((call) => call.sql.includes("lower(name) = $2"))?.params[1]).toBe("example.com");

    const restricted = db((sql) => (sql.includes("from templates") ? { rowCount: 1, rows: [template] } : undefined));
    await expect(
      acceptEmail(
        restricted as never,
        { to: "ada@example.com", template: "welcome" },
        { tenant_id: "tenant_1", request_id: "req_1", domain_name: "other.test" },
        { client: restricted }
      )
    ).rejects.toMatchObject({ statusCode: 403, message: "API key is restricted to another domain" });
  });

  it("refuses a domain with sending turned off and a topic that does not exist", async () => {
    const off = db((sql) => (sql.includes("from domains") ? { rowCount: 1, rows: [{ id: "dom_1", name: "example.com", sending: "disabled" }] } : undefined));
    await expect(
      acceptEmail(off as never, { from: "hello@example.com", to: "ada@example.com", subject: "Hi", text: "Hello" }, { tenant_id: "tenant_1", request_id: "req_1" }, { client: off })
    ).rejects.toMatchObject({ statusCode: 403, message: "Sending is disabled for this domain" });

    const client = db();
    await expect(
      acceptEmail(
        client as never,
        { from: "hello@example.com", to: "ada@example.com", subject: "Hi", text: "Hello", topic_id: "topic_typo" },
        { tenant_id: "tenant_1", request_id: "req_1" },
        { client, unsubscribe: { secret: "test-secret", appUrl: "https://app.example", publicUrl: "https://api.example" } }
      )
    ).rejects.toMatchObject({ statusCode: 422, message: "Topic not found" });
    expect(client.calls.some((call) => call.sql.includes("insert into emails"))).toBe(false);
  });

  it("matches a suppressed address in any case", async () => {
    const client = db((sql) => (sql.includes("from suppressions") ? { rowCount: 1, rows: [{ email: "bob@example.com" }] } : undefined));
    await acceptEmail(
      client as never,
      { from: "hello@example.com", to: "Bob@Example.com", subject: "Hi", text: "Hello" },
      { tenant_id: "tenant_1", request_id: "req_1" },
      { client }
    );
    const lookup = client.calls.find((call) => call.sql.includes("from suppressions"));
    expect(lookup?.sql).toContain("lower(email) = any($2)");
    expect(lookup?.params[1]).toEqual(["bob@example.com"]);
    const recipients = client.calls.find((call) => call.sql.includes("insert into email_recipients"));
    expect(recipients?.params[5]).toEqual(["suppressed"]);
    expect(client.calls.some((call) => call.sql.includes("insert into send_jobs"))).toBe(false);
  });
});

describe("retrackEmail", () => {
  it("replaces the tokens and returns the tracked copy of the new html", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("from emails e")) {
          return Promise.resolve({ rows: [{ name: "example.com", open_tracking: false, click_tracking: true, tracking_subdomain: "links", records: [], track: true }] });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      })
    };
    const tracked = await retrackEmail(client, {
      tenantId: "tenant_1",
      emailId: "email_1",
      html: `<a href="https://example.com/new">New</a>`,
      publicUrl: "https://api.example"
    });
    expect(calls[0].sql).toContain("delete from tracking_tokens");
    expect(tracked).toContain("https://api.example/click/");
    const tokens = calls.find((call) => call.sql.includes("insert into tracking_tokens"));
    expect(tokens?.params[4]).toEqual(["https://example.com/new"]);
    await expect(retrackEmail(client, { tenantId: "tenant_1", emailId: "email_1", html: null })).resolves.toBeNull();
  });
});

describe("fetchAttachment", () => {
  it("refuses a loopback host without fetching it", async () => {
    await expect(fetchAttachment("http://127.0.0.1/secret.png", 1000, vi.fn() as never)).rejects.toMatchObject({
      name: "invalid_attachment",
      statusCode: 422
    });
  });

  it("stops reading a body with no content-length once it passes the limit", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(400));
      }
    });
    const fetcher = vi.fn(async () => new Response(body, { status: 200 }));
    await expect(fetchAttachment("https://93.184.216.34/big.bin", 1000, fetcher as never)).rejects.toMatchObject({
      name: "invalid_attachment",
      message: "Attachments exceed 40 MB"
    });
    expect(pulled).toBeLessThan(10);
  });

  it("returns the bytes of a body under the limit", async () => {
    const fetcher = vi.fn(async () => new Response(Buffer.from("hello"), { status: 200 }));
    await expect(fetchAttachment("https://93.184.216.34/a.txt", 1000, fetcher as never)).resolves.toEqual(Buffer.from("hello"));
  });
});

describe("acceptBatch", () => {
  it("keeps the valid emails in permissive mode and rolls the failed one back", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (["begin", "commit", "rollback", "savepoint batch_item", "release savepoint batch_item", "rollback to savepoint batch_item"].includes(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("select settings from tenants")) return { rowCount: 1, rows: [{ settings: {} }] };
      if (sql.includes("from domains")) {
        const name = params?.[1];
        return name === "example.com"
          ? { rowCount: 1, rows: [{ id: "dom_1" }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes("from suppressions")) return { rowCount: 0, rows: [] };
      if (sql.includes("insert into emails")) {
        return {
          rows: [{ id: params?.[0], request_id: "req_1", from: "hello@example.com", subject: "Hi", status: "queued", scheduled_at: null, created_at: "2026-10-01T00:00:00.000Z" }]
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const client = { query, release: vi.fn() };
    const db = { connect: async () => client };
    const result = await acceptBatch(
      db as never,
      [
        { from: "hello@example.com", to: "ada@dispatch-fixture.net", subject: "Hi", text: "Hello" },
        { from: "hello@missing.test", to: "ada@dispatch-fixture.net", subject: "Hi", text: "Hello" }
      ],
      { tenant_id: "tenant_1", request_id: "req_1" },
      { validation: "permissive" }
    );
    expect(result.data).toEqual([{ id: expect.any(String), sandbox: false }]);
    expect(result.errors).toEqual([{ index: 1, message: "Sender domain is not verified" }]);

    const mixed = await acceptBatch(
      db as never,
      [
        { from: "hello@example.com", to: "not-an-email", subject: "Hi", text: "Hello" },
        { from: "hello@example.com", to: "ada@dispatch-fixture.net", subject: "Hi", text: "Hello", attachments: [] },
        { from: "hello@example.com", to: "ada@dispatch-fixture.net", subject: "Hi", text: "Hello" }
      ],
      { tenant_id: "tenant_1", request_id: "req_1" },
      { validation: "permissive" }
    );
    expect(mixed.data).toHaveLength(1);
    expect(mixed.errors).toEqual([
      { index: 0, message: "to: must be email@domain or Name <email@domain>" },
      { index: 1, message: "attachments are not supported in batch sends" }
    ]);
    expect(query).toHaveBeenCalledWith("rollback to savepoint batch_item");
    expect(query).toHaveBeenCalledWith("commit");
  });
});

describe("findAutomation", () => {
  it("finds automation by id", async () => {
    const { findAutomation } = await import("./automations.js");
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: "auto_1", name: "Onboarding" }]
      })
    };
    const res = await findAutomation(mockDb, "tenant_1", "auto_1");
    expect(res.name).toBe("Onboarding");
  });
});

describe("ingestEmail", () => {
  it("creates email record and associated entities", async () => {
    const { ingestEmail } = await import("./emails.js");
    const mockClient = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("select settings from tenants")) return Promise.resolve({ rowCount: 1, rows: [{ settings: {} }] });
        if (sql.includes("from domains")) {
          return Promise.resolve({ rowCount: 1, rows: [{ id: "dom_1" }] });
        }
        if (sql.includes("from suppressions")) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (sql.includes("insert into emails")) {
          return Promise.resolve({
            rows: [
              {
                id: "email_1",
                request_id: "req_1",
                from: "hello@example.com",
                subject: "Hi",
                status: "queued",
                scheduled_at: null,
                created_at: new Date().toISOString()
              }
            ]
          });
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      })
    };
    const res = await ingestEmail(mockClient, {
      tenantId: "tenant_1",
      requestId: "req_1",
      from: "hello@example.com",
      to: "ada@example.com",
      subject: "Hi",
      text: "Hello world"
    });
    expect(res.email.id).toBe("email_1");
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into emails"),
      expect.any(Array)
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into email_recipients"),
      expect.any(Array)
    );
  });

  it("keeps the caller's html and stores the tracked copy separately", async () => {
    const { ingestEmail } = await import("./emails.js");
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const mockClient = {
      query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("select settings from tenants")) return Promise.resolve({ rowCount: 1, rows: [{ settings: {} }] });
        if (sql.includes("from domains")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{
              id: "dom_1",
              name: "example.com",
              open_tracking: true,
              click_tracking: true,
              tracking_subdomain: "links",
              records: [{ record: "Tracking", status: "verified" }]
            }]
          });
        }
        if (sql.includes("insert into emails")) {
          return Promise.resolve({
            rows: [{ id: "email_1", request_id: "req_1", from: "hello@example.com", subject: "Hi", status: "queued", scheduled_at: null, created_at: "2026-10-01T00:00:00.000Z" }]
          });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      })
    };
    await ingestEmail(mockClient, {
      tenantId: "tenant_1",
      requestId: "req_1",
      from: "hello@example.com",
      to: "ada@example.com",
      subject: "Hi",
      html: `<p><a href="https://example.com/docs">Docs</a></p>`
    });
    const insert = queries.find((query) => query.sql.includes("insert into emails"));
    expect(insert?.params[8]).toBe(`<p><a href="https://example.com/docs">Docs</a></p>`);
    // A verified tracking record is not enough to move links off PUBLIC_URL: the host also needs a certificate.
    expect(String(insert?.params[9])).toContain("http://localhost:3000/click/");
    expect(String(insert?.params[9])).toContain("/open/");

    const before = process.env.TRACKING_CUSTOM_HOSTS;
    process.env.TRACKING_CUSTOM_HOSTS = "true";
    try {
      queries.length = 0;
      await ingestEmail(mockClient, {
        tenantId: "tenant_1",
        requestId: "req_1",
        from: "hello@example.com",
        to: "ada@example.com",
        subject: "Hi",
        html: `<p><a href="https://example.com/docs">Docs</a></p>`
      });
      const custom = queries.find((query) => query.sql.includes("insert into emails"));
      expect(String(custom?.params[9])).toContain("https://links.example.com/click/");
    } finally {
      if (before === undefined) delete process.env.TRACKING_CUSTOM_HOSTS;
      else process.env.TRACKING_CUSTOM_HOSTS = before;
    }
  });

  it("leaves html alone when the template turns tracking off", async () => {
    const { ingestEmail } = await import("./emails.js");
    const { clearBrandCache } = await import("./emails.js");
    clearBrandCache();
    const html = `<p><a href="https://example.com/reset">Reset</a></p>`;
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const mockClient = {
      query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("select settings from tenants")) return Promise.resolve({ rowCount: 1, rows: [{ settings: {} }] });
        if (sql.includes("from templates")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{
              id: "ver_1",
              template_id: "template_1",
              subject: "Reset",
              html,
              text: null,
              variables: [],
              track: false
            }]
          });
        }
        if (sql.includes("from domains")) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{
              id: "dom_1",
              name: "example.com",
              open_tracking: true,
              click_tracking: true,
              tracking_subdomain: "links",
              records: [{ record: "Tracking", status: "verified" }]
            }]
          });
        }
        if (sql.includes("insert into emails")) {
          return Promise.resolve({
            rows: [{ id: "email_1", request_id: "req_1", from: "hello@example.com", subject: "Reset", status: "queued", scheduled_at: null, created_at: "2026-10-01T00:00:00.000Z" }]
          });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      })
    };
    await ingestEmail(mockClient, {
      tenantId: "tenant_1",
      requestId: "req_1",
      from: "hello@example.com",
      to: "ada@example.com",
      template: "password-reset"
    });
    const insert = queries.find((query) => query.sql.includes("insert into emails"));
    expect(insert?.params[8]).toBe(html);
    expect(insert?.params[9]).toBeNull();
  });
});

