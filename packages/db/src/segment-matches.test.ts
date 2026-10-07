import { describe, expect, it, vi } from "vitest";
import type { Rule } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { contactSegments, segmentMatch } from "./segment-matches.js";

describe("saved segment matching", () => {
  function database() {
    const damaged: Rule = { type: "or", rules: [
      { type: "rule", field: "contact.email", operator: "exists" },
      { type: "and", rules: [{ type: "rule", field: "contact.plan", operator: "eq", value: "pro" }] },
    ] };
    const valid: Rule = { type: "rule", field: "contact.email", operator: "exists" };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("select id from segments")) return { rows: [{ id: "damaged" }, { id: "valid" }] };
      if (sql.startsWith("select rule")) return { rows: [{ rule: params?.[1] === "damaged" ? damaged : valid }] };
      if (sql.includes("from contact_properties")) return { rows: [] };
      if (sql.startsWith("select s.id")) return { rows: [{ id: "static" }, { id: "valid" }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    return { db: { query } as unknown as Queryable, query };
  }

  it("keeps a damaged whole filter false without losing valid dynamic or static matches", async () => {
    const { db, query } = database();
    const values: unknown[] = [];
    const match = await segmentMatch(db, "tenant", (value) => { values.push(value); return `$${values.length + 2}`; });
    expect(match).toContain("s.id = $3::text and (false)");
    expect(match).toContain("s.id = $4::text and ((coalesce(to_jsonb(c.email)");
    expect(match).toContain("s.rule is null and exists");
    expect(match).toContain("sc.tenant_id = c.tenant_id and sc.segment_id = s.id and sc.contact_id = c.id");
    expect(values).toEqual(["damaged", "valid"]);
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("uses the same false resolution in contact segment context with caller-owned numbering", async () => {
    const { db, query } = database();
    expect(await contactSegments(db, "tenant", "contact")).toEqual(["static", "valid"]);
    const [sql, params] = query.mock.calls.at(-1)!;
    expect(sql).toContain("s.id = $3::text and (false)");
    expect(sql).toContain("s.id = $4::text and ((coalesce(to_jsonb(c.email)");
    expect(sql).toContain("c.id = $2 and c.deleted_at is null");
    expect(params).toEqual(["tenant", "contact", "damaged", "valid"]);
  });
});
