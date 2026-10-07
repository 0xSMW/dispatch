import { describe, expect, it, vi } from "vitest";
import { evaluate, type GoalInput, type Rule } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { assertGoalHistoryFields, goalState } from "./goal-history.js";
import { goalMetrics } from "./goals.js";
import { goalStatePredicate, type SegmentProperty } from "./segments.js";

const createdAt = "2026-09-01T00:00:00.000Z";
const receiptAt = "2026-09-02T00:00:00.000Z";
const exists: Rule = { type: "rule", field: "contact.created_at", operator: "exists" };
const score: Rule = { type: "rule", field: "contact.score", operator: "gte", value: 10 };
const name: Rule = { type: "rule", field: "contact.first_name", operator: "eq", value: "Ada" };
const properties: SegmentProperty[] = [
  { key: "created_at", type: "date" }, { key: "score", type: "number" },
  { key: "purchased_at", type: "date" },
];

// Exact fragment contract, not a SQL interpreter: only the immutable builtin is
// excluded. All other selection, ordering, JSON precedence and grouping stay put.
function expectedState(side: "before" | "after") {
  const comparison = side === "before" ? ">=" : ">";
  return `((
    c.properties || jsonb_build_object('email',c.email,'first_name',c.first_name,'last_name',c.last_name,
      'created_at',to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'unsubscribed',c.unsubscribed_at is not null)
  ) || coalesce((
    select jsonb_object_agg(rewind.field,rewind.from_value) from (
      select distinct on (ch.field) ch.field,ch.from_value
      from contact_changes ch
      where ch.tenant_id = h.tenant_id and ch.contact_id = h.contact_id
        and ch.field <> 'created_at'
        and ch.field not like 'topics.%' and ch.field not like 'segments.%'
        and (ch.created_at,ch.request_id) ${comparison} (h.created_at,h.request_id)
      order by ch.field,ch.created_at,ch.request_id,ch.id
    ) rewind
  ),'{}'::jsonb))`;
}

async function metricSql(target: GoalInput["target"], eligibility: Rule | null = null) {
  const results: unknown[][] = [
    [{
      id: "goal_1", tenant_id: "tenant_1", name: "Target", target, eligibility,
      window_days: 30, created_at: createdAt, updated_at: createdAt, deleted_at: null,
    }],
    properties,
    [{ id: "broadcast_1" }],
    [{
      start_date: createdAt, end_date: "2026-09-03T00:00:00.000Z", valid_range: true,
      available_from: receiptAt,
      data: [{ date: "2026-09-01", contacts_reached: 1, converted: 0 }],
    }],
  ];
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: results.shift() ?? [] }));
  await goalMetrics({ query } as unknown as Queryable, "tenant_1", "goal_1", {
    broadcast_id: "broadcast_1", start_date: createdAt, end_date: "2026-09-03T00:00:00.000Z",
  });
  expect(query).toHaveBeenCalledTimes(4);
  return { sql: String(query.mock.calls[3]![0]), params: query.mock.calls[3]![1] };
}

