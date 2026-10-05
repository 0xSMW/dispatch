import { describe, expect, it, vi } from "vitest";
import { formSchema, type FormRecord } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { createForm, deleteForm, formColumns, getForm, getFormByKey, presentForm, reserveConfirmation, updateForm, validateForm } from "./forms.js";

function database(results: unknown[][] = []) {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: results.shift() ?? [] }));
  return { query, db: { query } as unknown as Queryable };
}

const input = formSchema.parse({
  name: "Newsletter", topic_ids: ["topic_1"], properties: ["company"],
  from_email: "hello@EXAMPLE.com", allowed_origins: ["https://example.com"],
  redirect_url: "https://example.com/thanks",
});
const row: FormRecord = {
  ...input, id: "form_1", tenant_id: "tenant_1", key: "public_key",
  created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z", deleted_at: null,
};
const references = () => [[{ id: "domain_1" }], [{ id: "topic_1" }], [{ key: "company" }]];

describe("form persistence", () => {
  it("presents only public fields and ISO dates", () => {
    expect(presentForm(row)).toEqual({
      ...input, id: "form_1", key: "public_key", object: "form",
      created_at: "2026-10-05T00:00:00.000Z", updated_at: "2026-10-05T00:00:00.000Z",
    });
    expect(formColumns).toContain("deleted_at");
  });

  it("validates exact live tenant references with shared locks", async () => {
    const { db, query } = database(references());
    await validateForm(db, "tenant_1", input);
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      ["tenant_1", "example.com"], ["tenant_1", ["topic_1"]], ["tenant_1", ["company"]],
    ]);
    expect(query.mock.calls[0]![0]).toContain("lower(name) = $2");
    expect(query.mock.calls[0]![0]).toContain("status = 'verified' and sending = 'enabled'");
    for (const call of query.mock.calls) {
      expect(call[0]).toContain("deleted_at is null");
      expect(call[0]).toContain("for share");
    }
  });

  it("rejects unverified senders, missing topics, and undeclared properties", async () => {
    for (const results of [[], [[{ id: "domain_1" }]], [[{ id: "domain_1" }], [{ id: "topic_1" }]]]) {
      const { db, query } = database(results);
      await expect(createForm(db, "tenant_1", input)).rejects.toMatchObject({ name: "validation_error", statusCode: 400 });
      expect(query.mock.calls.some((call) => String(call[0]).startsWith("insert"))).toBe(false);
    }
  });

  it("rejects unsafe redirects before any database call", async () => {
    const { db, query } = database();
    await expect(createForm(db, "tenant_1", { ...input, redirect_url: "http://example.com" }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(query).not.toHaveBeenCalled();
  });

  it("creates with a random public key and double opt-in default", async () => {
    const keys: string[] = [];
    for (let index = 0; index < 2; index++) {
      const { db, query } = database([...references(), [row]]);
      expect(await createForm(db, "tenant_1", input)).toEqual(row);
      const values = query.mock.calls[3]![1] as unknown[];
      expect(values[0]).toMatch(/^form_/);
      expect(values[1]).toBe("tenant_1");
      expect(values[2]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(values[6]).toBe(true);
      keys.push(values[2] as string);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("updates under a tenant row lock, preserving false, null, and omitted values", async () => {
    const { db, query } = database([[row], ...references(), [{ ...row, double_opt_in: false, redirect_url: null }]]);
    await updateForm(db, "tenant_1", "form_1", { double_opt_in: false, redirect_url: null, name: undefined });
    expect(query.mock.calls[0]![0]).toContain("for update");
    expect(query.mock.calls[4]![1]).toEqual([
      "tenant_1", "form_1", input.name, input.topic_ids, input.properties, false,
      input.from_email, input.allowed_origins, null,
    ]);
  });

  it("scopes live reads and soft deletion; unknown tenant forms are not found", async () => {
    const missing = database();
    await expect(getForm(missing.db, "other_tenant", "form_1", true))
      .rejects.toMatchObject({ name: "not_found", statusCode: 404 });
    expect(missing.query.mock.calls[0]![1]).toEqual(["other_tenant", "form_1"]);
    const publicRead = database([[row], []]);
    expect(await getFormByKey(publicRead.db, "public_key", true)).toEqual(row);
    expect(publicRead.query.mock.calls[0]![0]).toContain("deleted_at is null for update");
    expect(await getFormByKey(publicRead.db, "unknown")).toBeNull();
    const removed = database([[{ id: "form_1" }], []]);
    expect(await deleteForm(removed.db, "tenant_1", "form_1")).toBe(true);
    expect(await deleteForm(removed.db, "tenant_1", "form_1")).toBe(false);
    expect(removed.query.mock.calls[0]![0]).toContain("update forms set deleted_at");
    expect(removed.query.mock.calls[0]![1]).toEqual(["tenant_1", "form_1"]);
  });
});

describe("confirmation reservations (mocked SQL contract only)", () => {
  it("locks the tenant quota first and atomically reserves with fresh database UTC time", async () => {
    const { db, query } = database([[], [{ reserved: true }]]);
    expect(await reserveConfirmation(db, "tenant_1", "form_1", "USER@Example.com")).toBe(true);
    expect(query.mock.calls[0]).toEqual([
      "select pg_advisory_xact_lock(hashtextextended('confirmation_quota:' || $1::text, 0))",
      ["tenant_1"],
    ]);
    expect(query.mock.calls[1]![1]).toEqual(["tenant_1", "form_1", "user@example.com", 500]);
    const sql = String(query.mock.calls[1]![0]);
    expect(sql).toContain("clock_timestamp()");
    expect(sql).not.toContain("now()");
    expect(sql).toContain("at time zone 'UTC'");
    expect(sql).toContain("interval '24 hours'");
    expect(sql).toContain("from reservation");
    expect(sql).toContain("confirmation_days.sends + 1");
    expect(sql).toContain("tenant_id = $1 and id = $2 and deleted_at is null");
  });

  it("returns false for refused reservations, with no independent increment", async () => {
    const { db, query } = database([[], []]);
    expect(await reserveConfirmation(db, "tenant_1", "form_1", "user@example.com", 3)).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    const sql = String(query.mock.calls[1]![0]);
    expect(sql).toContain("0) < $4");
    expect(sql).toContain("and not exists (select 1 from confirmation_sends");
    expect(sql).toContain("where confirmation_sends.sent_at <= excluded.sent_at");
    expect(sql).toContain("select true as reserved from incremented");
  });

  it("fails closed for unusable caps without taking locks", async () => {
    const { db, query } = database();
    for (const cap of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
      expect(await reserveConfirmation(db, "tenant_1", "form_1", "user@example.com", cap)).toBe(false);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("propagates enqueue storage failures without managing the caller transaction", async () => {
    const { db, query } = database([[]]);
    const failure = new Error("write failed");
    query.mockRejectedValueOnce(failure);
    await expect(reserveConfirmation(db, "tenant_1", "form_1", "user@example.com", 500)).rejects.toBe(failure);
    expect(query.mock.calls.some((call) => /^(begin|commit|rollback)$/i.test(String(call[0])))).toBe(false);
  });
});
