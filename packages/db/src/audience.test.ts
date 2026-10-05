import { describe, expect, it, vi } from "vitest";
import { ApiError, type PropertyType } from "@dispatchmail/core";
import {
  addContactSegment,
  addSuppressions,
  assertPropertyValues,
  createProperty,
  deleteContact,
  findContact,
  mergeProperties,
  presentContact,
  presentSegment,
  presentSuppression,
  presentTopic,
  removeSuppressions,
  setContactTopics,
  topicDefaultStatus,
  updateProperty,
  wrapProperties,
} from "./audience.js";

function client(handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return handler(sql, params);
    }),
  };
}

const contact = {
  id: "contact_1",
  email: "ada@example.com",
  first_name: "Ada",
  last_name: null,
  properties: { company: "Acme", seats: 3 },
  unsubscribed_at: "2026-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("audience presenters", () => {
  it("wraps defined properties and infers a type for the rest", () => {
    expect(wrapProperties(contact.properties, [{ key: "company", type: "string" }])).toEqual({
      company: { value: "Acme", type: "string" },
      seats: { value: 3, type: "number" },
    });
  });

  it("presents unsubscribed as a boolean and deletes with the contact key", () => {
    expect(presentContact(contact, [{ key: "company", type: "string" }]).unsubscribed).toBe(true);
    expect(presentContact({ ...contact, unsubscribed_at: null }).unsubscribed).toBe(false);
  });

  it("merges properties and drops keys set to null", () => {
    expect(mergeProperties({ company: "Acme", plan: "pro" }, { plan: null, city: "London" })).toEqual({
      company: "Acme",
      city: "London",
    });
  });

  it("rejects a defined property of the wrong type and keeps unknown keys", () => {
    const definitions = [{ key: "seats", type: "number" }];
    expect(() => assertPropertyValues({ seats: "three" }, definitions)).toThrow(ApiError);
    expect(() => assertPropertyValues({ seats: null, note: "ok" }, definitions)).not.toThrow();
  });

  it("validates four declared types without restricting undeclared or legacy keys", () => {
    const definitions = [
      { key: "plan", type: "string" }, { key: "seats", type: "number" },
      { key: "activated", type: "boolean" }, { key: "last_active_at", type: "date" },
    ];
    const properties = { plan: "free", seats: 0, activated: false, last_active_at: "2026-10-03T09:30:00+02:00", topics: ["legacy"], note: { arbitrary: true } };
    expect(() => assertPropertyValues(properties, definitions)).not.toThrow();
    expect(properties.last_active_at).toBe("2026-10-03T09:30:00+02:00");
    for (const patch of [{ plan: 1 }, { seats: "1" }, { seats: Infinity }, { activated: "false" }, { activated: 0 }, { last_active_at: "2026-02-30" }, { last_active_at: "2026-10-03T09:30:00" }, { last_active_at: 1 }]) {
      expect(() => assertPropertyValues(patch, definitions)).toThrow(ApiError);
    }
    expect(() => assertPropertyValues({ activated: null, last_active_at: null }, definitions)).not.toThrow();
    expect(wrapProperties({ activated: false, last_active_at: "2026-10-03", undeclared_flag: true }, definitions)).toEqual({
      activated: { value: false, type: "boolean" },
      last_active_at: { value: "2026-10-03", type: "date" },
      undeclared_flag: { value: true, type: "boolean" },
    });
    expect(() => assertPropertyValues({ topics: "legacy" }, [{ key: "topics", type: "string" }])).not.toThrow();
  });

  it("maps topic defaults and omits a segment description", () => {
    expect(topicDefaultStatus({ default_subscription: "opt_out" })).toBe("unsubscribed");
    expect(topicDefaultStatus({ default_status: "subscribed" })).toBe("subscribed");
    const topic = presentTopic({
      id: "topic_1",
      name: "News",
      key: "news",
      description: "Weekly",
      visibility: "public",
      default_status: "unsubscribed",
      created_at: contact.created_at,
      updated_at: contact.updated_at,
    });
    expect(topic.default_subscription).toBe("opt_out");
    expect(presentSegment({ id: "segment_1", name: "Early", created_at: contact.created_at, updated_at: contact.updated_at }))
      .toMatchObject({ description: null, type: "static", rule: null });
  });

  it("maps a manual bounce reason onto origin", () => {
    expect(presentSuppression({ id: "supp_1", email: "a@example.com", reason: "email.bounced", origin: "manual", created_at: contact.created_at }).origin).toBe("bounce");
  });
});

