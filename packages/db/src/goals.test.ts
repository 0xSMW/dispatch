import { describe, expect, it, vi } from "vitest";
import { goalHistoryLimit, type Rule } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { createGoal, deleteGoal, getGoal, goalColumns, goalMetrics, presentGoal, updateGoal } from "./goals.js";

function database(results: unknown[][] = []) {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: results.shift() ?? [] }));
  return { query, db: { query } as unknown as Queryable };
}

const input = { name: "Purchase", target: { event: "purchased" }, window_days: 30 };
const row = {
  ...input, id: "goal_1", tenant_id: "tenant_1", eligibility: null,
  created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z", deleted_at: null,
};
const metricRow = {
  start_date: "2026-09-01T12:00:00Z", end_date: "2026-09-03T00:00:00Z", valid_range: true,
  available_from: "2026-08-01T00:00:00Z",
  data: [
    { date: "2026-09-01", contacts_reached: "3", converted: "1" },
    { date: "2026-09-02", contacts_reached: 0, converted: 0 },
  ],
};
const rule: Rule = { type: "rule", field: "contact.score", operator: "gte", value: 10 };

describe("goal persistence (mocked database)", () => {
  it("presents public fields and ISO dates", () => {
    expect(presentGoal(row)).toEqual({
      ...input, object: "goal", id: "goal_1", eligibility: null,
      created_at: "2026-10-05T00:00:00.000Z", updated_at: "2026-10-05T00:00:00.000Z",
    });
    expect(goalColumns).toContain("deleted_at");
  });

  it("creates tenant-owned goals with defaults and encoded JSON", async () => {
    const { db, query } = database([[], [row]]);
    expect(await createGoal(db, "tenant_1", { name: " Purchase ", target: input.target })).toEqual(row);
    expect(query.mock.calls[0]![1]).toEqual(["tenant_1"]);
    expect(query.mock.calls[0]![0]).toContain("deleted_at is null");
    expect(query.mock.calls[1]![1]).toEqual([
      expect.stringMatching(/^goal_/), "tenant_1", "Purchase", '{"event":"purchased"}', null, 30,
    ]);
  });

  it("rejects schema errors before IO and invalid declared property rules before writing", async () => {
    const badSchema = database();
    await expect(createGoal(badSchema.db, "tenant_1", { ...input, window_days: 366 }))
      .rejects.toMatchObject({ name: "validation_error", statusCode: 400 });
    expect(badSchema.query).not.toHaveBeenCalled();
    for (const properties of [[], [{ key: "score", type: "string" }]]) {
      const { db, query } = database([properties]);
      await expect(createGoal(db, "tenant_1", { ...input, target: { rule } }))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it("accepts goals beyond segment-only depth and condition limits", async () => {
    let target: Rule = { type: "and", rules: Array.from({ length: 21 }, () => rule) };
    for (let index = 0; index < 6; index++) target = { type: "and", rules: [target] };
    const { db, query } = database([[{ key: "score", type: "number" }], [row]]);
    await createGoal(db, "tenant_1", { ...input, target: { rule: target } });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("refuses set-history targets while accepting current-state set eligibility", async () => {
    for (const field of ["contact.topics", "contact.segments"]) {
      const membership: Rule = { type: "rule", field, operator: "contains", value: "set_1" };
      const bad = database([[]]);
      await expect(createGoal(bad.db, "tenant_1", { ...input, target: { rule: membership } }))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(bad.query).toHaveBeenCalledTimes(1);
      const good = database(field === "contact.segments" ? [[], [], [row]] : [[], [row]]);
      await createGoal(good.db, "tenant_1", { ...input, eligibility: membership });
      expect(good.query).toHaveBeenCalledTimes(field === "contact.segments" ? 3 : 2);
    }
  });
  it("refuses dynamic segment eligibility instead of silently evaluating unresolved membership", async () => {
    const { db } = database([[], [{ id: "dynamic", dynamic: true }]]);
    await expect(createGoal(db, "tenant_1", { ...input,
      eligibility: { type: "rule", field: "contact.segments", operator: "contains", value: "dynamic" },
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("updates only supplied fields, preserving explicit null and omitted window", async () => {
    const { db, query } = database([[row], [], [row]]);
    await updateGoal(db, "tenant_1", "goal_1", { name: "Updated", eligibility: null, window_days: undefined });
    expect(query.mock.calls[2]![1]).toEqual(["tenant_1", "goal_1", "Updated", null]);
    expect(query.mock.calls[2]![0]).toContain("name = $3, eligibility = $4::jsonb");
    expect(query.mock.calls[2]![0]).not.toContain("window_days =");
    const invalid = database();
    await expect(updateGoal(invalid.db, "tenant_1", "goal_1", { target: { event: "@synthetic" } }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(invalid.query).not.toHaveBeenCalled();
  });

  it("uses tenant/live filters for reads, updates, and soft deletion", async () => {
    const missing = database();
    await expect(getGoal(missing.db, "other", "goal_1")).rejects.toMatchObject({ statusCode: 404 });
    expect(missing.query.mock.calls[0]![1]).toEqual(["other", "goal_1"]);
    expect(missing.query.mock.calls[0]![0]).toContain("deleted_at is null");
    const vanished = database([[row], [], []]);
    await expect(updateGoal(vanished.db, "tenant_1", "goal_1", {})).rejects.toMatchObject({ statusCode: 404 });
    const removed = database([[{ id: "goal_1" }], []]);
    expect(await deleteGoal(removed.db, "tenant_1", "goal_1")).toBe(true);
    expect(await deleteGoal(removed.db, "tenant_1", "goal_1")).toBe(false);
    expect(removed.query.mock.calls[0]![0]).toContain("set deleted_at = clock_timestamp()");
    expect(removed.query.mock.calls[0]![1]).toEqual(["tenant_1", "goal_1"]);
  });
});

describe("goal query construction and presentation (not SQL execution evidence)", () => {
  it("presents fractional totals, UTC cohort rows, zero denominator and history disclosure", async () => {
    const { db, query } = database([[row], [], [metricRow]]);
    const result = await goalMetrics(db, "tenant_1", "goal_1", {});
    expect(result).toMatchObject({
      object: "goal_metrics", goal_id: "goal_1", contacts_reached: 3, converted: 1, rate: 1 / 3,
      start_date: "2026-09-01T12:00:00.000Z", end_date: "2026-09-03T00:00:00.000Z",
      history: { available_from: "2026-08-01T00:00:00.000Z", limitation: goalHistoryLimit },
    });
    expect(result.data[1]).toEqual({ date: "2026-09-02", contacts_reached: 0, converted: 0, rate: 0 });
    const sql = String(query.mock.calls[2]![0]);
    expect(sql).toContain("statement_timestamp()");
    expect(sql).toContain("end_date - interval '720 hours'");
    expect(sql).toContain("generate_series(");
    expect(sql).toContain("at time zone 'UTC'");
    const empty = database([[row], [], [{ ...metricRow, available_from: null, data: [] }]]);
    expect(await goalMetrics(empty.db, "tenant_1", "goal_1", {}))
      .toMatchObject({ contacts_reached: 0, converted: 0, rate: 0, history: { available_from: null } });
  });

  it("constructs first real send across history before date filtering and bounded event conversions", async () => {
    const { db, query } = database([[row], [], [{ id: "broadcast_1" }], [metricRow]]);
    await goalMetrics(db, "tenant_1", "goal_1", {
      broadcast_id: "broadcast_1", start_date: "2026-09-01T00:00:00Z", end_date: "2026-09-03T00:00:00Z",
    });
    expect(query.mock.calls[2]![1]).toEqual(["tenant_1", "broadcast_1"]);
    const sql = String(query.mock.calls[3]![0]);
    expect(sql).toContain("c.id = e.contact_id and c.deleted_at is null");
    expect(sql).toContain("min(ev.created_at) as first_send");
    expect(sql).toContain("ev.type = 'email.sent'");
    expect(sql).toContain("then ev.data->>'sandbox' = 'false'");
    expect(sql).not.toContain("and e.sandbox = false");
    expect(sql.indexOf("min(ev.created_at)")).toBeLessThan(sql.indexOf("f.first_send >= b.start_date"));
    expect(sql).toContain("ce.tenant_id = c.tenant_id and lower(ce.email) = lower(c.email)");
    expect(sql).toContain("ce.deleted_at is null");
    expect(sql).toContain("ce.created_at >= c.first_send and ce.created_at <= c.window_end");
    expect(sql).not.toContain("ce.created_at < b.end_date");
    expect(sql).not.toContain("goal.created_at");
    expect(query.mock.calls[3]![1]).toEqual([
      "tenant_1", "2026-09-03T00:00:00Z", "2026-09-01T00:00:00Z", 30, "broadcast_1", "purchased",
    ]);
  });

  it("validates exclusive live scopes, automation steps, dates, and default date ordering", async () => {
    for (const input of [
      { automation_id: "a", broadcast_id: "b" }, { step_key: "s" },
      { start_date: "2026-09-03T00:00:00Z", end_date: "2026-09-01T00:00:00Z" },
    ]) {
      const bad = database();
      await expect(goalMetrics(bad.db, "tenant_1", "goal_1", input)).rejects.toMatchObject({ statusCode: 400 });
      expect(bad.query).not.toHaveBeenCalled();
    }
    for (const scope of [{ automation_id: "other" }, { broadcast_id: "other" }]) {
      const missing = database([[row], [], []]);
      await expect(goalMetrics(missing.db, "tenant_1", "goal_1", scope)).rejects.toMatchObject({ statusCode: 404 });
      expect(missing.query.mock.calls[2]![1]).toEqual(["tenant_1", "other"]);
      expect(missing.query.mock.calls[2]![0]).toContain("deleted_at is null");
    }
    const step = database([[row], [], [{ steps: [{ key: "send" }] }], [{ ...metricRow, data: [] }]]);
    expect(await goalMetrics(step.db, "tenant_1", "goal_1", { automation_id: "a", step_key: "removed" }))
      .toMatchObject({ contacts_reached: 0, converted: 0, rate: 0 });
    const dates = database([[row], [], [{ ...metricRow, valid_range: false }]]);
    await expect(goalMetrics(dates.db, "tenant_1", "goal_1", { start_date: "2099-01-01T00:00:00Z" }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("uses coherent grouped receipt snapshots and whole-rule entry, with current eligibility", async () => {
    const compound: Rule = { type: "and", rules: [rule, {
      type: "rule", field: "contact.first_name", operator: "eq", value: "Ada",
    }] };
    const { db, query } = database([
      [{ ...row, target: { rule: compound }, eligibility: { type: "rule", field: "contact.topics", operator: "contains", value: "topic_1" } }],
      [{ key: "score", type: "number" }], [{ steps: [{ key: "send" }] }], [metricRow],
    ]);
    await goalMetrics(db, "tenant_1", "goal_1", { automation_id: "automation_1", step_key: "send" });
    const sql = String(query.mock.calls[3]![0]);
    expect(sql).toContain("e.automation_step =");
    expect(sql).toContain("group by ch.tenant_id, ch.contact_id, ch.created_at, ch.request_id");
    expect(sql).toContain("where not (");
    expect(sql).toContain(") and (");
    expect(sql).toContain("(ch.created_at,ch.request_id) >= (h.created_at,h.request_id)");
    expect(sql).toContain("(ch.created_at,ch.request_id) > (h.created_at,h.request_id)");
    expect(sql).toContain("ch.contact_id = c.id");
    expect(sql).toContain("ch.created_at >= c.first_send and ch.created_at <= c.window_end");
    expect(sql).toContain("topic_subscriptions");
    expect(sql).toContain("least(f.first_send +");
  });
});
