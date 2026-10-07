import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "./index.js";
import {
  assertTriggerConfig, contactDiff, dispatchContactWrite, dispatchSegmentAdded, dispatchTopicChanges,
  fireContactTrigger, matchesTrigger, startRuns, type FiredEvent, type TriggerOptions,
} from "./contact-triggers.js";

const contact = { id: "contact_1", email: "ada@example.com", first_name: "Ada", last_name: null,
  properties: { active: false, count: 0, plan: "free" }, unsubscribed_at: null, created_at: "2026-10-04", updated_at: "2026-10-04" };
const event: FiredEvent = { id: "ce_1", request_id: "req_1", name: "@contact.created", email: contact.email, data: {}, created_at: "2026-10-04" };

function triggerClient(options: { reentry?: "once" | "every_time"; enrolled?: boolean; segmentType?: string } = {}) {
  const enrollments = new Set(options.enrolled ? [contact.id] : []);
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (sql.includes("from automations")) {
      const type = String(params[1]);
      const key = String(params[2]);
      const config = type === "event" ? { type, event_name: key }
        : type === "topic_subscribed" ? { type, topic_id: key.split(":")[1] }
        : type === "segment_added" ? { type, segment_id: key.split(":")[1] } : { type };
      return { rows: [{ id: "automation_1", trigger: key, trigger_type: type, reentry: options.reentry ?? "once",
        steps: [{ key: "start", type: "trigger", config }], connections: [] }] };
    }
    if (sql.includes("insert into automation_enrollments")) {
      const contactId = String(params[2]);
      if (enrollments.has(contactId)) return { rows: [] };
      enrollments.add(contactId);
      return { rows: [{ contact_id: contactId }] };
    }
    if (sql.includes("insert into custom_events")) return { rows: [{
      ...event, id: params[0], request_id: params[2], name: params[3], email: params[4], data: JSON.parse(params[5] as string),
    }] };
    if (sql.includes("insert into automation_runs")) return { rows: [{ id: params[0] }] };
    if (sql.includes("select id from topics")) return { rows: [{ id: params[1] }] };
    if (sql.includes("as type from segments")) return { rows: [{ type: options.segmentType ?? "static" }] };
    return { rows: [] };
  });
  return { client: { query } as unknown as Queryable, query, enrollments };
}

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
    expect(query.mock.calls.find(([sql]) => sql.includes("from automations"))![1]).toEqual(["tenant_1", "contact_updated", "@contact.updated", null]);
  });
  it.each([undefined, "normal", "bulk"] as const)("persists %s priority on an actual matching contact run", async (priority) => {
    const { client, query } = triggerClient();
    const fired = await fireContactTrigger(client, "tenant_1", "import_1", {
      triggerType: "contact_created", key: "@contact.created", contact, priority,
    });
    expect(fired.runs).toHaveLength(1);
    expect(fired.event).toMatchObject({ name: "@contact.created", request_id: "import_1", email: contact.email });
    const candidates = query.mock.calls.find(([sql]) => sql.includes("from automations"))!;
    expect(candidates[0]).toContain("order by created_at");
    expect(candidates[0]).toContain("enabled = true and deleted_at is null");
    expect(candidates[0]).toContain("paused_at is null");
    expect(candidates[1]).toEqual(["tenant_1", "contact_created", "@contact.created", null]);
    const enrollment = query.mock.calls.find(([sql]) => sql.includes("insert into automation_enrollments"))!;
    expect(enrollment[1]).toEqual(["tenant_1", "automation_1", contact.id]);
    const run = query.mock.calls.find(([sql]) => sql.includes("insert into automation_runs"))!;
    expect(run[0]).toContain("state, priority");
    expect(run[1]?.slice(1)).toEqual(["tenant_1", "automation_1", fired.event!.id, priority ?? "normal", contact.id, 0]);
    expect(query.mock.calls.indexOf(candidates)).toBeLessThan(query.mock.calls.indexOf(enrollment));
    expect(query.mock.calls.indexOf(enrollment)).toBeLessThan(query.mock.calls.indexOf(run));
  });

  it.each(["normal", "bulk"] as const)("enforces once reentry for %s triggers", async (priority) => {
    const { client, query, enrollments } = triggerClient();
    const options: TriggerOptions = { triggerType: "contact_created", key: "@contact.created", contact, priority };
    expect((await fireContactTrigger(client, "tenant_1", "req_1", options)).runs).toHaveLength(1);
    expect((await fireContactTrigger(client, "tenant_1", "req_2", options)).runs).toEqual([]);
    expect(enrollments).toEqual(new Set([contact.id]));
    expect(query.mock.calls.filter(([sql]) => sql.includes("insert into automation_runs"))).toHaveLength(1);
  });

  it("allows every_time reentry without inserting enrollment records", async () => {
    const { client, query } = triggerClient({ reentry: "every_time" });
    const options: TriggerOptions = { triggerType: "contact_created", key: "@contact.created", contact, priority: "bulk" };
    expect((await fireContactTrigger(client, "tenant_1", "req_1", options)).runs).toHaveLength(1);
    expect((await fireContactTrigger(client, "tenant_1", "req_2", options)).runs).toHaveLength(1);
    expect(query.mock.calls.some(([sql]) => sql.includes("automation_enrollments"))).toBe(false);
    expect(query.mock.calls.filter(([sql]) => sql.includes("insert into automation_runs"))).toHaveLength(2);
  });

  it("defaults real-event runs to normal priority", async () => {
    const { client, query } = triggerClient({ reentry: "every_time" });
    const runs = await startRuns(client, "tenant_1", { ...event, name: "user.created" },
      { triggerType: "event", key: "user.created", contact });
    expect(runs).toHaveLength(1);
    expect(query.mock.calls.find(([sql]) => sql.includes("insert into automation_runs"))![1]![4]).toBe("normal");
  });

  it.each([0, 2, 4])("uses immutable parent depth %s without reading its event or edited trigger", async (depth) => {
    const { client, query } = triggerClient({ reentry: "every_time" });
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql, params) => sql.includes("select r.automation_id, r.depth")
      ? { rows: [{ automation_id: "parent", depth }] } : original(sql, params));
    const fired = await fireContactTrigger(client, "tenant_1", "req_1", {
      triggerType: "contact_created", key: "@contact.created", contact, originRunId: "run_parent",
    });
    expect(fired.event?.data.depth).toBe(depth + 1);
    expect(fired.runs).toHaveLength(depth === 4 ? 0 : 1);
    const inserts = query.mock.calls.filter(([sql]) => sql.includes("insert into automation_runs"));
    if (inserts.length) expect(inserts[0]![1]![6]).toBe(depth + 1);
    expect(query.mock.calls.filter(([sql]) => sql.includes("select r.automation_id")).every(([sql]) =>
      !sql.includes("custom_events") && !sql.includes("automations a"))).toBe(true);
  });

  it("never guesses missing legacy provenance from current configuration or payload", async () => {
    const { client, query } = triggerClient();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql, params) => sql.includes("select r.automation_id, r.depth")
      ? { rows: [{ automation_id: "parent", depth: null }] } : original(sql, params));
    await expect(fireContactTrigger(client, "tenant_1", "req_1", {
      triggerType: "contact_created", key: "@contact.created", contact, originRunId: "run_parent",
    })).rejects.toThrow("Original enrollment depth is unavailable");
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into automation_runs"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into custom_events") || sql.includes("insert into automation_enrollments"))).toBe(false);
    expect(query.mock.calls.findIndex(([sql]) => sql.includes("from automations"))).toBeGreaterThan(-1);
  });

  it("allows an unknown-depth mutation's history when field filters leave no eligible candidate", async () => {
    const { client, query } = triggerClient();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql, params) => {
      if (sql.includes("select r.automation_id, r.depth")) return { rows: [{ automation_id: "parent", depth: null }] };
      if (sql.includes("from automations")) return { rows: [{
        id: "child", trigger: "@contact.updated", trigger_type: "contact_updated", reentry: "once",
        steps: [{ key: "start", type: "trigger", config: { type: "contact_updated", field: "last_name" } }], connections: [],
      }] };
      return original(sql, params);
    });
    await dispatchContactWrite(client, "tenant_1", "req_1", contact, { ...contact, first_name: "Grace" }, { originRunId: "unknown" });
    expect(query.mock.calls.filter(([sql]) => sql.includes("insert into contact_changes"))).toHaveLength(1);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into custom_events") || sql.includes("insert into automation_runs"))).toBe(false);
    expect(query.mock.calls.find(([sql]) => sql.includes("from automations"))![1]![3]).toBe("parent");
  });

  it("does not require unknown depth when selected runs are empty or only the origin", async () => {
    const { client, query } = triggerClient();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql, params) => sql.includes("select r.automation_id, r.depth")
      ? { rows: [{ automation_id: "parent", depth: null }] } : original(sql, params));
    const options: TriggerOptions = { triggerType: "contact_updated", key: "@contact.updated", contact, originRunId: "unknown" };
    expect(await startRuns(client, "tenant_1", event, options, [])).toEqual([]);
    expect(await startRuns(client, "tenant_1", event, options, [{
      id: "parent", trigger: "@contact.updated", trigger_type: "contact_updated", reentry: "once", steps: [], connections: [],
    }])).toEqual([]);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into automation_runs"))).toBe(false);
  });

  it("keeps a real legacy @ event with forged payload depth at root zero", async () => {
    const { client, query } = triggerClient({ reentry: "every_time" });
    await startRuns(client, "tenant_1", { ...event, name: "@contact.created", data: { depth: 100, origin_run_id: "forged" } },
      { triggerType: "event", key: "@contact.created", contact });
    expect(query.mock.calls.find(([sql]) => sql.includes("insert into automation_runs"))![1]![6]).toBe(0);
  });

  it("keeps normal contact writes at normal priority and ignores a no-op write", async () => {
    const { client, query } = triggerClient();
    await dispatchContactWrite(client, "tenant_1", "req_1", contact, { ...contact, first_name: "Grace" });
    expect(query.mock.calls.find(([sql]) => sql.includes("insert into automation_runs"))![1]![4]).toBe("normal");
    const length = query.mock.calls.length;
    await dispatchContactWrite(client, "tenant_1", "req_2", contact, { ...contact, updated_at: "later" });
    expect(query.mock.calls).toHaveLength(length);
  });

  it("fires ordinary topic and actual static-segment transitions at normal priority", async () => {
    const { client, query } = triggerClient({ reentry: "every_time" });
    await dispatchTopicChanges(client, "tenant_1", "req_1", contact, [
      { topic_id: "topic_1", before: "unsubscribed", after: "subscribed" },
      { topic_id: "topic_noop", before: "subscribed", after: "subscribed" },
    ]);
    await dispatchSegmentAdded(client, "tenant_1", "req_1", contact, "segment_1", true);
    await dispatchSegmentAdded(client, "tenant_1", "req_1", contact, "segment_noop", false);
    expect(query.mock.calls.filter(([sql]) => sql.includes("insert into custom_events")).map(([, params]) => params![3])).toEqual([
      "@topic.subscribed:topic_1", "@segment.added:segment_1",
    ]);
    expect(query.mock.calls.filter(([sql]) => sql.includes("insert into automation_runs")).map(([, params]) => params![4])).toEqual(["normal", "normal"]);
  });

  it("does not start runs for a segment that became dynamic after configuration", async () => {
    const { client, query } = triggerClient({ segmentType: "dynamic" });
    expect(await fireContactTrigger(client, "tenant_1", "req_1", {
      triggerType: "segment_added", key: "@segment.added:segment_1", contact, priority: "bulk",
    })).toEqual({ event: null, runs: [] });
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into custom_events") || sql.includes("insert into automation_runs"))).toBe(false);
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
