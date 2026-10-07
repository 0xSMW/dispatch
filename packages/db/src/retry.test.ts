import { describe, expect, it, vi } from "vitest";
import { retryTx } from "./retry.js";
import type { Db } from "./index.js";

function fixture() {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => { calls.push(sql); return { rows: [] }; });
  const release = vi.fn(() => { calls.push("release"); });
  const connect = vi.fn(async () => { calls.push("connect"); return { query, release }; });
  return { db: { connect } as unknown as Db, query, connect, release, calls };
}
const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });

describe("scoped aborted transaction retry", () => {
  it("rolls back and releases before replaying the entire operation", async () => {
    const { db, calls } = fixture();
    let attempt = 0;
    const result = await retryTx(db, async () => {
      calls.push("read and write");
      if (++attempt === 1) throw deadlock();
      return "committed";
    });
    expect(result).toBe("committed");
    expect(calls).toEqual(["connect", "begin", "read and write", "rollback", "release",
      "connect", "begin", "read and write", "commit", "release"]);
  });
  it("bounds exhaustion at four fully rolled back attempts", async () => {
    const { db, connect, release, query } = fixture();
    await expect(retryTx(db, async () => { throw deadlock(); })).rejects.toMatchObject({ code: "40P01" });
    expect(connect).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.filter(([sql]) => sql === "rollback")).toHaveLength(4);
  });
  it.each(["40001", "23505", "08006", undefined])("does not replay other failures (%s)", async (code) => {
    const { db, connect } = fixture();
    await expect(retryTx(db, async () => { throw Object.assign(new Error("failure"), { code }); })).rejects.toThrow("failure");
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("does not replay an uncertain commit or failed rollback", async () => {
    for (const failure of ["commit", "rollback"]) {
      const { db, query, connect } = fixture();
      query.mockImplementation(async (sql) => {
        if (sql === failure) throw new Error(`${failure} connection lost`);
        return { rows: [] };
      });
      await expect(retryTx(db, async () => {
        if (failure === "rollback") throw deadlock();
      })).rejects.toThrow("connection lost");
      expect(connect).toHaveBeenCalledTimes(1);
    }
  });
});
