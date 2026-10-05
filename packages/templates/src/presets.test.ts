import { automationGraphSchema, automationIssues, durationSeconds, evaluate, payloadIssues, stepConfigs, type Rule } from "@dispatchmail/core";
import { walker } from "../../db/src/automations";
import { mapStripe } from "../../db/src/inbound/stripe";
import { describe, expect, it } from "vitest";
import library from "../library.json";
import { installTopic, presetFreshness, presetIssues, presets, type Preset } from "./presets";
import type { LibraryTemplate } from "./types";

const templates = library.templates as LibraryTemplate[];
const preset = (slug: string): Preset => structuredClone(presets.find((item) => item.slug === slug)!);
const paymentPayload = {
  id: "evt_failed", type: "invoice.payment_failed",
  data: { object: { id: "in_1", customer: "cus_1", customer_email: "ada@example.com",
    amount_due: 4900, currency: "usd", hosted_invoice_url: "https://billing.example/in_1", number: "INV-1" } },
};
async function mappedPayment() {
  const mapped = await mapStripe(paymentPayload);
  if (mapped.action !== "upsert") throw new Error("Stripe fixture was not mapped");
  return mapped.event.data;
}
const graph = (item: Preset) => automationGraphSchema.parse({ steps: item.steps, connections: item.connections });

