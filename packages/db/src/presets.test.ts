import { describe, expect, it, vi } from "vitest";
import { stepConfigs, type Step } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { installAutomation, type AutomationPreset } from "./presets.js";
import type { LibraryInstallEntry } from "./templates.js";

const entries: LibraryInstallEntry[] = [
  { slug: "welcome", name: "Welcome", subject: "Hello", html: "<p>Hello</p>", kind: "transactional" },
  { slug: "tips", name: "Tips", subject: "Tips", html: "<p>Tips</p>", kind: "marketing" },
];
const sender = "Acme <mail@EXAMPLE.com>";
function preset(): AutomationPreset {
  return {
    slug: "onboarding-drip", name: "Onboarding drip", stage: "onboarding",
    description: "Help new contacts", when: "Contact created",
    trigger_config: { type: "contact_created" }, reentry: "once",
    events: [{ name: "billing.failed", schema: { invoice_id: "string" } }],
    properties: [{ key: "activated", type: "boolean" }],
    templates: ["welcome", "tips"],
    steps: [
      { key: "trigger", type: "trigger", config: { type: "contact_created" } },
      { key: "welcome", type: "send_email", config: {
        template: { id: "welcome", variables: { PRODUCT: "Acme" } }, kind: "transactional",
        from: "old@example.com", subject: "Welcome!", variables: { NAME: "Customer" },
        variable_mapping: { first_name: "contact.first_name" },
      } },
      { key: "tips", type: "send_email", config: { template: "tips", kind: "marketing" } },
      { key: "exit", type: "exit", config: {} },
    ],
    connections: [
      { from: "trigger", to: "welcome", type: "default" },
      { from: "welcome", to: "tips", type: "default" },
      { from: "tips", to: "exit", type: "default" },
    ],
  };
}

type Dependency = { id: string; deleted_at: string | null; type?: string; schema?: Record<string, string> };
type Options = {
  domain?: false | "disabled";
  topic?: false;
  templates?: Record<string, string>;
  unusableAlias?: boolean;
  event?: Dependency;
  property?: Dependency;
  eventRace?: boolean;
  propertyRace?: boolean;
  nameConflict?: boolean;
  postgresError?: string;
  marketingTemplate?: boolean;
};
function database(options: Options = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let eventReads = 0;
  let propertyReads = 0;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes("from domains")) return { rows: options.domain === false ? [] : [{ id: "domain_1", sending: options.domain ?? null }] };
    if (sql.includes("from topics")) return { rows: options.topic === false ? [] : [{ id: values[1] }] };
    if (sql.includes("from event_schemas")) {
      eventReads++;
      return { rows: options.event && (!options.eventRace || eventReads > 1) ? [{ ...options.event, name: values[1] }] : [] };
    }
    if (sql.includes("insert into event_schemas")) {
      return { rows: options.eventRace ? [] : [{ id: values[0], name: values[2], schema: JSON.parse(values[3] as string), deleted_at: null }] };
    }
    if (sql.includes("from contact_properties")) {
      propertyReads++;
      return { rows: options.property && (!options.propertyRace || propertyReads > 1) ? [{ ...options.property, key: values[1] }] : [] };
    }
    if (sql.includes("insert into contact_properties")) {
      return { rows: options.propertyRace ? [] : [{ id: values[0], key: values[2], type: values[3], deleted_at: null }] };
    }
    if (sql.includes("insert into templates")) {
      return { rows: options.templates?.[values[3] as string] || options.unusableAlias ? [] : [{ id: values[0] }] };
    }
    if (sql.includes("for update of t")) {
      return { rows: options.unusableAlias ? [] : [{ id: options.templates?.[values[1] as string] }] };
    }
    if (sql.includes("select v.source")) {
      return { rows: options.marketingTemplate ? [{ source: { send_kind: "marketing" }, html: "", text: "" }] : [] };
    }
    if (sql.includes("insert into automations")) {
      if (options.postgresError) throw Object.assign(new Error("PostgreSQL error"), { code: options.postgresError });
      return { rows: options.nameConflict ? [] : [{
        id: values[0], name: values[2], trigger: values[3], steps: JSON.parse(values[4] as string),
        connections: JSON.parse(values[5] as string), enabled: values[6], trigger_type: values[7],
        reentry: values[8], used_keys: JSON.parse(values[9] as string),
        paused_at: null, version: 0, created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z",
      }] };
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as Queryable, calls, query };
}
const writes = (db: ReturnType<typeof database>) => db.calls.filter(({ sql }) => /^\s*(insert|update|delete)/i.test(sql));
const execute = (db: ReturnType<typeof database>, definition = preset(), input = { from: sender }) =>
  installAutomation(db.client, "tenant_1", definition, entries, input);

