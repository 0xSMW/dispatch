import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "./index.js";
import { assignVariant, splitMetrics } from "./splits.js";

const variants = [
  { key: "a", label: "A", weight: 50 },
  { key: "b", label: "B", weight: 50 },
] as const;

describe("split assignment", () => {
  it("uses unsigned big-endian SHA256 of only the UTF-8 run ID", () => {
    // Fixed first-four-byte vectors: 37ddff8e→58, d7cb4b25→85, 42272e6b→43.
    expect(assignVariant("run_1", variants)).toBe("b");
    expect(assignVariant("run_2", variants)).toBe("b");
    expect(assignVariant("run_3", variants)).toBe("a");
    // e3b0c442→10 and 512d3217→39, including empty and non-ASCII IDs.
    expect(assignVariant("", variants)).toBe("a");
    expect(assignVariant("réessai-🚀", variants)).toBe("a");
    expect(assignVariant("run_2", variants)).toBe(assignVariant("run_2", variants));
  });

  it("uses cumulative order, exclusive boundaries, and skips zero weights", () => {
    const ordered = [
      { key: "zero", label: "Zero", weight: 0 },
      { key: "a", label: "A", weight: 43 },
      { key: "b", label: "B", weight: 15 },
      { key: "c", label: "C", weight: 42 },
    ] as const;
    expect(assignVariant("run_3", ordered)).toBe("b"); // Bucket 43.
    expect(assignVariant("run_1", ordered)).toBe("c"); // Bucket 58.
    expect(assignVariant("run_3", [...variants].reverse())).toBe("b");
    expect(assignVariant("run_2", [
      { key: "a", label: "A", weight: 100 },
      { key: "b", label: "B", weight: 0 },
    ])).toBe("a");
  });

  it("does not mutate configuration or incorporate labels", () => {
    const frozen = Object.freeze(variants.map((variant) => Object.freeze({ ...variant })));
    expect(assignVariant("run_1", frozen)).toBe("b");
    expect(assignVariant("run_1", variants.map((variant) => ({ ...variant, label: "Changed" })))).toBe("b");
    expect(frozen).toEqual(variants);
  });

  it("validates the shared two-to-four-variant configuration", () => {
    const invalid = [
      [],
      [variants[0]],
      Array.from({ length: 5 }, (_, i) => ({ key: `v${i}`, label: "Variant", weight: 20 })),
      [variants[0], { ...variants[1], key: "a" }],
      [variants[0], { ...variants[1], key: "bad key" }],
      [variants[0], { ...variants[1], label: " " }],
      [variants[0], { ...variants[1], weight: 49 }],
      [{ ...variants[0], weight: -1 }, { ...variants[1], weight: 101 }],
      [{ ...variants[0], weight: 49.5 }, { ...variants[1], weight: 50.5 }],
      [{ ...variants[0], weight: Number.NaN }, variants[1]],
    ];
    for (const config of invalid) expect(() => assignVariant("run_1", config)).toThrow();
  });
});

const input = {
  automationId: "automation_1",
  stepKey: "split_1",
  start: new Date("2026-10-01T00:00:00.000Z"),
  end: new Date("2026-10-05T00:00:00.000Z"),
};

function mockDb(rows: Array<Record<string, unknown>> = []) {
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows }));
  return { db: { query } as unknown as Queryable, query };
}

