import { describe, expect, it } from "vitest";
import {
  automationGraphSchema,
  automationInstallSchema,
  automationIssues,
  automationSchema,
  automationStopSchema,
  automationUpdateSchema,
  evaluate,
  eventSchema,
  eventSendSchema,
  normalizeAutomation,
  payloadIssues,
  stepConfigs,
  type Rule
} from "./index.js";

describe("preset installation input", () => {
  it("accepts existing sender syntax and optional name/topic fields", () => {
    expect(automationInstallSchema.parse({ from: "Acme <hello@acme.com>", topic_id: "topic_1" }))
      .toEqual({ from: "Acme <hello@acme.com>", topic_id: "topic_1" });
  });
  it.each([
    {}, { from: "bad" }, { from: "hello@acme.com\r\nBcc: other@acme.com" },
    { from: "hello@acme.com", name: "" }, { from: "hello@acme.com", name: "x".repeat(121) },
    { from: "hello@acme.com", topic_id: "" }, { from: "hello@acme.com", topic_id: 3 },
  ])("rejects malformed fields without graph initialization", (input) => {
    expect(automationInstallSchema.safeParse(input).success).toBe(false);
  });
});

const graph = {
  name: "Welcome series",
  status: "enabled",
  steps: [
    { key: "start", type: "trigger", config: { event_name: "user.created" } },
    { key: "wait", type: "delay", config: { duration: "2 days" } },
    { key: "check", type: "condition", config: { type: "rule", field: "event.plan", operator: "eq", value: "pro" } },
    { key: "welcome", type: "send_email", config: { from: "Acme <hello@acme.com>", template: { id: "welcome", variables: { a: 1 } } } },
    { key: "bye", type: "contact_delete" }
  ],
  connections: [
    { from: "start", to: "wait" },
    { from: "wait", to: "check" },
    { from: "check", to: "welcome", type: "condition_met" },
    { from: "check", to: "bye", type: "condition_not_met" }
  ]
};

describe("normalizeAutomation", () => {
  it("turns the linear form into a keyed graph with legacy names mapped", () => {
    const result = normalizeAutomation({
      trigger: "user.signed_up",
      steps: [
        { type: "update_contact", properties: { source: "automation" } },
        { type: "wait", event: "user.activated", timeout_seconds: 3_600 },
        { type: "delay", seconds: 60 },
        { type: "send_email", from: "hello@example.com", template: "welcome", variables: { plan: "pro" } }
      ]
    });
    expect(result.steps.map((step) => [step.key, step.type])).toEqual([
      ["trigger", "trigger"],
      ["step_1", "contact_update"],
      ["step_2", "wait_for_event"],
      ["step_3", "delay"],
      ["step_4", "send_email"]
    ]);
    expect(result.steps[0]!.config).toEqual({ type: "event", event_name: "user.signed_up" });
    expect(result.steps[2]!.config).toEqual({ event_name: "user.activated", timeout: "3600 seconds" });
    expect(result.steps[3]!.config).toEqual({ duration: "60 seconds" });
    expect(result.steps[4]!.config).toMatchObject({ template: { id: "welcome", variables: { plan: "pro" } } });
    expect(result.connections).toEqual([
      { from: "trigger", to: "step_1", type: "default" },
      { from: "step_1", to: "step_2", type: "default" },
      { from: "step_2", to: "step_3", type: "default" },
      { from: "step_3", to: "step_4", type: "default" }
    ]);
  });

  it("keeps the graph form and defaults connection types", () => {
    const result = normalizeAutomation(graph);
    expect(result.steps).toHaveLength(5);
    expect(result.steps[4]!.config).toEqual({});
    expect(result.connections[0]).toEqual({ from: "start", to: "wait", type: "default" });
  });

  it("names the step whose config is wrong", () => {
    const steps = [{ key: "start", type: "trigger", config: {} }];
    expect(() => normalizeAutomation({ steps })).toThrow(/event_name|Required|discriminator/);
    const parsed = automationGraphSchema.safeParse({ steps });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.path).toEqual(["steps", 0, "config", "type"]);
  });
});

