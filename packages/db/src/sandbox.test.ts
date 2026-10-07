import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearBrandCache, ingestEmail, type IngestEmailInput } from "./emails.js";
import type { Queryable } from "./index.js";

function client(settings: Record<string, unknown> = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("select settings from tenants")) return { rows: [{ settings }] };
    if (sql.includes("select name, brand from tenants")) return { rows: [{ name: "Dispatch", brand: {} }] };
    if (sql.includes("from domains")) {
      return { rows: [{ id: "dom_1", name: "dispatch-fixture.net", sending: "enabled" }] };
    }
    if (sql.includes("from templates")) {
      return {
        rows: [{
          id: "version_1", template_id: "template_1", subject: "Hello {{name}}",
          html: "<p>Hello {{name}}</p>", text: null, variables: ["name"], track: false,
        }],
      };
    }
    if (sql.includes("insert into emails")) {
      return {
        rows: [{
          id: params[0], request_id: params[2], from: params[4], subject: params[7],
          status: params[17], scheduled_at: params[18], sandbox: params[23],
          created_at: "2026-10-01T00:00:00.000Z",
        }],
      };
    }
    return { rows: [] };
  });
  return { query } as unknown as Queryable & { query: typeof query };
}

const input: IngestEmailInput = {
  tenantId: "tenant_1", requestId: "req_1", emailId: "email_1",
  from: "hello@dispatch-fixture.net", subject: "Hello", text: "Hello world",
};

function insert(db: ReturnType<typeof client>, table: string) {
  const call = db.query.mock.calls.find(([sql]) => sql.includes(`insert into ${table} `));
  expect(call).toBeDefined();
  if (table === "emails") {
    const columns = call![0].match(/insert into emails \(([\s\S]*?)\)/)?.[1];
    expect(columns?.split(",").map((column) => column.trim())).toEqual([
      "id", "tenant_id", "request_id", "idempotency_key", "from_email", "from_name",
      "reply_to", "subject", "html", "html_tracked", "text", "template_id",
      "template_version_id", "headers", "tags", "topic_id", "broadcast_id", "status",
      "scheduled_at", "api_key_id", "contact_id", "automation_id", "automation_step",
      "sandbox", "automation_run_id",
    ]);
    expect(call![1]).toHaveLength(25);
  }
  return { sql: call![0], params: call![1]! };
}