describe("goal history SQL contracts (offline, not SQL execution evidence)", () => {
  it.each(["before", "after"] as const)(
    "keeps builtin created_at immune to custom null-to-date history in the %s state",
    (side) => {
      expect(goalState(side)).toBe(expectedState(side));
      const values: unknown[] = [];
      const predicate = goalStatePredicate(
        exists, (value) => { values.push(value); return `$${values.length}`; },
        properties, goalState(side), "h.created_at",
      );
      expect(values).toEqual(["created_at"]);
      expect(predicate).toContain(expectedState(side));
      expect(assertGoalHistoryFields(exists)).toBe(true);
    },
  );

  it.each(["and", "or"] as const)(
    "evaluates the whole grouped %s before and after, not individual changed leaves",
    async (type) => {
      const rule: Rule = { type, rules: [exists, { type: "and", rules: [score, name] }] };
      const { sql, params } = await metricSql({ rule });
      const values: unknown[] = ["tenant_1", "2026-09-03T00:00:00.000Z", createdAt, 30, "broadcast_1"];
      const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
      const before = goalStatePredicate(rule, bind, properties, expectedState("before"), "h.created_at");
      const after = goalStatePredicate(rule, bind, properties, expectedState("after"), "h.created_at");
      expect(sql).toContain(`where not (${before}) and (${after})`);
      expect(params).toEqual(values);
      expect(sql).toContain("group by ch.tenant_id, ch.contact_id, ch.created_at, ch.request_id");
      expect(sql).toContain("ch.created_at >= c.first_send and ch.created_at <= c.window_end");

      // A custom created_at patch cannot create a false-to-true builtin exists
      // transition. These are explicit expected snapshots, not mocked SQL results.
      const beforeContext = { contact: { created_at: createdAt, score: 0, first_name: "Grace" } };
      const afterContext = { contact: { created_at: createdAt, score: 0, first_name: "Grace" } };
      expect(evaluate(rule, beforeContext)).toBe(type === "or");
      expect(evaluate(rule, afterContext)).toBe(type === "or");
      expect(!evaluate(rule, beforeContext) && evaluate(rule, afterContext)).toBe(false);
    },
  );

  it("preserves event conversion SQL, current eligibility, real sends and first-send cohorts", async () => {
    const { sql, params } = await metricSql({ event: "purchased" }, exists);
    expect(sql).toContain(`exists (
      select 1 from custom_events ce
      where ce.tenant_id = c.tenant_id and lower(ce.email) = lower(c.email)
        and ce.deleted_at is null and ce.name = $6
        and ce.created_at >= c.first_send and ce.created_at <= c.window_end
    )`);
    expect(sql).toContain("min(ev.created_at) as first_send");
    expect(sql).toContain("ev.type = 'email.sent'");
    expect(sql).toContain("then ev.data->>'sandbox' = 'false'");
    expect(sql).toContain("e.broadcast_id = $5");
    expect(sql).toContain("c.deleted_at is null");
    expect(sql).toContain("least(f.first_send + $4::integer * interval '24 hours', b.measured_at)");
    expect(sql).toContain("f.first_send >= b.start_date and f.first_send < b.end_date");
    expect(sql).toContain("to_char(c.created_at at time zone 'UTC'");
    expect(sql.indexOf("min(ev.created_at)")).toBeLessThan(sql.indexOf("f.first_send >= b.start_date"));
    expect(sql).not.toContain("rewind");
    expect(sql).not.toContain("ce.created_at < b.end_date");
    expect(params).toEqual(["tenant_1", "2026-09-03T00:00:00.000Z", createdAt, 30, "broadcast_1", "purchased"]);
  });
});

describe("mutable history and whole-rule evaluation fixture contracts", () => {
  it.each([
    ["email", "old@example.com", "new@example.com"],
    ["first_name", "Grace", "Ada"],
    ["last_name", "Hopper", "Lovelace"],
    ["unsubscribed", false, true],
    ["score", 0, 20],
    ["purchased_at", null, receiptAt],
  ] as const)("retains a genuine %s transition in both rewind predicates", (field, from, to) => {
    const rule: Rule = { type: "rule", field: `contact.${field}`, operator: "eq", value: to };
    expect(assertGoalHistoryFields(rule)).toBe(true);
    for (const side of ["before", "after"] as const) {
      const values: unknown[] = [];
      const predicate = goalStatePredicate(
        rule, (value) => { values.push(value); return `$${values.length}`; },
        properties, goalState(side), "h.created_at",
      );
      expect(predicate).toContain(goalState(side));
      expect(goalState(side)).not.toContain(`ch.field <> '${field}'`);
      expect(values).toEqual([field, JSON.stringify(to)]);
    }
    expect(evaluate(rule, { contact: { [field]: from } })).toBe(false);
    expect(evaluate(rule, { contact: { [field]: to } })).toBe(true);
  });

  it.each(["and", "or"] as const)("preserves a genuine grouped %s entry", (type) => {
    const rule: Rule = { type, rules: [score, name] };
    const before = { contact: { score: 0, first_name: "Grace" } };
    const after = { contact: { score: 20, first_name: "Ada" } };
    expect(evaluate(rule, before)).toBe(false);
    expect(evaluate(rule, after)).toBe(true);
  });

  it.each(["and", "or"] as const)("does not count a %s leaf swap as whole-rule entry", (type) => {
    const rule: Rule = { type, rules: [score, name] };
    const before = { contact: { score: 20, first_name: "Grace" } };
    const after = { contact: { score: 0, first_name: "Ada" } };
    expect(evaluate(name, before)).toBe(false);
    expect(evaluate(name, after)).toBe(true);
    expect(evaluate(rule, before)).toBe(type === "or");
    expect(evaluate(rule, after)).toBe(type === "or");
    expect(!evaluate(rule, before) && evaluate(rule, after)).toBe(false);
  });
});
