import { describe, expect, it, vi } from "vitest";
import { pruneLogs, pruneLogsIfDue, retentionDays, contactChangesRetentionDays, pruneContactChanges, pruneContactChangesIfDue } from "./logs.js";

describe("log retention", () => {
  it("deletes log rows older than the retention window", async () => {
    const db = { query: vi.fn(async () => ({ rowCount: 4, rows: [] })) };
    const state = { last: 0 };
    const removed = await pruneLogsIfDue(db, state, 60_000, 30);
    expect(removed).toBe(4);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("delete from logs"),
      [30, 10_000],
    );
    expect(await pruneLogsIfDue(db, state, 90_000, 30)).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("defaults the window to 30 days", async () => {
    expect(retentionDays()).toBe(30);
    expect(retentionDays(Number.NaN)).toBe(30);
    const db = { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) };
    await pruneLogs(db);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [30, 10_000]);
  });

  it("deletes in batches and stops at the first short batch or the pass limit", async () => {
    const counts = [3, 3, 1];
    const db = { query: vi.fn(async () => ({ rowCount: counts.shift() ?? 0, rows: [] })) };
    expect(await pruneLogs(db, 30, 3)).toBe(7);
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(String(db.query.mock.calls[0])).toContain("limit $2");

    const endless = { query: vi.fn(async () => ({ rowCount: 3, rows: [] })) };
    expect(await pruneLogs(endless, 30, 3, 4)).toBe(12);
    expect(endless.query).toHaveBeenCalledTimes(4);
  });
});

describe("contact change retention", () => {
  it("defaults to 400 and rejects invalid windows", () => {
    for (const value of [0, -1, NaN, Infinity, 0.5]) expect(contactChangesRetentionDays(value)).toBe(400);
    expect(contactChangesRetentionDays(450.8)).toBe(450);
  });

  it("bounds passes and waits one minute between cleanup loops", async () => {
    const db = { query: vi.fn(async () => ({ rowCount: 2, rows: [] })) };
    expect(await pruneContactChanges(db, 400, 2, 3)).toBe(6);
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("delete from contact_changes"), [400, 2]);
    const state = { last: 0 };
    expect(await pruneContactChangesIfDue(db, state, 60_000)).toBe(2);
    expect(await pruneContactChangesIfDue(db, state, 90_000)).toBe(0);
  });
});
