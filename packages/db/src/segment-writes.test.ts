import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "./index.js";
import { staticSegment, updateSegment, assertSegmentSteps } from "./segment-writes.js";

const rule = { type: "rule", field: "contact.email", operator: "exists" } as const;
function database(results: unknown[][]) {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: results.shift() ?? [] }));
  return { query, db: { query } as unknown as Queryable };
}

describe("segment write locks", () => {
  it("distinguishes missing and dynamic resources before any membership write", async () => {
    const missing = database([[]]);
    await expect(staticSegment(missing.db, "t", "s")).rejects.toMatchObject({ name: "not_found", statusCode: 404 });
    const dynamic = database([[{ id: "s", rule }]]);
    await expect(staticSegment(dynamic.db, "t", "s")).rejects.toMatchObject({ name: "conflict", statusCode: 409 });
    expect(dynamic.query).toHaveBeenCalledExactlyOnceWith(
      "select id, rule from segments where tenant_id = $1 and id = $2 and deleted_at is null for update", ["t", "s"],
    );
  });
  it("refuses populated static conversion under the membership row lock", async () => {
    const { db, query } = database([[{ id: "s", rule: null }], [{ id: "m" }]]);
    await expect(updateSegment(db, "t", "s", { rule })).rejects.toMatchObject({ statusCode: 409 });
    expect(query.mock.calls).toHaveLength(2);
  });
  it("rejects cyclic malformed rules before recursive conversion dependency checks", async () => {
    const cyclic = { type: "and", rules: [] } as unknown as import("@dispatchmail/core").Rule & { rules: import("@dispatchmail/core").Rule[] };
    cyclic.rules.push(cyclic);
    const { db, query } = database([[{ id: "s", rule: null }]]);
    await expect(updateSegment(db, "t", "s", { rule: cyclic })).rejects.toMatchObject({ name: "validation_error", statusCode: 400 });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("clears stale dynamic members only for explicit null, preserving omitted rules", async () => {
    const row = { id: "s", name: "Filter", description: null, rule };
    const converted = database([[row], [], [{ ...row, rule: null }]]);
    expect((await updateSegment(converted.db, "t", "s", { rule: null })).rule).toBeNull();
    expect(converted.query.mock.calls[1]).toEqual(["delete from segment_contacts where tenant_id = $1 and segment_id = $2", ["t", "s"]]);
    expect((converted.query.mock.calls[2] as unknown[])[1]).toEqual(["t", "s", "Filter", null, null]);
    const renamed = database([[row], [{ ...row, name: "Renamed" }]]);
    await updateSegment(renamed.db, "t", "s", { name: "Renamed" });
    expect((renamed.query.mock.calls[1] as unknown[])[1]).toEqual(["t", "s", "Renamed", null, JSON.stringify(rule)]);
    const staticRenamed = database([[{ ...row, rule: null }], [{ ...row, rule: null }]]);
    await updateSegment(staticRenamed.db, "t", "s", { name: "Still static" });
    expect((staticRenamed.query.mock.calls[1] as unknown[])[1]).toEqual(["t", "s", "Still static", null, null]);
  });
  it("refuses unresolved saved engagement on automation enable", async () => {
    const { db, query } = database([]);
    await expect(assertSegmentSteps(db, "t", [{ key: "test", type: "condition", config: { type: "rule", field: "email.opened", operator: "eq", value: true } }]))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(query).not.toHaveBeenCalled();
  });
});