describe("sandbox email storage", () => {
  beforeEach(() => clearBrandCache());

  it.each([
    "ada@example.com", "ada@EXAMPLE.NET", "ada@sub.example.org",
    "ada@foo.test", "ada@foo.example", "ada@foo.invalid",
  ])("stores reserved recipient %s as sandbox with default settings", async (to) => {
    const db = client();
    const result = await ingestEmail(db, { ...input, to });
    expect(db.query).toHaveBeenCalledWith("select settings from tenants where id = $1", ["tenant_1"]);
    const email = insert(db, "emails");
    expect(email.params[23]).toBe(true);
    expect(email.params[24]).toBeNull();
    const recipients = insert(db, "email_recipients");
    expect(recipients.sql).toContain("$7::boolean[]");
    expect(recipients.params[6]).toEqual([true]);
    expect(recipients.params[5]).toEqual(["queued"]);
    expect(result.email).toMatchObject({ sandbox: true, status: "queued", to: [to] });
    expect(insert(db, "send_jobs").params.slice(1)).toEqual(["tenant_1", "email_1", "req_1", null]);
  });

  it("stores an ordinary recipient as a real send with default settings", async () => {
    const db = client();
    const result = await ingestEmail(db, { ...input, to: "ada@dispatch-fixture.net" });
    const email = insert(db, "emails");
    expect(email.params[23]).toBe(false);
    expect(email.params[24]).toBeNull();
    expect(insert(db, "email_recipients").params[6]).toEqual([false]);
    expect(result.email).toMatchObject({ sandbox: false, status: "queued" });
    expect(insert(db, "send_jobs").params[4]).toBeNull();
  });

  it("uses tenant-configured domains without replacing reserved defaults", async () => {
    const db = client({ sandbox_domains: [" QA.dispatch-fixture.net "] });
    const result = await ingestEmail(db, {
      ...input, to: ["ada@QA.dispatch-fixture.net", "bob@SUB.qa.dispatch-fixture.net", "eve@example.com"],
    });
    const email = insert(db, "emails");
    expect(email.params[23]).toBe(true);
    expect(email.params[24]).toBeNull();
    expect(insert(db, "email_recipients").params[6]).toEqual([true, true, true]);
    expect(result.email.sandbox).toBe(true);
  });

  it("keeps mixed to, cc and bcc metadata aligned and schedules the usual send job", async () => {
    const db = client({ sandbox_domains: ["qa.dispatch-fixture.net"] });
    const scheduledAt = new Date(Date.now() + 3_600_000);
    const result = await ingestEmail(db, {
      ...input, to: "ada@example.com", cc: "bob@qa.dispatch-fixture.net",
      bcc: "eve@dispatch-fixture.net", scheduledAt,
    });
    const email = insert(db, "emails");
    expect(email.params[23]).toBe(false);
    expect(email.params[24]).toBeNull();
    expect(email.params[17]).toBe("scheduled");
    expect(email.params[18]).toEqual(scheduledAt);
    const recipients = insert(db, "email_recipients");
    expect(recipients.params[3]).toEqual(["ada@example.com", "bob@qa.dispatch-fixture.net", "eve@dispatch-fixture.net"]);
    expect(recipients.params[4]).toEqual(["to", "cc", "bcc"]);
    expect(recipients.params[5]).toEqual(["queued", "queued", "queued"]);
    expect(recipients.params[6]).toEqual([true, true, false]);
    expect(result.email).toMatchObject({ sandbox: false, status: "scheduled", to: ["ada@example.com"] });
    expect(insert(db, "send_jobs").params.slice(1)).toEqual(["tenant_1", "email_1", "req_1", scheduledAt]);
  });

  it("schedules an all-sandbox email rather than bypassing send jobs", async () => {
    const db = client();
    const scheduledAt = new Date(Date.now() + 3_600_000);
    const result = await ingestEmail(db, { ...input, to: "ada@example.com", scheduledAt });
    const email = insert(db, "emails");
    expect(email.params[23]).toBe(true);
    expect(email.params[24]).toBeNull();
    expect(insert(db, "email_recipients").params[6]).toEqual([true]);
    expect(result.email).toMatchObject({ sandbox: true, status: "scheduled" });
    expect(insert(db, "send_jobs").params[4]).toEqual(scheduledAt);
  });

  it("renders templates and generates text normally for sandbox recipients", async () => {
    const db = client();
    await ingestEmail(db, {
      ...input, to: "ada@example.com", subject: undefined, text: undefined,
      template: "welcome", variables: { name: "Ada" },
    });
    const email = insert(db, "emails");
    expect(email.params[7]).toBe("Hello Ada");
    expect(email.params[8]).toBe("<p>Hello Ada</p>");
    expect(email.params[9]).toBeNull();
    expect(email.params[10]).toBe("Hello Ada");
    expect(email.params.slice(11, 13)).toEqual(["template_1", "version_1"]);
    expect(email.params[23]).toBe(true);
    expect(email.params[24]).toBeNull();
    expect(insert(db, "send_jobs").params[4]).toBeNull();
  });

  it.each([
    { to: "ada@example.com", sandbox: true },
    { to: "ada@dispatch-fixture.net", sandbox: false },
  ])("keeps supplied run attribution separate from sandbox=$sandbox", async ({ to, sandbox }) => {
    const db = client();
    const result = await ingestEmail(db, { ...input, to, automationRunId: "run_1" });
    const email = insert(db, "emails");
    expect(email.params[23]).toBe(sandbox);
    expect(email.params[24]).toBe("run_1");
    expect(insert(db, "email_recipients").params[6]).toEqual([sandbox]);
    expect(result.email).toMatchObject({ sandbox, status: "queued", to: [to] });
    expect(insert(db, "send_jobs").params.slice(1)).toEqual(["tenant_1", "email_1", "req_1", null]);
  });
});