describe("stored split metrics", () => {
  it("includes configured zero keys and historical assignments with nullable weights", async () => {
    const { db, query } = mockDb([
      { key: "retired", runs: "3", sent: "2", delivered: "1", unique_opened: "1" },
      { key: "a", runs: "2", sent: "4", delivered: "3", opened: "7", unique_opened: "1", clicked: "4",
        unique_clicked: "2", bounced: "1", complained: "1", unsubscribed: "1" },
    ]);
    const report = await splitMetrics(db, "tenant_1", input, [
      { ...variants[0], weight: 100 }, { ...variants[1], weight: 0 },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      object: "automation_split_metrics", automation_id: input.automationId, step_key: input.stepKey,
      start_date: input.start.toISOString(), end_date: input.end.toISOString(),
    });
    expect(report.data.map((row) => row.key)).toEqual(["a", "b", "retired"]);
    expect(report.data[0]).toEqual({
      key: "a", label: "A", weight: 100, runs: 2,
      sent: 4, delivered: 3, opened: 7, unique_opened: 1, clicked: 4, unique_clicked: 2,
      bounced: 1, complained: 1, unsubscribed: 1,
      delivery_rate: 75, open_rate: 33.33, click_rate: 66.67,
      bounce_rate: 25, complaint_rate: 33.33, unsubscribe_rate: 33.33,
    });
    expect(report.data[1]).toMatchObject({
      label: "B", weight: 0, runs: 0, sent: 0, delivered: 0, unique_opened: 0,
      delivery_rate: 0, open_rate: 0, click_rate: 0, bounce_rate: 0, complaint_rate: 0, unsubscribe_rate: 0,
    });
    expect(report.data[2]).toMatchObject({ key: "retired", label: "retired", weight: null, runs: 3, open_rate: 100 });
  });

  it("binds every dynamic value and scopes stored assignments and same-run mail", async () => {
    const { db, query } = mockDb();
    const scoped = { ...input, automationId: "automation';--", stepKey: "split';--" };
    await splitMetrics(db, "tenant';--", scoped, variants);
    const [sql, params] = query.mock.calls[0]!;
    expect(params).toEqual(["tenant';--", scoped.automationId, scoped.stepKey, input.start, input.end, ["a", "b"]]);
    for (const value of ["tenant';--", scoped.automationId, scoped.stepKey]) expect(sql).not.toContain(value);
    expect(sql).toContain("from automation_steps s");
    expect(sql).toContain("r.tenant_id = s.tenant_id and r.id = s.run_id");
    expect(sql).toContain("a.tenant_id = r.tenant_id and a.id = r.automation_id");
    expect(sql).toContain("r.automation_id = $2 and s.step_key = $3");
    expect(sql).toContain("s.type = 'split' and s.state = 'done'");
    expect(sql).toContain("s.data->>'variant' as key");
    expect(sql).toContain("s.run_id = e.automation_run_id");
    expect(sql).toContain("e.tenant_id = $1 and e.id = ev.email_id and e.automation_id = $2");
    expect(sql).toContain("select unnest($6::text[]) as key");
    expect(sql).toContain("union select key from assignments");
    expect(sql).not.toContain("tags");
  });

  it("uses separate half-open dates, deduplicates decisions, and aggregates events before assignment joins", async () => {
    const { db, query } = mockDb();
    await splitMetrics(db, "tenant_1", input, variants);
    const sql = query.mock.calls[0]![0];
    const assignments = sql.slice(sql.indexOf("with assignments"), sql.indexOf("), run_counts"));
    expect(assignments).toContain("select distinct on (s.run_id)");
    expect(assignments).toContain("order by s.run_id, s.created_at, s.id");
    expect(assignments).not.toContain(">= $4");
    expect(sql).toContain("where created_at >= $4 and created_at < $5");
    expect(sql).toContain("ev.created_at >= $4 and ev.created_at < $5");
    expect(sql).not.toContain("e.created_at >= $4");
    expect(sql).toContain("e.created_at >= s.created_at");
    const events = sql.slice(sql.indexOf("), event_counts"), sql.indexOf("), email_counts"));
    expect(events).toContain("group by ev.email_id");
    expect(events).toContain("count(distinct ev.email_id) filter (where ev.type = 'email.opened')");
    expect(events).toContain("count(distinct ev.email_id) filter (where ev.type = 'email.clicked')");
    expect(events).not.toContain("join assignments");
    expect(sql).toContain("sum(ev.unique_opened)");
    expect(sql).toContain("sum(ev.unique_clicked)");
  });

  it("preserves explicit event sandbox attribution and historical recipient fallback", async () => {
    const { db, query } = mockDb();
    await splitMetrics(db, "tenant_1", input, variants);
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("case when ev.data->>'sandbox' in ('true', 'false')");
    expect(sql).toContain("then ev.data->>'sandbox' = 'false'");
    expect(sql).toContain("else not coalesce(e.sandbox, false)");
    expect(sql).toContain("r.tenant_id = ev.tenant_id and r.id = ev.recipient_id and r.sandbox");
  });

  it("returns zeros for an empty result and rejects invalid dates/config before querying", async () => {
    const { db, query } = mockDb();
    const report = await splitMetrics(db, "tenant_1", input, variants);
    expect(report.data).toHaveLength(2);
    expect(report.data.every((row) => row.runs === 0 && row.sent === 0 && row.open_rate === 0)).toBe(true);
    query.mockClear();
    for (const invalid of [
      { ...input, start: new Date("invalid") },
      { ...input, end: new Date("invalid") },
      { ...input, start: input.end },
      { ...input, end: input.start },
      { ...input, automationId: "" },
      { ...input, stepKey: " " },
    ]) await expect(splitMetrics(db, "tenant_1", invalid, variants)).rejects.toThrow();
    await expect(splitMetrics(db, "tenant_1", input, [{ ...variants[0], weight: 100 }])).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