describe("pure lifecycle preset graphs", () => {
  it("maps the existing welcome template's recipient name from fresh contact state", () => {
    expect(preset("onboarding-drip").steps.find((step) => step.key === "welcome")!.config)
      .toMatchObject({ template: "welcome", kind: "transactional", variable_mapping: { RECIPIENT_NAME: "contact.first_name" } });
  });
  it("contains exactly the six approved conventional slugs and stages", () => {
    expect(presets.map(({ slug, stage }) => [slug, stage])).toEqual([
      ["newsletter-welcome", "acquisition"], ["onboarding-drip", "onboarding"],
      ["invite-to-upgrade", "retention"], ["win-back", "reengagement"],
      ["failed-payment", "dunning"], ["come-back", "reactivation"],
    ]);
    for (const item of presets) {
      expect(item.name).not.toBe("");
      expect(item.description).not.toBe("");
      expect(item.when).not.toBe("");
      expect(item.reentry).toBe(item.trigger_config.type === "event" ? "every_time" : "once");
      expect(graph(item).trigger_config).toEqual(item.trigger_config);
      expect(automationIssues(graph(item).steps, graph(item).connections)).toEqual([]);
    }
  });

  it.each(presets.filter((item) => item.slug !== "failed-payment"))("$slug validates from recipient context and real fallbacks without preview data", (item) => {
    expect(presetIssues(item, templates.map((template) => ({ ...template, sample: {} })))).toEqual([]);
  });

  it("proves every required payment variable using the actual Stripe adapter output", async () => {
    const data = await mappedPayment();
    expect(data).toMatchObject({ AMOUNT: "$49.00", UPDATE_PAYMENT_URL: "https://billing.example/in_1", INVOICE_NUMBER: "INV-1", invoice_id: "in_1" });
    expect(presetIssues(preset("failed-payment"), templates, { triggerData: data })).toEqual([]);
    const absent = await mapStripe({ ...paymentPayload, data: { object: { customer_email: "ada@example.com" } } });
    expect(absent.action).toBe("upsert");
    if (absent.action === "upsert") {
      expect(absent.event.data).toMatchObject({ AMOUNT: "", UPDATE_PAYMENT_URL: "", INVOICE_NUMBER: "", invoice_id: "" });
      expect(presetIssues(preset("failed-payment"), templates, { triggerData: absent.event.data })).toEqual([]);
    }
  });

  it("does not mistake optional event schema declarations for guaranteed values", () => {
    expect(payloadIssues({ AMOUNT: "string", UPDATE_PAYMENT_URL: "string" }, {})).toEqual([]);
    const issues = presetIssues(preset("failed-payment"), templates);
    expect(issues.some((issue) => issue.includes("required variable AMOUNT"))).toBe(true);
    expect(issues.some((issue) => issue.includes("required variable UPDATE_PAYMENT_URL"))).toBe(true);
  });

  it("keeps topic resolution explicit and does not invent tenant sender/topic IDs", () => {
    expect(preset("newsletter-welcome").trigger_config).toEqual({ type: "topic_subscribed", topic_id: installTopic });
    for (const item of presets) for (const node of item.steps.filter((node) => node.type === "send_email")) {
      expect(node.config).not.toHaveProperty("from");
      expect(node.config).not.toHaveProperty("topic_id");
      expect(node.config).not.toHaveProperty("variables");
    }
  });

  it("uses a binary Condition for the newsletter's exact true/otherwise split", () => {
    const item = preset("newsletter-welcome");
    const flow = walker(graph(item));
    expect(flow.next("welcome", "default")).toBe("wait");
    expect(flow.next("wait", "default")).toBe("activation");
    expect(flow.next("activation", "condition_met")).toBe("tips");
    expect(flow.next("activation", "condition_not_met")).toBe("setup");
    const condition = item.steps.find((node) => node.key === "activation")!.config as Rule;
    expect(evaluate(condition, { contact: { activated: true } })).toBe(true);
    for (const activated of [false, null, undefined]) expect(evaluate(condition, { contact: { activated } })).toBe(false);
    expect(item.steps.find((node) => node.key === "wait")!.config.duration).toBe("3 days");
  });

  it("welcomes transactionally before guarding all remaining onboarding sends", () => {
    const item = preset("onboarding-drip");
    expect(item.steps.find((node) => node.key === "welcome")!.config).toMatchObject({ template: "welcome", kind: "transactional" });
    const guard = item.steps.find((node) => node.key === "not_activated")!;
    expect(guard.config.scope).toBe("following");
    expect(evaluate(guard.config.rule as Rule, { contact: { activated: true } })).toBe(false);
    expect(evaluate(guard.config.rule as Rule, { contact: {} })).toBe(true);
    const flow = walker(graph(item));
    expect(flow.next("welcome", "default")).toBe("not_activated");
    expect(flow.next("not_activated", "default")).toBe("setup_wait");
    expect(item.steps.filter((node) => node.type === "delay").map((node) => node.config.duration)).toEqual(["2 days", "3 days"]);
  });

  it("checks the free plan twice and changes only the second upgrade subject", () => {
    const item = preset("invite-to-upgrade");
    for (const key of ["free_plan", "still_free"]) {
      const value = item.steps.find((node) => node.key === key)!.config.rule as Rule;
      expect(evaluate(value, { contact: { plan: "free" } })).toBe(true);
      expect(evaluate(value, { contact: { plan: "pro" } })).toBe(false);
    }
    const sends = item.steps.filter((node) => node.type === "send_email");
    expect(sends.map((node) => node.config.template)).toEqual(["upgrade-invite", "upgrade-invite"]);
    expect(sends[0]!.config.subject).toBeUndefined();
    expect(sends[1]!.config.subject).not.toBe(templates.find((item) => item.slug === "upgrade-invite")!.subject);
    expect(item.steps.find((node) => node.key === "wait")!.config.duration).toBe("4 days");
  });

  it("retains missing/invalid date behavior rather than inventing inactive defaults", () => {
    const item = preset("win-back");
    const value = item.steps.find((node) => node.key === "still_inactive")!.config.rule as Rule;
    const now = Date.parse("2026-10-04T00:00:00Z");
    expect(evaluate(value, { contact: { last_active_at: "2026-09-26T00:00:00Z" } }, now)).toBe(true);
    for (const last_active_at of [undefined, "invalid", "2026-10-01T00:00:00Z"]) {
      expect(evaluate(value, { contact: { last_active_at } }, now)).toBe(false);
    }
    expect(item.properties).toEqual([{ key: "last_active_at", type: "date" }]);
    expect(item.steps.find((node) => node.key === "wait")!.config.duration).toBe("7 days");
  });

  it("exits either paid path and follows both payment timeout paths with no cancellation mutation", () => {
    const item = preset("failed-payment");
    const flow = walker(graph(item));
    expect(flow.next("first_wait", "event_received")).toBe("exit");
    expect(flow.next("first_wait", "timeout")).toBe("reminder");
    expect(flow.next("reminder", "default")).toBe("second_wait");
    expect(flow.next("second_wait", "event_received")).toBe("exit");
    expect(flow.next("second_wait", "timeout")).toBe("canceled");
    expect(item.steps.filter((node) => node.type === "wait_for_event").map((node) => node.config)).toEqual([
      { event_name: "stripe.invoice.paid", timeout: "3 days" },
      { event_name: "stripe.invoice.paid", timeout: "4 days" },
    ]);
    expect(item.steps.filter((node) => node.type === "send_email").every((node) => node.config.kind === "transactional")).toBe(true);
    expect(item.steps.some((node) => node.type === "contact_update")).toBe(false);
  });

  it("waits fourteen days and rechecks the canceled plan", () => {
    const item = preset("come-back");
    expect(item.trigger_config).toEqual({ type: "contact_updated", field: "plan", to: "canceled" });
    expect(item.steps.find((node) => node.key === "wait")!.config.duration).toBe("14 days");
    const value = item.steps.find((node) => node.key === "still_canceled")!.config.rule as Rule;
    expect(evaluate(value, { contact: { plan: "canceled" } })).toBe(true);
    expect(evaluate(value, { contact: { plan: "pro" } })).toBe(false);
  });

  it.each(presets)("$slug has its exact following freshness window before any sends", (item) => {
    const { field, window } = presetFreshness[item.slug]!;
    const guard = item.steps.find((node) => node.key === "freshness")!;
    expect(guard.config).toEqual({
      scope: "following", rule: { type: "rule", field, operator: "within", value: window },
    });
    const now = Date.parse("2026-10-04T00:00:00Z");
    const [root, key] = field.split(".");
    const context = (offset: number) => ({ [root!]: { [key!]: new Date(now - offset).toISOString() } });
    expect(evaluate(guard.config.rule as Rule, context(durationSeconds(window) * 1000), now)).toBe(true);
    expect(evaluate(guard.config.rule as Rule, context(durationSeconds(window) * 1000 + 1), now)).toBe(false);
    expect(evaluate(guard.config.rule as Rule, {}, now)).toBe(false);
  });
});

