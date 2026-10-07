import type { Queryable } from "@dispatchmail/db";
import { describe, expect, it, vi } from "vitest";
import { countHit, postgresSignins, pruneCounters } from "./counters.js";

function database(rows: Array<{ value: string; window_id: string }> = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, db: { query } as unknown as Queryable };
}

describe("PostgreSQL counters", () => {
  it("increments a shared bucket with one atomic upsert and a short expiry", async () => {
    const { db, query } = database([{ value: "11", window_id: "window_id" }]);
    expect(await countHit(db, "rate:tenant:123")).toBe(11);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain("on conflict (key) do update");
    expect(query.mock.calls[0][0]).toContain("counters.value + 1");
    expect(query.mock.calls[0][0]).toContain("interval '2 seconds'");
    expect(query.mock.calls[0][1][0]).toBe("rate:tenant:123");
  });

  it.each([undefined, "0", "NaN", "9007199254740992"])("fails closed when the count is unavailable (%s)", async (value) => {
    const { db } = database(value ? [{ value, window_id: "window_id" }] : []);
    await expect(countHit(db, "rate:tenant:123")).rejects.toThrow("counter unavailable");
  });

  it("reserves the tenth attempt and refuses the eleventh before password checks", async () => {
    const { db, query } = database([{ value: "10", window_id: "first-window_id" }]);
    const guard = postgresSignins(db);
    expect(await guard.take(" Ada@Example.com ")).toBe("first-window_id");
    expect(query.mock.calls[0][1]).toEqual(["signin:ada@example.com", 900, expect.any(String)]);
    query.mockResolvedValueOnce({ rows: [{ value: "11", window_id: "first-window_id" }] });
    expect(await guard.take("ada@example.com")).toBe(false);
  });

  it("returns the database window_id token, keeping the first attempt's expiry", async () => {
    const { db, query } = database([{ value: "1", window_id: "new-window_id" }]);
    expect(await postgresSignins(db).take("ada@example.com")).toBe("new-window_id");
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("then excluded.window_id else counters.window_id");
    expect(sql).toContain("then excluded.expires_at else counters.expires_at");
  });

  it("releases only the reservation's unexpired window_id", async () => {
    const { db, query } = database();
    await postgresSignins(db).release("ADA@example.com", "old-window_id");
    expect(query.mock.calls[0][1]).toEqual(["signin:ada@example.com", "old-window_id"]);
    expect(query.mock.calls[0][0]).toContain("window_id = $2 and expires_at > clock_timestamp()");
    expect(query.mock.calls[0][0]).toContain("greatest(value - 1, 0)");
  });

  it("never releases an unidentified reservation", async () => {
    const { db, query } = database();
    const guard = postgresSignins(db);
    await guard.release("ada@example.com");
    await guard.release("ada@example.com", true);
    expect(query).not.toHaveBeenCalled();
  });

  it("prunes bounded expired batches without waiting for locked request rows", async () => {
    const { db, query } = database();
    await pruneCounters(db, 50);
    expect(query.mock.calls[0][1]).toEqual([50]);
    expect(query.mock.calls[0][0]).toContain("for update skip locked");
    await expect(pruneCounters(db, 0)).rejects.toThrow("positive");
    expect(query).toHaveBeenCalledOnce();
  });
});