describe("audience queries", () => {
  it("looks up a contact by email when the ref contains @", async () => {
    const db = client(() => ({ rows: [contact] }));
    await findContact(db, "tenant_1", "Ada@Example.com");
    expect(db.queries[0].sql).toContain("lower(email) = $2");
    expect(db.queries[0].params).toEqual(["tenant_1", "ada@example.com"]);
  });

  it("locks the full contact snapshot when a caller is about to write", async () => {
    const db = client(() => ({ rows: [contact] }));
    expect(await findContact(db, "tenant_1", "contact_1", true)).toEqual(contact);
    expect(db.queries[0]!.sql).toContain("properties, unsubscribed_at, created_at, updated_at");
    expect(db.queries[0]!.sql).toContain("limit 1 for update");
    expect(db.queries[0]!.params).toEqual(["tenant_1", "contact_1"]);
  });

  it.each([
    ["unsubscribed", "opt_in", "subscribed"],
    ["subscribed", "opt_out", "unsubscribed"],
    ["subscribed", "opt_in", "subscribed"],
  ])("returns exact topic transition metadata (%s to %s)", async (before, subscription, after) => {
    const row = { id: "sub_1", topic_id: "topic_1", contact_id: "contact_1", status: after };
    const db = client((sql) => ({ rows: sql.startsWith("select") ? [{ id: "topic_1", before }] : [row] }));
    expect(await setContactTopics(db, "tenant_1", "contact_1", [{ id: "topic_1", subscription }])).toEqual([
      { topic_id: "topic_1", before, after, status: after, row },
    ]);
    expect(db.queries[0]!.sql).toContain("coalesce(s.status, t.default_status) as before");
    expect(db.queries[0]!.params).toEqual(["tenant_1", "topic_1", "contact_1"]);
    expect(db.queries[1]!.params.slice(1)).toEqual(["tenant_1", "topic_1", "contact_1", after]);
  });

  it("writes only the final repeated topic preference and reports one transition", async () => {
    const db = client((sql) => ({
      rows: sql.startsWith("select")
        ? [{ id: "topic_1", before: "unsubscribed" }]
        : [{ id: "sub_1", topic_id: "topic_1", status: "subscribed" }],
    }));
    const saved = await setContactTopics(db, "tenant_1", "contact_1", [
      { id: "topic_1", subscription: "opt_out" }, { id: "topic_1", subscription: "opt_in" },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ before: "unsubscribed", after: "subscribed" });
    expect(db.queries).toHaveLength(2);
    expect(db.queries[1]!.params[4]).toBe("subscribed");
  });

  it("does not write a preference for a missing topic", async () => {
    const db = client(() => ({ rows: [] }));
    await expect(setContactTopics(db, "tenant_1", "contact_1", [{ id: "topic_missing", subscription: "opt_in" }])).rejects.toMatchObject({ name: "not_found" });
    expect(db.queries).toHaveLength(1);
  });

  it.each([true, false])("distinguishes an added segment member from an existing one (added=%s)", async (added) => {
    const row = { id: "member_1", segment_id: "segment_1", contact_id: "contact_1", created_at: contact.created_at };
    const db = client((sql) => {
      if (sql.includes("from segments")) return { rows: [{ id: "segment_1", type: "static" }] };
      if (sql.startsWith("insert")) return { rows: added ? [row] : [] };
      return { rows: [row] };
    });
    expect(await addContactSegment(db, "tenant_1", "contact_1", "segment_1")).toEqual({ ...row, added });
    expect(db.queries[1]!.sql).toContain("on conflict (tenant_id, segment_id, contact_id) do nothing");
    expect(db.queries).toHaveLength(added ? 2 : 3);
    if (!added) expect(db.queries[2]!.params).toEqual(["tenant_1", "segment_1", "contact_1"]);
  });

  it("refuses membership writes to dynamic segments before touching members", async () => {
    const db = client(() => ({ rows: [{ id: "segment_1", rule: { type: "rule", field: "contact.email", operator: "exists" } }] }));
    await expect(addContactSegment(db, "tenant_1", "contact_1", "segment_1")).rejects.toMatchObject({ name: "conflict", statusCode: 409 });
    expect(db.queries).toHaveLength(1);
  });

  it("clears once-only enrollments when deleting a contact without clearing topic opt-outs", async () => {
    const db = client((sql) => ({ rows: sql.startsWith("update") ? [{ id: "contact_1" }] : [] }));
    expect(await deleteContact(db, "tenant_1", "contact_1")).toBe(true);
    expect(db.queries.map(({ params }) => params)).toEqual(Array.from({ length: 4 }, () => ["tenant_1", "contact_1"]));
    expect(db.queries[2]!.sql).toContain("status = 'subscribed'");
    expect(db.queries[3]!.sql).toBe("delete from automation_enrollments where tenant_id = $1 and contact_id = $2");
  });

  it("refuses to change the type of a live property and updates the fallback when the type matches", async () => {
    const mismatch = client(() => ({ rows: [{ id: "prop_1", type: "string", deleted_at: null }] }));
    await expect(createProperty(mismatch, "tenant_1", { key: "plan", type: "number", fallback_value: 1 })).rejects.toMatchObject({
      name: "validation_error",
    });

    const match = client((sql) => {
      if (sql.startsWith("select")) return { rows: [{ id: "prop_1", type: "string", deleted_at: null }] };
      return { rows: [{ id: "prop_1", key: "plan", type: "string", fallback_value: "pro" }] };
    });
    await createProperty(match, "tenant_1", { key: "plan", type: "string", fallback_value: "pro" });
    expect(match.queries[1].sql).toContain("fallback_value = $3");
    expect(match.queries[1].sql).not.toContain("type =");
  });

  it.each([
    ["string", "free", 1],
    ["number", 0, "0"],
    ["boolean", false, "false"],
    ["date", "2026-10-03T09:30:00+02:00", "2026-02-30"],
  ] as Array<[PropertyType, string | number | boolean, string | number]>)
  ("validates %s fallbacks on create and update before writing", async (type, valid, invalid) => {
    const inserted = client((sql) => ({ rows: sql.startsWith("select") ? [] : [{ id: "prop_1", key: "value", type, fallback_value: valid }] }));
    await createProperty(inserted, "tenant_1", { key: "value", type, fallback_value: valid });
    expect(inserted.queries[1].params[4]).toBe(JSON.stringify(valid));
    const badCreate = client(() => ({ rows: [] }));
    await expect(createProperty(badCreate, "tenant_1", { key: "value", type, fallback_value: invalid })).rejects.toMatchObject({ name: "validation_error" });
    expect(badCreate.queries).toHaveLength(1);

    const updated = client((sql) => ({ rows: sql.startsWith("select") ? [{ key: "value", type }] : [{ id: "prop_1", key: "value", type, fallback_value: valid }] }));
    await updateProperty(updated, "tenant_1", "prop_1", valid);
    expect(updated.queries[0].params).toEqual(["tenant_1", "prop_1"]);
    expect(updated.queries[1].params[2]).toBe(JSON.stringify(valid));
    await updateProperty(updated, "tenant_1", "prop_1", null);
    expect(updated.queries[3].params[2]).toBe("null");
    const badUpdate = client(() => ({ rows: [{ key: "value", type }] }));
    await expect(updateProperty(badUpdate, "tenant_1", "prop_1", invalid)).rejects.toMatchObject({ name: "validation_error" });
    expect(badUpdate.queries).toHaveLength(1);
  });

  it.each(["topics", "segments"])("refuses new %s definitions but permits live legacy updates", async (key) => {
    for (const rows of [[], [{ id: "prop_1", type: "string", deleted_at: "2026-10-01" }]]) {
      const db = client(() => ({ rows }));
      await expect(createProperty(db, "tenant_1", { key, type: "string", fallback_value: "legacy" })).rejects.toMatchObject({ name: "validation_error" });
      expect(db.queries).toHaveLength(1);
    }
    const db = client((sql) => ({ rows: sql.startsWith("select") ? [{ id: "prop_1", key, type: "string", deleted_at: null }] : [{ id: "prop_1", key, type: "string", fallback_value: "legacy" }] }));
    await expect(createProperty(db, "tenant_1", { key, type: "string", fallback_value: "legacy" })).resolves.toMatchObject({ key });
    await expect(updateProperty(db, "tenant_1", "prop_1", "legacy")).resolves.toMatchObject({ key });
  });

  it("returns not_found rather than writing when a property does not exist", async () => {
    const db = client(() => ({ rows: [] }));
    await expect(updateProperty(db, "tenant_1", "prop_missing", false)).rejects.toMatchObject({ name: "not_found" });
    expect(db.queries).toHaveLength(1);
  });

  it("adds and removes suppressions in one statement", async () => {
    const db = client(() => ({ rows: [{ id: "supp_1", email: "a@example.com", reason: "manual", origin: "manual", source_id: null, created_at: contact.created_at }] }));
    await addSuppressions(db, "tenant_1", ["a@example.com", "a@example.com"]);
    expect(db.queries[0].sql).toContain("unnest");
    expect(db.queries[0].params[1]).toEqual(["a@example.com"]);
    await removeSuppressions(db, "tenant_1", { ids: ["supp_1"] });
    expect(db.queries[1].sql).toContain("id = any");
    await removeSuppressions(db, "tenant_1", { emails: ["a@example.com"] });
    expect(db.queries[2].sql).toContain("lower(email) = any");
  });
});
