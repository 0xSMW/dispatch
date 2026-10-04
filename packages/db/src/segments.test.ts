import { describe, expect, it } from "vitest";
import { ApiError, evaluate, operatorsForType, type Operator, type Rule } from "@dispatchmail/core";
import { segmentPredicate, type SegmentProperty } from "./segments.js";

const properties: SegmentProperty[] = [
  { key: "plan", type: "string" }, { key: "score", type: "number" },
  { key: "activated", type: "boolean" }, { key: "active_at", type: "date" },
];
const leaf = (field: string, operator: Operator = "eq", value?: unknown): Rule =>
  ({ type: "rule", field, operator, ...(value === undefined ? {} : { value }) });
function compile(rule: Rule, metadata = properties, offset = 0) {
  const values: unknown[] = [];
  const sql = segmentPredicate(rule, (value) => {
    values.push(value);
    return `$${values.length + offset}`;
  }, metadata);
  return { sql, values };
}

describe("segmentPredicate", () => {
  it("is pure and uses caller-supplied placeholder numbering", () => {
    const rule = leaf("contact.plan", "eq", "pro");
    expect(compile(rule, properties, 2)).toEqual({
      sql: "((c.properties -> $3::text) is not distinct from $4::jsonb)",
      values: ["plan", '"pro"'],
    });
    expect(rule).toEqual(leaf("contact.plan", "eq", "pro"));
    expect(properties[0]).toEqual({ key: "plan", type: "string" });
  });

  for (const [key, type, value] of [
    ["plan", "string", "pro"], ["score", "number", 42],
    ["activated", "boolean", false], ["active_at", "date", "2026-10-04"],
  ] as const) {
    for (const operator of operatorsForType(type)) {
      it(`compiles declared ${type} ${operator} with bound operands`, () => {
        const window = operator === "within" || operator === "not_within";
        const unary = operator === "exists" || operator === "is_empty";
        const result = compile(leaf(`contact.${key}`, operator, window ? "30 days" : unary ? undefined : value));
        expect(result.values[0]).toBe(key);
        expect(result.sql).toContain("$1::text");
        expect(result.sql).not.toContain(`'${key}'`);
        if (unary) expect(result.values).toEqual([key]);
        else {
          expect(result.values).toHaveLength(2);
          expect(result.sql).toContain("$2");
          expect(result.values[1]).toEqual(window ? 30 * 86400
            : operator === "eq" || operator === "neq" ? JSON.stringify(value)
            : type === "date" ? Date.parse(value as string) : value);
        }
      });
    }
  }

  it.each([
    ["email", "c.email", "hello@example.test"],
    ["first_name", "c.first_name", "Ada"],
    ["last_name", "c.last_name", "Lovelace"],
    ["created_at", "c.created_at", "2026-10-04T00:00:00.000Z"],
    ["unsubscribed", "c.unsubscribed_at is not null", true],
  ])("compiles built-in %s without looking up a property", (key, expression, value) => {
    const result = compile(leaf(`contact.${key}`, "eq", value), []);
    expect(result.sql).toContain(expression);
    expect(result.values).toEqual([JSON.stringify(value)]);
    expect(result.sql).not.toContain("c.properties");
  });

  it("built-ins override declarations with the same key", () => {
    expect(compile(leaf("contact.email", "eq", "a"), [{ key: "email", type: "number" }]).sql).toContain("c.email");
    expect(() => compile(leaf("contact.unsubscribed", "eq", "false"), [{ key: "unsubscribed", type: "string" }])).toThrow(ApiError);
  });

  it("preserves nested AND/OR order and binds without hidden contact loads", () => {
    const result = compile({ type: "and", rules: [
      leaf("contact.plan", "eq", "free"),
      { type: "or", rules: [leaf("contact.activated", "eq", false), leaf("contact.score", "gt", 3)] },
    ] });
    expect(result.sql).toMatch(/^\(.+ and \(.+ or .+\)\)$/s);
    expect(result.values).toEqual(["plan", '"free"', "activated", "false", "score", 3]);
    expect(result.sql).not.toMatch(/from contacts|select \*/i);
  });

  it("binds malicious keys and values, including quotes and wildcards", () => {
    const key = "plan')::text; drop table contacts; --";
    const value = "%_'); select pg_sleep(100); --";
    const result = compile(leaf(`contact.${key}`, "contains", value), [{ key, type: "string" }]);
    expect(result.values).toEqual([key, value]);
    expect(result.sql).not.toContain(key);
    expect(result.sql).not.toContain(value);
    expect(result.sql).toContain("strpos(");
    expect(result.sql).not.toMatch(/\blike\b/i);
  });

  it.each(["email.sent", "email.clicked", "event.plan", "event.received_at", "plan", "contact.id", "contact.properties.plan", "contact.unknown", "contact.__proto__"])(
    "refuses unsupported field %s before binding", (field) => {
      const values: unknown[] = [];
      expect(() => segmentPredicate(leaf(field), (value) => { values.push(value); return "$1"; }, properties)).toThrow(ApiError);
      expect(values).toEqual([]);
    },
  );

  it.each([
    leaf("contact.plan", "gt", "pro"), leaf("contact.score", "contains", "1"),
    leaf("contact.activated", "within", "30 days"), leaf("contact.topics", "eq", "topic_a"),
    leaf("contact.active_at", "starts_with", "2026"),
    leaf("contact.plan", "eq", 3), leaf("contact.score", "eq", "3"),
    leaf("contact.score", "gte", Infinity), leaf("contact.score", "lte", NaN),
    leaf("contact.activated", "eq", "true"), leaf("contact.active_at", "gt", "2026-02-30"),
    leaf("contact.active_at", "within", "-1 day"), leaf("contact.active_at", "within", "0 seconds"),
    leaf("contact.active_at", "within", "banana"), leaf("contact.topics", "contains", 1),
  ])("refuses invalid typed operator/value: %j", (rule) => {
    expect(() => compile(rule)).toThrow(ApiError);
  });

  it.each([
    { type: "rule", field: "contact.plan", operator: "in", value: ["pro"] },
    { type: "xor", rules: [leaf("contact.plan")] },
    { type: "and", rules: [] }, { type: "or", rules: "no" }, null,
  ])("refuses malformed shared grammar: %j", (rule) => {
    expect(() => compile(rule as Rule)).toThrow(ApiError);
  });

  it("validates all leaves before calling bind", () => {
    let binds = 0;
    expect(() => segmentPredicate({ type: "and", rules: [leaf("contact.plan", "eq", "pro"), leaf("contact.nope")] },
      () => { binds++; return "$1"; }, properties)).toThrow(ApiError);
    expect(binds).toBe(0);
  });

  it.each([
    [[{ key: "plan", type: "object" }]],
    [[{ key: "", type: "number" }]],
    [[{ key: "plan", type: "number" }, { key: "plan", type: "string" }]],
  ])("refuses invalid explicit metadata: %j", (metadata) => {
    expect(() => compile(leaf("contact.email", "eq", "a"), metadata as SegmentProperty[])).toThrow(ApiError);
  });

  it("does not share mutable metadata between compilations", () => {
    expect(() => compile(leaf("contact.score", "gt", 1), [])).toThrow("Unknown segment field");
    expect(compile(leaf("contact.score", "gt", 1)).values).toEqual(["score", 1]);
  });

  it("uses shape and bounded numeric cast guards in ordered number expressions", () => {
    const result = compile(leaf("contact.score", "gt", 1));
    expect(result.sql).toContain("case when jsonb_typeof(");
    expect(result.sql).toContain("in ('number', 'string')");
    expect(result.sql).toContain("btrim(");
    expect(result.sql).toContain("length(");
    expect(result.sql).toContain("<= 400");
    expect(result.sql).toContain("{1,3}");
    expect(result.sql).toContain("::numeric end");
    expect(result.sql).toContain("between -1.7976931348623157e308");
    expect(result.sql).toContain("coalesce(");
    // evaluate() also orders finite legacy decimal strings, unlike strict eq.
    expect(evaluate(leaf("contact.score", "gt", 1), { contact: { score: " 2 " } })).toBe(true);
    expect(evaluate(leaf("contact.score", "eq", 2), { contact: { score: "2" } })).toBe(false);
  });

  it("guards legacy dates by calendar/time/zone shape without a direct text timestamp cast", () => {
    const result = compile(leaf("contact.active_at", "gte", "2024-02-29T12:30:05.123456+02:00"));
    expect(result.sql).toContain("jsonb_typeof(");
    expect(result.sql).toContain("= 'string'");
    expect(result.sql).toContain("% 400 = 0");
    expect(result.sql).toContain("then 29 else 28");
    expect(result.sql).toContain("make_date(");
    expect(result.sql).toContain("at time zone 'UTC'");
    expect(result.sql).toContain("left(substring(");
    expect(result.sql).not.toMatch(/#>> '\{\}'\)\s*::(?:date|timestamp)/);
    expect(result.values).toEqual(["active_at", Date.parse("2024-02-29T12:30:05.123456+02:00")]);
  });

  it.each(["within", "not_within"] as const)("uses inclusive %s windows and refuses missing dates rather than negating NULL", (operator) => {
    const result = compile(leaf("contact.active_at", operator, "2 hours"));
    expect(result.values).toEqual(["active_at", 7200]);
    expect(result.sql).toContain("statement_timestamp()");
    expect(result.sql).toContain("between");
    expect(result.sql).toContain("$2::numeric * 1000");
    expect(result.sql).toMatch(/, false\)$/);
    if (operator === "not_within") expect(result.sql).toContain("not ");
    // Shared grammar semantics, not an execution of the emitted SQL.
    expect(evaluate(leaf("contact.active_at", operator, "2 hours"), { contact: {} })).toBe(false);
  });

  it("distinguishes missing from explicit JSON null for equality and uses null-safe inequality", () => {
    expect(compile(leaf("contact.plan", "eq")).sql).toContain("is not distinct from null::jsonb");
    expect(compile(leaf("contact.plan", "eq")).values).toEqual(["plan"]);
    expect(compile(leaf("contact.plan", "eq", null)).values).toEqual(["plan", "null"]);
    expect(compile(leaf("contact.plan", "neq", "pro")).sql).toContain("is distinct from $2::jsonb");
    expect(compile(leaf("contact.first_name", "eq", null)).sql).toContain("coalesce(to_jsonb(c.first_name), 'null'::jsonb)");
  });

  it("matches unary null/empty shapes without casting and preserves legacy string coercion", () => {
    const empty = compile(leaf("contact.score", "is_empty"));
    expect(empty.sql).toContain("'null'::jsonb, '\"\"'::jsonb, '[]'::jsonb");
    expect(empty.sql).not.toContain("::numeric");
    const exists = compile(leaf("contact.activated", "exists"));
    expect(exists.sql).toContain("is not null");
    expect(exists.sql).toContain("<> 'null'::jsonb");
    const substring = compile(leaf("contact.plan", "contains", "pro"));
    expect(substring.sql).toContain("with recursive parts");
    expect(substring.sql).toContain("'[object Object]'");
    expect(substring.sql).toContain("jsonb_build_array($2::text)");
    expect(substring.sql).toContain("case when jsonb_typeof(parts.value) = 'array'");
  });

  it.each(["topics", "segments"] as const)("binds contact.%s IDs with tenant/contact-scoped correlated membership", (key) => {
    const result = compile(leaf(`contact.${key}`, "contains", "id'); --"));
    expect(result.values).toEqual([key, "id'); --", "id'); --"]);
    expect(result.sql).not.toContain("id'); --");
    expect(result.sql).toContain("s.tenant_id = c.tenant_id".replace("s.", key === "topics" ? "t." : "s."));
    expect(result.sql).toContain(key === "topics" ? "s.contact_id = c.id" : "m.contact_id = c.id");
    expect(result.sql).toContain(key === "topics" ? "s.tenant_id = t.tenant_id" : "m.tenant_id = s.tenant_id");
    expect(result.sql).toContain("deleted_at is null");
    expect(result.sql).toContain("$3::text");
    expect(result.sql).toContain("case when c.properties ? $1::text");
  });

  it("topics apply default status, explicit opt-outs and global eligibility in the same predicate", () => {
    const result = compile(leaf("contact.topics", "contains", "newsletter"));
    expect(result.sql).toContain("left join topic_subscriptions");
    expect(result.sql).toContain("coalesce(s.status, t.default_status) = 'subscribed'");
    expect(result.sql).toContain("c.unsubscribed_at is null and exists");
    expect(result.sql).toContain("s.topic_id = t.id");
    expect(result.sql).toContain("t.id = $3::text");
  });

  it("static membership excludes deleted/dynamic segments without requiring future schema columns", () => {
    const result = compile(leaf("contact.segments", "contains", "customers"));
    expect(result.sql).toContain("to_jsonb(s)->>'rule' is null");
    expect(result.sql).toContain("coalesce(to_jsonb(s)->>'type', 'static') = 'static'");
    expect(result.sql).toContain("m.segment_id = s.id");
    expect(result.sql).not.toContain("c.unsubscribed_at");
  });

  it.each(["topics", "segments"] as const)("supports all set operators on %s, with own-property override", (key) => {
    const negative = compile(leaf(`contact.${key}`, "not_contains", "id"));
    expect(negative.sql).toContain("else (not ");
    const empty = compile(leaf(`contact.${key}`, "is_empty"));
    expect(empty.values).toEqual([key]);
    expect(empty.sql).toContain("else (not ");
    const exists = compile(leaf(`contact.${key}`, "exists"));
    expect(exists.values).toEqual([key]);
    expect(exists.sql).toContain("else true end)");
    expect(exists.sql).toContain("c.properties ? $1::text");
  });

  it("declared legacy reserved properties keep metadata operators and fall back to set context when absent", () => {
    const metadata: SegmentProperty[] = [{ key: "topics", type: "string" }, { key: "segments", type: "number" }];
    expect(compile(leaf("contact.topics", "eq", "custom"), metadata).sql).toContain("else false end)");
    expect(compile(leaf("contact.topics", "neq", "custom"), metadata).sql).toContain("else true end)");
    expect(compile(leaf("contact.topics", "contains", "topic"), metadata).sql).toContain("from topics t");
    expect(compile(leaf("contact.segments", "gte", 1), metadata).sql).toContain("else false end)");
    expect(() => compile(leaf("contact.segments", "contains", "id"), metadata)).toThrow(ApiError);
  });

  it("allows exactly five levels, but refuses the sixth and cyclic inputs before recursion", () => {
    let rule = leaf("contact.email", "eq", "a");
    for (let i = 0; i < 4; i++) rule = { type: "and", rules: [rule] };
    expect(compile(rule).values).toEqual(['"a"']);
    expect(() => compile({ type: "or", rules: [rule] })).toThrow("at most 5 levels");
    const cyclic: Rule = { type: "and", rules: [] };
    cyclic.rules.push(cyclic);
    expect(() => compile(cyclic)).toThrow("at most 5 levels");
  });

  it("allows exactly twenty conditions but refuses twenty-one across separate branches", () => {
    const leaves = Array.from({ length: 10 }, () => leaf("contact.email", "exists"));
    expect(compile({ type: "or", rules: [{ type: "and", rules: leaves }, { type: "and", rules: leaves }] }).values).toEqual([]);
    expect(() => compile({ type: "and", rules: [
      { type: "or", rules: leaves }, { type: "and", rules: leaves }, leaf("contact.email", "exists"),
    ] })).toThrow("at most 20 conditions");
    expect(() => compile({ type: "and", rules: [...leaves, ...leaves, leaf("contact.email")] })).toThrow("at most 20 conditions");
  });
});