describe("failing preset fixtures", () => {
  it("exposes the shared Branch minimum rather than relaxing it for a one-path preset", () => {
    const result = stepConfigs.branch.safeParse({
      paths: [{ key: "activated", label: "Activated", rule: { type: "rule", field: "contact.activated", operator: "eq", value: true } }],
    });
    expect(result.success).toBe(false);
  });

  it.each(presets)("$slug fails when its following freshness test is removed", async (source) => {
    const item = structuredClone(source);
    item.steps.find((node) => node.key === "freshness")!.config.rule = { type: "rule", field: "contact.email", operator: "exists" };
    expect(presetIssues(item, templates, { triggerData: await mappedPayment() }).join(" ")).toContain("Every send needs a following freshness filter");
  });

  it("rejects an invalid graph using core graph checks", () => {
    const item = preset("onboarding-drip");
    item.connections.push({ from: "exit", to: "trigger", type: "default" });
    expect(presetIssues(item, templates)).toEqual(expect.arrayContaining([
      "onboarding-drip: Exit exit cannot have outgoing connections", "onboarding-drip: Connections form a cycle",
    ]));
  });

  it("rejects an invalid rule using core config validation", () => {
    const item = preset("come-back");
    item.steps.find((node) => node.key === "freshness")!.config.rule = { type: "rule", field: "event.received_at", operator: "within", value: "forever" };
    expect(presetIssues(item, templates).join(" ")).toContain("Date windows need a positive duration");
  });

  it("rejects a missing template", () => {
    expect(presetIssues(preset("onboarding-drip"), templates.filter((item) => item.slug !== "setup-reminder")).join(" ")).toContain("unknown template setup-reminder");
  });

  it("rejects a required name even when its preview sample supplies it", () => {
    const changed = structuredClone(templates);
    const item = changed.find((item) => item.slug === "setup-reminder")!;
    item.variables.push({ key: "FIRST_NAME", type: "string", fallback_value: null });
    item.subject = "Hi {{{FIRST_NAME}}}";
    item.sample.FIRST_NAME = "Preview only";
    expect(presetIssues(preset("onboarding-drip"), changed).join(" ")).toContain("required variable FIRST_NAME");
  });

  it("rejects a required Stripe variable removed from the actual payload or schema", async () => {
    const data = await mappedPayment();
    delete data.UPDATE_PAYMENT_URL;
    expect(presetIssues(preset("failed-payment"), templates, { triggerData: data }).join(" ")).toContain("required variable UPDATE_PAYMENT_URL");
    const item = preset("failed-payment");
    delete item.events[0]!.schema.AMOUNT;
    expect(presetIssues(item, templates, { triggerData: await mappedPayment() }).join(" ")).toContain("required variable AMOUNT");
  });

  it("rejects a mapped payload with the wrong type", async () => {
    expect(presetIssues(preset("failed-payment"), templates, { triggerData: { ...await mappedPayment(), AMOUNT: 49 } }).join(" ")).toContain("payload.AMOUNT must be a string");
  });

  it.each(["marketing", "transactional"] as const)("rejects a %s kind mismatch", (kind) => {
    const item = preset("onboarding-drip");
    item.steps.find((node) => node.key === (kind === "marketing" ? "welcome" : "setup"))!.config.kind = kind;
    expect(presetIssues(item, templates).join(" ")).toContain("incompatible send intent");
  });

  it.each(["removed", "next", "wrong_window", "bypassed", "or"] as const)("rejects %s freshness", (mutation) => {
    const item = preset("come-back");
    const guard = item.steps.find((node) => node.key === "freshness")!;
    if (mutation === "removed") guard.config.rule = { type: "rule", field: "contact.plan", operator: "eq", value: "canceled" };
    if (mutation === "next") guard.config.scope = "next";
    if (mutation === "wrong_window") (guard.config.rule as { value: string }).value = "22 days";
    if (mutation === "bypassed") item.connections.find((connection) => connection.from === "trigger")!.to = "wait";
    if (mutation === "or") guard.config.rule = { type: "or", rules: [guard.config.rule, { type: "rule", field: "contact.plan", operator: "eq", value: "canceled" }] };
    expect(presetIssues(item, templates).join(" ")).toContain("Every send needs a following freshness filter");
  });

  it("rejects mismatched trigger metadata and undeclared/unused template references", () => {
    const item = preset("come-back");
    item.trigger_config = { type: "contact_created" };
    item.templates = ["setup-reminder"];
    const issues = presetIssues(item, templates).join(" ");
    expect(issues).toContain("Trigger metadata does not match");
    expect(issues).toContain("Used template come-back-offer is not declared");
    expect(issues).toContain("Declared template setup-reminder is not used");
  });
});
