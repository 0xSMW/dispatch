import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@dispatchmail/core";
import {
  addSuppressions,
  assertPropertyValues,
  createProperty,
  findContact,
  mergeProperties,
  presentContact,
  presentSegment,
  presentSuppression,
  presentTopic,
  removeSuppressions,
  topicDefaultStatus,
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
    expect(presentSegment({ id: "segment_1", name: "Early", created_at: contact.created_at, updated_at: contact.updated_at })).not.toHaveProperty("description");
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
