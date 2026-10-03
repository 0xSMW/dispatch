import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Db, ImportRow } from "@dispatchmail/db";
import { handleSendFailure, paceDurably } from "./deliver.js";
import { runImport } from "./imports.js";
import { acquireLease, nextWorkAt } from "./runtime.js";
import { ProviderError } from "@dispatchmail/core";

const job = { id: "job_1", tenant_id: "tenant_1", email_id: "email_1", request_id: "request_1" };

describe("durable worker boundaries", () => {
  it("does not retry a transport failure after the request crossed the SES boundary", async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith("select j.state")
      ? { rows: [{ state: "sending", provider_message_id: null }] } : { rows: [], rowCount: 1 });
    await handleSendFailure({ query } as unknown as Db, job, new ProviderError("socket closed", true), { durable: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("state = 'uncertain'"), [job.id, "SES acceptance is uncertain: socket closed"]);
    expect(query.mock.calls.some(([sql]) => sql.includes("state = 'ready'"))).toBe(false);
  });

  it("safely completes a saved acceptance id after event fanout failed", async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith("select j.state")
      ? { rows: [{ state: "sending", provider_message_id: "ses_accepted" }] } : { rows: [], rowCount: 1 });
    await handleSendFailure({ query } as unknown as Db, job, new Error("fanout interrupted"), { durable: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("state = 'ready'"), [job.id, "Error: fanout interrupted"]);
  });

  it("retries an explicit throttling rejection because SES did not accept the message", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("select j.state")) return { rows: [{ state: "sending", provider_message_id: null }] };
      if (sql.startsWith("select attempts")) return { rows: [{ attempts: 1 }] };
      return { rows: [], rowCount: 1 };
    });
    await handleSendFailure({ query } as unknown as Db, job, new ProviderError("Throttled", true, true), { durable: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("state = 'ready'"), [job.id, expect.any(Number), "Throttled"]);
    expect(query.mock.calls.some(([sql]) => sql.includes("state = 'uncertain'"))).toBe(false);
  });

  it("waits for the shared database send slot after its reservation commits", async () => {
    const actions: string[] = [];
    const query = vi.fn(async () => { actions.push("reserved"); return { rows: [{ delay_ms: "125" }] }; });
    const wait = vi.fn(async () => { actions.push("waited"); });
    await paceDurably({ query } as unknown as Db, "us-west-2", 8, wait);
    expect(actions).toEqual(["reserved", "waited"]);
    expect(wait).toHaveBeenCalledWith(125);
    expect(query.mock.calls).toHaveLength(1);
  });

  it("reports lease contention without claiming work", async () => {
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    expect(await acquireLease({ query } as unknown as Db, "run_1")).toBe(false);
    expect(query.mock.calls).toHaveLength(1);
  });

  it("finishes without an idle timer when the database has no pending work", async () => {
    const query = vi.fn(async () => ({ rows: [{ next_at: null }] }));
    expect(await nextWorkAt({ query } as unknown as Db)).toBeNull();
  });

  it("preserves the exact due timestamp for long scheduled sends", async () => {
    const at = "2027-01-01T00:00:00.000Z";
    const query = vi.fn(async () => ({ rows: [{ next_at: new Date(at) }] }));
    expect(await nextWorkAt({ query } as unknown as Db)).toBe(at);
  });

  it("commits a bounded import and leaves the rest queued with a durable offset", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const query = vi.fn(async (sql: string, args: unknown[] = []) => {
      calls.push({ sql, args });
      if (sql.includes("insert into contacts")) return { rows: (args[0] as string[]).map((id) => ({ id, created: true })) };
      return { rows: [], rowCount: 1 };
    });
    const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Db;
    const imported = {
      id: "import_1", tenant_id: "tenant_1", storage_key: "imports/one", column_map: {},
      on_conflict: "upsert", topics: [], segments: [], row_offset: 0,
      counts: { total: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
    } as unknown as ImportRow;
    const storage = { stream: async () => Readable.from(["email\na@example.com\nb@example.com\nc@example.com\n"]) };
    const counts = await runImport(db, storage, imported, { maxRows: 2 });
    expect(counts).toEqual({ total: 2, created: 2, updated: 0, skipped: 0, failed: 0 });
    expect(calls.find(({ sql }) => sql.startsWith("update contact_imports set counts"))?.args[2]).toBe(2);
    expect(calls.some(({ sql }) => sql.includes("set status = 'queued'"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("completed_at = now()"))).toBe(false);
    expect(calls.filter(({ sql }) => sql.includes("insert into contacts"))).toHaveLength(1);
  });
});
