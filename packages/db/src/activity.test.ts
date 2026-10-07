import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { contactActivity, contactActivitySource, contactStats, presentActivity } from "./activity.js";

function client(rows: unknown[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows, rowCount: rows.length };
    }),
  };
}

describe("contact activity", () => {
  it("unions segment, topic, and email events for one contact, newest first", async () => {
    const db = client([{ id: "event_1", type: "email.delivered", resource_id: "email_1", label: "Hi", email_id: "email_1", created_at: "2026-10-01" }]);
    const page = await contactActivity(db, "tenant_1", { id: "contact_1", email: "ada@example.com" }, { limit: 5 });
    const { sql, params } = db.queries[0];
    expect(sql).toContain("from segment_contacts sc");
    expect(sql).toContain("from topic_subscriptions ts");
    expect(sql).toContain("from email_events ev");
    expect(sql).toContain("lower(r.email) = lower($3)");
    expect(sql).toContain("where ev.tenant_id = $1 and exists");
    expect(sql).toContain("'event.fired'");
    expect(sql).toContain("e.name not like '@%'");
    expect(sql).toContain("r.id || ':started'");
    expect(sql).toContain("r.id || ':completed'");
    expect(sql).toContain("r.state in ('done', 'failed', 'stopped')");
    expect(sql).toContain("order by created_at desc, id desc");
    expect(params).toEqual(["tenant_1", "contact_1", "ada@example.com", 6]);
    expect(page.data.map(presentActivity)[0]).toMatchObject({ object: "contact_activity", type: "email.delivered" });
  });

  it("pages with an id cursor after the contact parameters", async () => {
    const db = client([]);
    await contactActivity(db, "tenant_1", { id: "contact_1", email: "ada@example.com" }, { after: "sub_1" });
    expect(db.queries[0].params).toEqual(["tenant_1", "contact_1", "ada@example.com", "sub_1", 21]);
    expect(db.queries[0].sql).toContain("id = $4");
  });

  it("projects only the stored terminal reason through every union branch and page", async () => {
    const branches = contactActivitySource.split("union all");
    expect(branches).toHaveLength(7);
    expect(branches[0]).toContain("null::text as exit_reason");
    for (const branch of branches.slice(0, -1)) {
      expect(branch).not.toContain("r.exit_reason");
      expect(branch.split("\n  from")[0]).toMatch(/null::text(?: as exit_reason)?\s*$/);
    }
    expect(branches.at(-1)).toContain("r.automation_id, r.id, r.exit_reason");
    expect(branches.at(-1)).toContain("r.state in ('done', 'failed', 'stopped')");
    const db = client([]);
    await contactActivity(db, "tenant_1", { id: "contact_1", email: "ada@example.com" }, { before: "run_1:completed", limit: 5 });
    expect(db.queries[0].sql).toContain("select id, type, resource_id, label, email_id, created_at, automation_id, run_id, exit_reason");
    expect(db.queries[0].params).toEqual(["tenant_1", "contact_1", "ada@example.com", "run_1:completed", 6]);
  });

  it.each(["completed", "exit", "filter", "stopped", "stranded"] as const)("presents a stored %s reason without changing the state or run identifiers", (exit_reason) => {
    const row = {
      id: "run_1:completed", type: "automation.run.completed", resource_id: "run_1",
      label: exit_reason === "stopped" || exit_reason === "stranded" ? "stopped" : "done",
      email_id: null, automation_id: "automation_1", run_id: "run_1", created_at: "2026-10-04", exit_reason,
    };
    expect(presentActivity(row)).toEqual({ object: "contact_activity", ...row });
  });

  it.each(["done", "failed", "stopped"])("does not infer a legacy %s run reason", (label) => {
    const row = { id: "run_1:completed", type: "automation.run.completed", resource_id: "run_1", label, email_id: null, created_at: "2026-10-04" };
    expect(presentActivity(row).exit_reason).toBeNull();
    expect(presentActivity({ ...row, exit_reason: null }).exit_reason).toBeNull();
  });

  it.each(["automation.run.started", "event.fired", "email.delivered", "contact.created"])("never exposes a terminal reason on %s", (type) => {
    expect(presentActivity({
      id: "activity_1", type, resource_id: "resource_1", label: "Label",
      email_id: null, created_at: "2026-10-04", exit_reason: "exit",
    }).exit_reason).toBeNull();
  });

  it("documents the optional nullable stored reason and preserves the activity route response", () => {
    const spec = JSON.parse(readFileSync(new URL("../../../docs/api/openapi.json", import.meta.url), "utf8"));
    const activity = spec.components.schemas.ContactActivity;
    expect(activity.properties.exit_reason.type).toEqual(["string", "null"]);
    expect(activity.properties.exit_reason.enum).toEqual(["completed", "exit", "filter", "stopped", "stranded", null]);
    expect(activity.required).not.toContain("exit_reason");
    expect(JSON.stringify(spec.paths["/contacts/{contact}/activity"] ?? spec.paths["/contacts/{id}/activity"])).toContain("#/components/schemas/ContactActivity");
  });

  it("counts all, subscribed, and unsubscribed contacts", async () => {
    const db = client([{ all: 5, subscribed: 3, unsubscribed: 2 }]);
    expect(await contactStats(db, "tenant_1")).toEqual({ object: "contact_stats", all: 5, subscribed: 3, unsubscribed: 2 });
    expect(db.queries[0].sql).toContain("deleted_at is null");
  });
});
