import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "./index.js";
import { assertTriggerConfig, contactDiff, dispatchContactWrite, matchesTrigger } from "./contact-triggers.js";

const contact = { id: "contact_1", email: "ada@example.com", first_name: "Ada", last_name: null,
  properties: { active: false, count: 0, plan: "free" }, unsubscribed_at: null, created_at: "2026-10-04", updated_at: "2026-10-04" };

describe("contact transitions", () => {
  it("ignores timestamps and object key order but preserves actual primitive types", () => {
    expect(contactDiff(contact, { ...contact, updated_at: "later", properties: { plan: "free", count: 0, active: false } })).toEqual([]);
    expect(contactDiff(contact, { ...contact, properties: { active: true, count: "0", plan: "pro" } })).toEqual([
      { field: "active", from: false, to: true }, { field: "count", from: 0, to: "0" }, { field: "plan", from: "free", to: "pro" }
    ]);
  });
  it("matches only exact from/to types, including false, zero, and explicit null", () => {
    const changes = [{ field: "active", from: false, to: true }, { field: "count", from: null, to: 0 }];
    expect(matchesTrigger({ type: "contact_updated", field: "active", from: false, to: true }, changes)).toBe(true);
    expect(matchesTrigger({ type: "contact_updated", field: "active", from: "false" }, changes)).toBe(false);
    expect(matchesTrigger({ type: "contact_updated", field: "count", from: null, to: 0 }, changes)).toBe(true);
    expect(matchesTrigger({ type: "contact_updated" }, [])).toBe(false);
  });
  it("records every field once without an internal event when nothing matches", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await dispatchContactWrite({ query } as unknown as Queryable, "tenant_1", "req_1", contact, {
      ...contact, first_name: "Grace", properties: { active: true, count: 0, plan: "pro" }
    });
    expect(query.mock.calls.filter(([sql]) => sql.includes("insert into contact_changes"))).toHaveLength(3);
    expect(query.mock.calls.some(([sql]) => sql.includes("custom_events"))).toBe(false);
    expect(query.mock.calls.find(([sql]) => sql.includes("from automations"))![1]).toEqual(["tenant_1", "contact_updated", "@contact.updated"]);
  });
  it("validates field declarations and typed filters, and refuses dynamic trigger segments", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ key: "active", type: "boolean" }] }) } as unknown as Queryable;
    await expect(assertTriggerConfig(db, "tenant", { type: "contact_updated", field: "active", to: false })).resolves.toBeUndefined();
    await expect(assertTriggerConfig(db, "tenant", { type: "contact_updated", field: "active", to: "false" })).rejects.toThrow("must be a boolean");
    await expect(assertTriggerConfig(db, "tenant", { type: "contact_updated", field: "unknown" })).rejects.toThrow("declared");
    (db.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ type: "dynamic" }] });
    await expect(assertTriggerConfig(db, "tenant", { type: "segment_added", segment_id: "dynamic" })).rejects.toThrow("static segment");
  });
});
