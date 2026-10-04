import { describe, expect, it, vi } from "vitest";
import type { Db } from "./index.js";
import { migrate } from "./migration.js";
import { schema } from "./schema.js";

function database(eventOnly: boolean, exists = true) {
  const query = vi.fn(async (sql: string): Promise<{ rows: unknown[] }> => {
    if (sql.includes("to_regclass")) return { rows: [{ automations: exists ? "automations" : null, runs: exists ? "automation_runs" : null }] };
    if (sql.includes("as event_only")) return { rows: [{ event_only: eventOnly }] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const connect = vi.fn().mockResolvedValue(client);
  return { db: { connect } as unknown as Db, client, query, connect };
}

describe("migration", () => {
  it("captures event-only provenance under locks before applying SQL on the same transaction", async () => {
    const { db, client, query, connect } = database(true);
    await migrate(db);
    expect(connect).toHaveBeenCalledTimes(1);
    const calls = query.mock.calls.map(([sql]) => sql);
    expect(calls[0]).toBe("begin");
    expect(calls[1]).toContain("pg_advisory_xact_lock");
    expect(calls[3]).toBe("lock table automations, automation_runs in access exclusive mode");
    expect(calls[4]).toContain("attname = 'trigger_type'");
    expect(calls[4]).toContain("attname = 'depth'");
    expect(query.mock.calls[5]).toEqual(["select set_config('dispatch.legacy_event_roots', $1, true)", ["true"]]);
    expect(calls[6]).toBe(schema);
    expect(calls[7]).toBe("commit");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("does not mark current/mixed-era or fresh schemas as legacy roots (tables exist: %s)", async (exists) => {
    const { db, query } = database(false, exists);
    await migrate(db);
    expect(query.mock.calls.find(([sql]) => sql.includes("set_config"))).toEqual([
      "select set_config('dispatch.legacy_event_roots', $1, true)", ["false"],
    ]);
    expect(query.mock.calls.some(([sql]) => sql.startsWith("lock table"))).toBe(exists);
  });

  it("rolls back a failed upgrade without retaining the capture or any schema changes", async () => {
    const { db, query, client } = database(true);
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql) => {
      if (sql === schema) throw new Error("upgrade failed");
      return original(sql);
    });
    await expect(migrate(db)).rejects.toThrow("upgrade failed");
    expect(query.mock.calls.at(-1)).toEqual(["rollback"]);
    expect(query.mock.calls.some(([sql]) => sql === "commit")).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