describe("automation schema", () => {
  it.each([
    [{ type: "event", event_name: "billing.changed" }, "billing.changed"],
    [{ type: "contact_created" }, "@contact.created"],
    [{ type: "contact_updated", field: "active", from: false, to: true }, "@contact.updated"],
    [{ type: "topic_subscribed", topic_id: "topic_1" }, "@topic.subscribed:topic_1"],
    [{ type: "segment_added", segment_id: "segment_1" }, "@segment.added:segment_1"],
  ])("preserves the trigger config and stored key for %j", (config, trigger) => {
    const input = { name: "Entry", steps: [{ key: "start", type: "trigger", config }], connections: [] };
    const created = automationSchema.parse(input);
    expect(created).toMatchObject({ trigger, trigger_type: config.type, trigger_config: config });
    expect(automationGraphSchema.parse({ steps: created.steps, connections: created.connections })).toMatchObject({
      trigger, trigger_type: config.type, trigger_config: config,
    });
  });

  it("rejects new @ events while retaining stored legacy event normalization", () => {
    const input = { name: "Legacy", steps: [{ key: "start", type: "trigger", config: { event_name: "@contact.created" } }] };
    expect(automationSchema.safeParse(input).success).toBe(false);
    expect(automationGraphSchema.safeParse(input).success).toBe(false);
    expect(eventSchema.safeParse({ name: "@contact.created" }).success).toBe(false);
    expect(eventSendSchema.safeParse({ event: "@contact.created" }).success).toBe(false);
    expect(stepConfigs.wait_for_event.safeParse({ event_name: "@contact.created" }).success).toBe(false);
    expect(normalizeAutomation(input, true).steps[0]!.config).toEqual({ type: "event", event_name: "@contact.created" });
    expect(automationSchema.parse({ name: "Legacy event", trigger: "billing.changed", steps: [{ type: "delay", seconds: 60 }] })).toMatchObject({
      trigger: "billing.changed", trigger_type: "event", trigger_config: { type: "event", event_name: "billing.changed" }, reentry: "every_time",
    });
  });

  it.each([
    ["create", automationSchema],
    ["graph replacement", automationGraphSchema],
  ] as const)("returns graph issues without throwing for a missing keyed trigger on %s", (_name, schema) => {
    const input = {
      name: "Missing trigger",
      steps: [{ key: "later", type: "delay", config: { duration: "1 hour" } }],
      connections: [],
    };
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual([
      { code: "custom", message: "An automation needs exactly one trigger step", path: ["connections"] },
    ]);
  });

  it.each([
    ["create", automationSchema],
    ["graph replacement", automationGraphSchema],
  ] as const)("rejects a disconnected keyed graph without a trigger on %s", (_name, schema) => {
    const parsed = schema.safeParse({
      name: "Disconnected",
      steps: [
        { key: "later", type: "delay", config: { duration: "1 hour" } },
        { key: "end", type: "exit", config: {} },
      ],
      connections: [],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toEqual([
      { code: "custom", message: "An automation needs exactly one trigger step", path: ["connections"] },
    ]);
  });

  it("retains all graph issues before rejecting a missing trigger", () => {
    const parsed = automationGraphSchema.safeParse({
      steps: [{ key: "later", type: "delay", config: { duration: "1 hour" } }],
      connections: [{ from: "later", to: "missing" }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.message)).toEqual([
      "An automation needs exactly one trigger step",
      "Connection ends at unknown step missing",
    ]);
  });

  it("round trips hyphenated send mappings through create and graph replacement", () => {
    const input = {
      name: "Plan changed",
      steps: [
        { key: "start", type: "trigger", config: { event_name: "billing.changed" } },
        { key: "send", type: "send_email", config: { template: "tmpl_1", variable_mapping: { PLAN: "event.plan-id", NESTED_PLAN: "event.customer-data.plan-id" } } },
      ],
      connections: [{ from: "start", to: "send" }],
    };
    const created = automationSchema.parse(input);
    const replaced = automationGraphSchema.parse(created);
    expect(replaced.steps[1]!.config.variable_mapping).toEqual({ PLAN: "event.plan-id", NESTED_PLAN: "event.customer-data.plan-id" });
    expect(replaced.steps).toEqual(created.steps);
  });

  it("defaults stop to preserving enrollment history and accepts only explicit booleans", () => {
    expect(automationStopSchema.parse({})).toEqual({ reset_reentry: false });
    expect(automationStopSchema.parse({ reset_reentry: undefined })).toEqual({ reset_reentry: false });
    expect(automationStopSchema.parse({ reset_reentry: false })).toEqual({ reset_reentry: false });
    expect(automationStopSchema.parse({ reset_reentry: true })).toEqual({ reset_reentry: true });
  });

  it.each(["true", "false", 1, 0, null, [], {}])("rejects the nonboolean reentry reset %j", (reset_reentry) => {
    expect(automationStopSchema.safeParse({ reset_reentry }).success).toBe(false);
  });

  it("refuses unknown stop fields instead of silently accepting a misspelled reset", () => {
    expect(automationStopSchema.safeParse({ reset_reentry: true, reset: true }).success).toBe(false);
    expect(automationStopSchema.safeParse({ reset: true }).success).toBe(false);
  });

  it.each([
    { type: "contact_created" },
    { type: "contact_updated", field: "active", from: false, to: true },
    { type: "topic_subscribed", topic_id: "topic_1" },
    { type: "segment_added", segment_id: "segment_1" },
  ])("defaults typed trigger %j to once while respecting explicit every_time", (config) => {
    const input = { name: "Entry", steps: [{ key: "start", type: "trigger", config }] };
    expect(automationSchema.parse(input).reentry).toBe("once");
    expect(automationSchema.parse({ ...input, reentry: "every_time" }).reentry).toBe("every_time");
  });

  it("reads status, defaults to disabled, and takes the trigger from the trigger step", () => {
    const parsed = automationSchema.parse(graph);
    expect(parsed.enabled).toBe(true);
    expect(parsed.trigger).toBe("user.created");
    expect(automationSchema.parse({ ...graph, status: undefined }).enabled).toBe(false);
    expect(automationSchema.parse({ ...graph, status: undefined, enabled: true }).enabled).toBe(true);
    expect(automationUpdateSchema.parse({ status: "disabled" }).enabled).toBe(false);
    expect(automationUpdateSchema.parse({ name: "x" }).enabled).toBeUndefined();
  });
  it("keeps paused distinct from legacy enabled and gives explicit status precedence", () => {
    expect(automationUpdateSchema.parse({ status: "paused" })).toMatchObject({ status: "paused", enabled: true });
    expect(automationUpdateSchema.parse({ enabled: true })).toMatchObject({ status: "enabled", enabled: true });
    expect(automationUpdateSchema.parse({ enabled: false })).toMatchObject({ status: "disabled", enabled: false });
    expect(automationUpdateSchema.parse({ status: "paused", enabled: false })).toMatchObject({ status: "paused", enabled: true });
    expect(automationSchema.safeParse({ ...graph, status: "paused" }).success).toBe(false);
  });

  it("accepts delays up to 30 days in natural language", () => {
    const delay = (duration: string) =>
      automationGraphSchema.safeParse({
        steps: [
          { key: "t", type: "trigger", config: { event_name: "e" } },
          { key: "d", type: "delay", config: { duration } }
        ],
        connections: [{ from: "t", to: "d" }]
      }).success;
    expect(delay("30 days")).toBe(true);
    expect(delay("1 hour")).toBe(true);
    expect(delay("31 days")).toBe(false);
    expect(delay("soon")).toBe(false);
  });

  it("checks every send_email, condition, and wait config", () => {
    const one = (step: Record<string, unknown>) =>
      automationGraphSchema.safeParse({ steps: [{ key: "t", type: "trigger", config: { event_name: "e" } }, { key: "s", ...step }] }).success;
    expect(one({ type: "send_email", config: { from: "not an address", template: "welcome" } })).toBe(false);
    expect(one({ type: "send_email", config: { from: "hello@acme.com" } })).toBe(false);
    expect(one({ type: "condition", config: { type: "rule", field: "event.plan", operator: "like" } })).toBe(false);
    expect(one({ type: "condition", config: { type: "and", rules: [{ type: "rule", field: "a", operator: "exists" }] } })).toBe(true);
    expect(one({ type: "wait_for_event", config: { timeout: "1 day" } })).toBe(false);
    expect(one({ type: "add_to_segment", config: {} })).toBe(false);
    expect(one({ type: "contact_update", config: { unsubscribed: "yes" } })).toBe(false);
    expect(one({ type: "teleport", config: {} })).toBe(false);
  });
});

describe("automationIssues", () => {
  const steps = normalizeAutomation(graph).steps;

  it("passes a valid branch", () => {
    expect(automationIssues(steps, normalizeAutomation(graph).connections)).toEqual([]);
  });

  it("rejects a second trigger and duplicate keys", () => {
    const extra = [...steps, { key: "start", type: "trigger" as const, config: { event_name: "x" } }];
    const issues = automationIssues(extra, []);
    expect(issues).toContain("An automation needs exactly one trigger step");
    expect(issues).toContain("Step key start is used more than once");
  });

  it("rejects unknown endpoints", () => {
    expect(automationIssues(steps, [{ from: "start", to: "nowhere", type: "default" }])).toEqual([
      "Connection ends at unknown step nowhere"
    ]);
    expect(automationIssues(steps, [{ from: "ghost", to: "wait", type: "default" }])).toEqual([
      "Connection starts at unknown step ghost"
    ]);
  });

  it("allows one condition_met and one condition_not_met edge per condition", () => {
    const issues = automationIssues(steps, [
      { from: "check", to: "welcome", type: "condition_met" },
      { from: "check", to: "bye", type: "condition_met" }
    ]);
    expect(issues).toEqual(["Condition check has more than one condition_met connection"]);
  });

  it("rejects branch edges from the wrong step type", () => {
    expect(automationIssues(steps, [{ from: "wait", to: "bye", type: "condition_met" }])[0]).toMatch(/must start at a condition step/);
    expect(automationIssues(steps, [{ from: "check", to: "bye", type: "timeout" }])[0]).toMatch(/wait_for_event/);
  });

  it("rejects a cycle", () => {
    const parsed = automationGraphSchema.safeParse({
      ...graph,
      connections: [...graph.connections, { from: "welcome", to: "wait" }]
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.message)).toContain("Connections form a cycle");
  });
});

describe("evaluate", () => {
  const context = {
    event: { plan: "pro", seats: 5, tags: ["beta", "vip"], note: "", missing: null },
    contact: { email: "ada@example.com", first_name: "Ada" }
  };
  const rule = (field: string, operator: Extract<Rule, { type: "rule" }>["operator"], value?: unknown): Rule => ({
    type: "rule",
    field,
    operator,
    value
  });

  it.each([
    ["eq", "event.plan", "pro", true],
    ["eq", "event.plan", "free", false],
    ["neq", "event.plan", "free", true],
    ["gt", "event.seats", 4, true],
    ["gt", "event.seats", 5, false],
    ["gte", "event.seats", 5, true],
    ["lt", "event.seats", 6, true],
    ["lt", "event.seats", 5, false],
    ["lte", "event.seats", 5, true],
    ["contains", "contact.email", "@example", true],
    ["contains", "event.tags", "vip", true],
    ["contains", "event.tags", "gold", false],
    ["starts_with", "contact.first_name", "Ad", true],
    ["ends_with", "contact.email", ".com", true],
    ["ends_with", "contact.email", ".org", false],
    ["exists", "event.plan", undefined, true],
    ["exists", "event.missing", undefined, false],
    ["exists", "event.nothing.deeper", undefined, false],
    ["is_empty", "event.note", undefined, true],
    ["is_empty", "event.missing", undefined, true],
    ["is_empty", "event.plan", undefined, false]
  ] as const)("%s on %s against %s is %s", (operator, field, value, expected) => {
    expect(evaluate(rule(field, operator, value), context)).toBe(expected);
  });

  it("combines rules with and and or", () => {
    const pro = rule("event.plan", "eq", "pro");
    const free = rule("event.plan", "eq", "free");
    expect(evaluate({ type: "and", rules: [pro, rule("event.seats", "gt", 1)] }, context)).toBe(true);
    expect(evaluate({ type: "and", rules: [pro, free] }, context)).toBe(false);
    expect(evaluate({ type: "or", rules: [free, pro] }, context)).toBe(true);
    expect(evaluate({ type: "or", rules: [free, { type: "and", rules: [free, pro] }] }, context)).toBe(false);
  });
});

describe("event definitions", () => {
  it("rejects reserved names and unknown field types", () => {
    expect(eventSchema.safeParse({ name: "resend:contact.created" }).success).toBe(false);
    expect(eventSchema.safeParse({ name: "dispatch:internal" }).success).toBe(false);
    expect(eventSchema.safeParse({ name: "user.created", schema: { plan: "text" } }).success).toBe(false);
    expect(eventSchema.parse({ name: "user.created", schema: { plan: "string" } }).schema).toEqual({ plan: "string" });
  });

  it("takes contact_id or email but not both", () => {
    expect(eventSendSchema.safeParse({ event: "user.created", email: "a@example.com" }).success).toBe(true);
    expect(eventSendSchema.safeParse({ event: "user.created", contact_id: "contact_1", email: "a@example.com" }).success).toBe(false);
  });

  it("checks payload types against the schema", () => {
    const schema = { plan: "string", seats: "number", trial: "boolean", started: "date" };
    expect(payloadIssues(schema, { plan: "pro", seats: 3, trial: false, started: "2026-10-01T00:00:00Z", extra: 1 })).toEqual([]);
    expect(payloadIssues(schema, {})).toEqual([]);
    expect(payloadIssues(schema, { plan: 1, seats: "3", trial: "no", started: "not a date" })).toEqual([
      "payload.plan must be a string",
      "payload.seats must be a number",
      "payload.trial must be a boolean",
      "payload.started must be a date"
    ]);
    // A field named like a built-in is checked only when the payload has it.
    expect(payloadIssues({ constructor: "string", toString: "number" }, {})).toEqual([]);
    expect(payloadIssues({ constructor: "string" }, { constructor: 1 })).toEqual(["payload.constructor must be a string"]);
  });

  it("reads own properties only when it walks a rule's field", () => {
    const rule = (field: string): Rule => ({ type: "rule", field, operator: "exists" });
    expect(evaluate(rule("event.constructor"), { event: {} })).toBe(false);
    expect(evaluate(rule("event.__proto__"), { event: {} })).toBe(false);
    expect(evaluate(rule("contact.toString"), { contact: { first_name: "Ada" } })).toBe(false);
    expect(evaluate(rule("event.plan"), { event: { plan: "pro" } })).toBe(true);
  });

  it("orders numbers and dates, and is false for anything with no order", () => {
    const rule = (operator: "gt" | "lt" | "gte" | "lte", value: unknown): Rule => ({ type: "rule", field: "event.x", operator, value });
    expect(evaluate(rule("gt", 5), { event: { x: 7 } })).toBe(true);
    expect(evaluate(rule("lte", "7"), { event: { x: 7 } })).toBe(true);
    expect(evaluate(rule("gt", "2025-01-01"), { event: { x: "2026-03-01T00:00:00Z" } })).toBe(true);
    expect(evaluate(rule("lt", "2025-01-01"), { event: { x: "2026-03-01T00:00:00Z" } })).toBe(false);
    for (const empty of [null, "", [], undefined]) {
      expect(evaluate(rule("lt", 5), { event: { x: empty } })).toBe(false);
      expect(evaluate(rule("gte", 0), { event: { x: empty } })).toBe(false);
    }
    expect(evaluate(rule("gt", "2025-01-01"), { event: { x: 7 } })).toBe(false);
  });

  it("refuses a rule nested deeper than ten levels without walking it", () => {
    let deep: unknown = { type: "rule", field: "event.x", operator: "exists" };
    for (let level = 0; level < 5_000; level += 1) deep = { type: "and", rules: [deep] };
    const parsed = automationGraphSchema.safeParse({
      steps: [
        { key: "start", type: "trigger", config: { event_name: "e" } },
        { key: "check", type: "condition", config: deep }
      ],
      connections: [{ from: "start", to: "check" }]
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("Rules can nest at most 10 levels");

    let shallow: unknown = { type: "rule", field: "event.x", operator: "exists" };
    for (let level = 0; level < 8; level += 1) shallow = { type: "or", rules: [shallow] };
    expect(
      automationGraphSchema.safeParse({
        steps: [
          { key: "start", type: "trigger", config: { event_name: "e" } },
          { key: "check", type: "condition", config: shallow }
        ],
        connections: [{ from: "start", to: "check" }]
      }).success
    ).toBe(true);
  });

  it("allows one connection of each type out of a step", () => {
    const steps = normalizeAutomation({
      steps: [
        { key: "t", type: "trigger", config: { event_name: "e" } },
        { key: "a", type: "contact_delete", config: {} },
        { key: "b", type: "contact_delete", config: {} },
        { key: "w", type: "wait_for_event", config: { event_name: "x", timeout: "1 day" } }
      ],
      connections: []
    }).steps;
    expect(automationIssues(steps, [{ from: "t", to: "a", type: "default" }, { from: "t", to: "b", type: "default" }])).toContain(
      "Step t has more than one outgoing connection"
    );
    expect(
      automationIssues(steps, [
        { from: "t", to: "w", type: "default" },
        { from: "w", to: "a", type: "timeout" },
        { from: "w", to: "b", type: "timeout" }
      ])
    ).toContain("Step w has more than one timeout connection");
    expect(
      automationIssues(steps, [
        { from: "t", to: "w", type: "default" },
        { from: "w", to: "a", type: "timeout" },
        { from: "w", to: "b", type: "event_received" }
      ])
    ).toEqual([]);
  });

  it("lowercases the address on an event", () => {
    expect(eventSendSchema.parse({ event: "user.created", email: "Ada@Example.COM" }).email).toBe("ada@example.com");
  });
});