describe("installAutomation", () => {
  it("creates missing resources and a disabled normalized automation without opening a transaction", async () => {
    const db = database();
    const definition = preset();
    const before = structuredClone(definition);
    const libraryBefore = structuredClone(entries);
    const result = await installAutomation(db.client, "tenant_1", definition, entries, { from: sender, topic_id: "topic_1" }, "2.0.0");
    expect(result.automation).toMatchObject({
      name: definition.name, enabled: false, paused_at: null, version: 0,
      trigger: "@contact.created", trigger_type: "contact_created", reentry: "once",
      connections: definition.connections,
      used_keys: { trigger: "trigger", welcome: "send_email", tips: "send_email", exit: "exit" },
    });
    expect(result.templates.created.map(({ slug }) => slug)).toEqual(["welcome", "tips"]);
    expect(result.templates.reused).toEqual([]);
    expect(result.events).toEqual([{ id: expect.stringMatching(/^evdef_/), name: "billing.failed" }]);
    expect(result.properties).toEqual([{ id: expect.stringMatching(/^prop_/), key: "activated", type: "boolean" }]);
    const steps = result.automation.steps;
    expect(steps[1]!.config).toEqual({
      from: sender, kind: "transactional", subject: "Welcome!",
      variable_mapping: { first_name: "contact.first_name" },
      template: { id: result.templates.created[0]!.id, variables: { NAME: "Customer", PRODUCT: "Acme" } },
    });
    expect(steps[2]!.config).toMatchObject({
      from: sender, kind: "marketing", topic_id: "topic_1",
      template: { id: result.templates.created[1]!.id, variables: {} },
    });
    expect(result.next_steps).toEqual(["Review the automation and its emails", "Enable the automation"]);
    expect(definition).toEqual(before);
    expect(entries).toEqual(libraryBefore);
    expect(db.calls[0]!.values).toEqual(["tenant_1", "example.com"]);
    expect(db.calls[0]!.sql).toContain("status = 'verified' and deleted_at is null for share");
    expect(db.calls.some(({ sql }) => /\b(begin|commit|rollback)\b/i.test(sql))).toBe(false);
    expect(db.calls.filter(({ sql }) => sql.includes("insert into template_versions"))).toHaveLength(2);
    expect(db.calls.filter(({ sql }) => sql.includes("insert into template_versions")).every(({ values }) =>
      JSON.parse(values[9] as string).version === "2.0.0")).toBe(true);
  });

  it("reuses edited and draft aliases without changing content, sender, versions, or publication", async () => {
    const db = database({
      templates: { welcome: "custom_welcome", tips: "draft_tips" },
      event: { id: "event_old", deleted_at: null, schema: { invoice_id: "string", extra: "number" } },
      property: { id: "prop_old", deleted_at: null, type: "boolean" },
    });
    const result = await execute(db);
    expect(result.templates).toEqual({ created: [], reused: [
      { id: "custom_welcome", slug: "welcome" }, { id: "draft_tips", slug: "tips" },
    ] });
    expect(result.events).toEqual([]);
    expect(result.properties).toEqual([]);
    expect(result.automation.steps[1]!.config).toMatchObject({ from: sender, template: { id: "custom_welcome" } });
    expect(result.automation.steps[2]!.config).toMatchObject({ from: sender, kind: "marketing", template: { id: "draft_tips" } });
    expect(result.automation.steps[2]!.config).not.toHaveProperty("topic_id");
    expect(result.next_steps).toEqual(["Choose a topic for marketing steps", "Review the automation and its emails", "Enable the automation"]);
    expect(db.calls.some(({ sql }) => /insert into template_versions|update templates|update template_versions|update event_schemas|update contact_properties/.test(sql))).toBe(false);
    expect(db.calls.filter(({ sql }) => sql.includes("for update of t"))).toHaveLength(2);
  });

  it("classifies mixed aliases once and preserves declaration order rather than lock order", async () => {
    const definition = preset();
    definition.templates = ["welcome", "tips", "welcome"];
    const result = await execute(database({ templates: { tips: "tips_existing" } }), definition);
    expect(result.templates.created).toEqual([{ id: expect.any(String), slug: "welcome" }]);
    expect(result.templates.reused).toEqual([{ id: "tips_existing", slug: "tips" }]);
  });

  it("binds newsletter trigger and every marketing send, preserving binary Condition", async () => {
    const definition = preset();
    definition.slug = "newsletter-welcome";
    definition.trigger_config = { type: "topic_subscribed", topic_id: "{{topic_id}}" };
    definition.steps = [
      { key: "trigger", type: "trigger", config: definition.trigger_config },
      { key: "condition", type: "condition", config: { type: "rule", field: "contact.activated", operator: "eq", value: true } },
      { key: "welcome", type: "send_email", config: { template: "welcome", kind: "marketing" } },
      { key: "tips", type: "send_email", config: { template: "tips", kind: "marketing" } },
      { key: "exit", type: "exit", config: {} },
    ];
    definition.connections = [
      { from: "trigger", to: "condition", type: "default" },
      { from: "condition", to: "welcome", type: "condition_met" },
      { from: "condition", to: "tips", type: "condition_not_met" },
      { from: "welcome", to: "exit", type: "default" },
      { from: "tips", to: "exit", type: "default" },
    ];
    const before = structuredClone(definition);
    const result = await installAutomation(database().client, "tenant_1", definition, entries, { from: sender, topic_id: "topic_news" });
    expect(result.automation).toMatchObject({ trigger: "@topic.subscribed:topic_news", trigger_type: "topic_subscribed" });
    expect(result.automation.steps[0]!.config).toEqual({ type: "topic_subscribed", topic_id: "topic_news" });
    expect(result.automation.steps[1]!.type).toBe("condition");
    for (const step of result.automation.steps.filter((step) => step.type === "send_email")) {
      expect(step.config).toMatchObject({ from: sender, kind: "marketing", topic_id: "topic_news" });
    }
    expect(result.automation.connections).toEqual(definition.connections);
    expect(definition).toEqual(before);
  });

  it("requires newsletter topic before all queries or writes", async () => {
    const db = database();
    const definition = preset();
    definition.slug = "newsletter-welcome";
    await expect(execute(db, definition)).rejects.toMatchObject({ statusCode: 422, name: "validation_error", message: "Choose a topic" });
    expect(db.calls).toEqual([]);
  });

  it.each([undefined, "", "   "])("requires sender %j before all queries", async (from) => {
    const db = database();
    await expect(installAutomation(db.client, "tenant_1", preset(), entries, { from: from as string }))
      .rejects.toMatchObject({ statusCode: 422, name: "validation_error", message: "Choose a sender" });
    expect(db.calls).toEqual([]);
  });

  it.each(["bad", "mail@example.com\r\nBcc: victim@example.com", `${"x".repeat(999)} <mail@example.com>`])("uses core address rejection for %j", async (from) => {
    const db = database();
    await expect(execute(db, preset(), { from })).rejects.toHaveProperty("name", "ZodError");
    expect(db.calls).toEqual([]);
  });

  it.each([
    [false, "Sender domain is not verified"],
    ["disabled", "Sending is disabled for this domain"],
  ] as const)("matches ingest domain status for %j", async (domain, message) => {
    const db = database({ domain });
    await expect(execute(db)).rejects.toMatchObject({ statusCode: 403, name: "validation_error", message });
    expect(writes(db)).toEqual([]);
  });

  it("rejects foreign, deleted, or absent topics before dependency writes", async () => {
    const db = database({ topic: false });
    await expect(installAutomation(db.client, "tenant_1", preset(), entries, { from: sender, topic_id: "foreign" }))
      .rejects.toMatchObject({ statusCode: 422, name: "validation_error" });
    expect(writes(db)).toEqual([]);
    expect(db.calls[1]!.values).toEqual(["tenant_1", "foreign"]);
    expect(db.calls[1]!.sql).toContain("deleted_at is null for share");
  });

  it.each(["", "n".repeat(121)])("applies existing automation name limits before resource writes", async (name) => {
    const db = database();
    await expect(installAutomation(db.client, "tenant_1", preset(), entries, { name, from: sender })).rejects.toHaveProperty("name", "ZodError");
    expect(writes(db)).toEqual([]);
  });

  it("uses caller name and preserves event trigger and reentry", async () => {
    const definition = preset();
    definition.trigger_config = { type: "event", event_name: "billing.failed" };
    definition.reentry = "every_time";
    const result = await installAutomation(database().client, "tenant_1", definition, entries, { name: "My flow", from: sender });
    expect(result.automation).toMatchObject({ name: "My flow", trigger: "billing.failed", trigger_type: "event", reentry: "every_time", enabled: false });
  });

  it.each([
    { schema: { invoice_id: "number" }, deleted_at: null },
    { schema: {}, deleted_at: null },
    { schema: { invoice_id: "string" }, deleted_at: "2026-10-01" },
  ])("rejects incompatible/tombstoned events without rewriting them: %j", async (event) => {
    const db = database({ event: { id: "ev_old", ...event } });
    await expect(execute(db)).rejects.toMatchObject({ statusCode: 409, name: "conflict" });
    expect(writes(db)).toEqual([]);
    expect(db.calls.find(({ sql }) => sql.includes("from event_schemas"))!.sql).toContain("for update");
  });

  it.each([
    { type: "string", deleted_at: null },
    { type: "boolean", deleted_at: "2026-10-01" },
  ])("rejects incompatible/tombstoned properties without reviving them: %j", async (property) => {
    const db = database({ property: { id: "prop_old", ...property } });
    await expect(execute(db)).rejects.toMatchObject({ statusCode: 409, name: "conflict" });
    expect(db.calls.some(({ sql }) => /update contact_properties|insert into templates|insert into automations/.test(sql))).toBe(false);
  });

  it("rereads and reuses compatible concurrent event/property winners", async () => {
    const db = database({
      eventRace: true, propertyRace: true,
      event: { id: "ev_winner", deleted_at: null, schema: { invoice_id: "string" } },
      property: { id: "prop_winner", deleted_at: null, type: "boolean" },
    });
    const result = await execute(db);
    expect(result.events).toEqual([]);
    expect(result.properties).toEqual([]);
    expect(db.calls.filter(({ sql }) => sql.includes("from event_schemas"))).toHaveLength(2);
    expect(db.calls.filter(({ sql }) => sql.includes("from contact_properties"))).toHaveLength(2);
    expect(db.calls.find(({ sql }) => sql.includes("insert into event_schemas"))!.sql).toContain("on conflict (tenant_id, name) do nothing");
    expect(db.calls.find(({ sql }) => sql.includes("insert into contact_properties"))!.sql).toContain("on conflict (tenant_id, key) do nothing");
  });

  it.each([
    { eventRace: true },
    { propertyRace: true },
    { eventRace: true, event: { id: "ev_winner", deleted_at: null, schema: { invoice_id: "number" } } },
    { propertyRace: true, property: { id: "prop_winner", deleted_at: null, type: "string" } },
  ])("returns conflict for missing/incompatible dependency race winners %j", async (options) => {
    await expect(execute(database(options))).rejects.toMatchObject({ statusCode: 409, name: "conflict" });
  });

  it("returns conflict for an alias loser without a usable live version", async () => {
    const db = database({ unusableAlias: true });
    await expect(execute(db)).rejects.toMatchObject({ statusCode: 409, name: "conflict" });
    expect(db.calls.some(({ sql }) => /insert into template_versions|update templates|insert into automations/.test(sql))).toBe(false);
  });

  it("keeps shared send-kind checks, including edited transactional copies that became marketing", async () => {
    const db = database({ marketingTemplate: true });
    await expect(execute(db)).rejects.toMatchObject({ statusCode: 422, name: "validation_error", message: "Step welcome uses a Marketing template and must be Marketing" });
    expect(db.calls.some(({ sql }) => sql.includes("insert into automations"))).toBe(false);
  });

  it("rejects live name conflicts with the partial unique-index insert contract", async () => {
    const db = database({ nameConflict: true });
    await expect(execute(db)).rejects.toMatchObject({ statusCode: 409, name: "conflict", message: "An automation named Onboarding drip already exists" });
    expect(db.calls.find(({ sql }) => sql.includes("insert into automations"))!.sql)
      .toContain("on conflict (tenant_id, name) where deleted_at is null do nothing");
  });

  it.each(["23505", "40P01", "40001"])("converts PostgreSQL contention %s to API conflict", async (postgresError) => {
    await expect(execute(database({ postgresError }))).rejects.toMatchObject({ statusCode: 409, name: "conflict" });
  });

  it("preserves unexpected database errors for caller rollback", async () => {
    await expect(execute(database({ postgresError: "08006" }))).rejects.toMatchObject({ code: "08006", message: "PostgreSQL error" });
  });

  it("requires declared and available library entries before writes", async () => {
    const absent = database();
    await expect(installAutomation(absent.client, "tenant_1", preset(), [], { from: sender })).rejects.toMatchObject({ statusCode: 409, name: "conflict" });
    expect(writes(absent)).toEqual([]);
    const undeclared = database();
    const definition = preset();
    definition.steps[1]!.config.template = "not_declared";
    await expect(execute(undeclared, definition)).rejects.toMatchObject({ statusCode: 409, name: "conflict" });
    expect(writes(undeclared)).toEqual([]);
  });

  it("returns empty arrays and no missing-topic advice for a transactional-only flow", async () => {
    const definition = preset();
    definition.slug = "failed-payment";
    definition.events = [];
    definition.properties = [];
    definition.steps[2]!.config.kind = "transactional";
    const result = await execute(database({ templates: { welcome: "welcome_existing", tips: "tips_existing" } }), definition);
    expect(result.automation.id).toMatch(/^automation_/);
    expect(result.automation.enabled).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.properties).toEqual([]);
    expect(result.templates.created).toEqual([]);
    expect(result.next_steps).toEqual(["Review the automation and its emails", "Enable the automation"]);
    for (const step of result.automation.steps.filter((step) => step.type === "send_email")) {
      expect(step.config).toMatchObject({ kind: "transactional", from: sender });
      expect(step.config).not.toHaveProperty("topic_id");
    }
  });

  it("reports created dependencies in declaration order despite sorted lock acquisition", async () => {
    const definition = preset();
    definition.events = [{ name: "z.event", schema: {} }, { name: "a.event", schema: {} }];
    definition.properties = [{ key: "z_property", type: "number" }, { key: "a_property", type: "date" }];
    const db = database();
    const result = await execute(db, definition);
    expect(result.events.map(({ name }) => name)).toEqual(["z.event", "a.event"]);
    expect(result.properties.map(({ key }) => key)).toEqual(["z_property", "a_property"]);
    expect(db.calls.filter(({ sql }) => sql.includes("insert into event_schemas")).map(({ values }) => values[2]))
      .toEqual(["a.event", "z.event"]);
    expect(db.calls.filter(({ sql }) => sql.includes("insert into contact_properties")).map(({ values }) => values[2]))
      .toEqual(["a_property", "z_property"]);
  });

  it("does not expand Branch to a one-path form", async () => {
    expect(stepConfigs.branch.safeParse({ paths: [{
      key: "active", label: "Active", rule: { type: "rule", field: "contact.activated", operator: "eq", value: true },
    }] }).success).toBe(false);
    const db = database();
    const definition = preset();
    definition.steps[1] = { key: "welcome", type: "branch", config: { paths: [] } } as Step;
    await expect(execute(db, definition)).rejects.toHaveProperty("name", "ZodError");
    expect(writes(db)).toEqual([]);
  });

  it("runs shared contact-updated trigger validation after creating its property", async () => {
    const db = database();
    const definition = preset();
    definition.properties = [{ key: "plan", type: "string" }];
    definition.trigger_config = { type: "contact_updated", field: "plan", to: "canceled" };
    // The propertyDefinitions reread must observe the insert inside the caller's transaction.
    const base = db.client.query;
    db.client.query = vi.fn(async (...args: unknown[]) => {
      if (String(args[0]).includes("from contact_properties") && String(args[0]).includes("deleted_at is null")) {
        db.calls.push({ sql: args[0] as string, values: args[1] as unknown[] });
        return { rows: [{ id: "prop_plan", key: "plan", type: "string", fallback_value: null }] };
      }
      return (base as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as unknown as Queryable["query"];
    const result = await execute(db, definition);
    expect(result.automation).toMatchObject({ trigger: "@contact.updated", trigger_type: "contact_updated" });
    const insertIndex = db.calls.findIndex(({ sql }) => sql.includes("insert into contact_properties"));
    const validateIndex = db.calls.findIndex(({ sql }) => sql.includes("from contact_properties") && sql.includes("deleted_at is null"));
    expect(validateIndex).toBeGreaterThan(insertIndex);
  });
});
