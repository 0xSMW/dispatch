import {
  automationGraphSchema, automationIssues, eventSchema, payloadIssues, propertySchema,
  templateKind, triggerSchema,
  type Connection, type EventInput, type PropertyInput, type Rule, type SendKind, type Step, type TriggerConfig,
} from "@dispatchmail/core";
import { checkTemplateVariables } from "./check";
import type { LibraryStage, LibraryTemplate } from "./types";

/** Installation must replace this value with the tenant's chosen topic. It is not a topic ID. */
export const installTopic = "{{topic_id}}";

export type Preset = {
  slug: string;
  name: string;
  stage: LibraryStage;
  description: string;
  when: string;
  trigger_config: TriggerConfig;
  reentry: "once" | "every_time";
  events: Array<EventInput & { schema: NonNullable<EventInput["schema"]> }>;
  properties: Array<Pick<PropertyInput, "key" | "type">>;
  steps: Step[];
  connections: Connection[];
  templates: string[];
};

const rule = (field: string, operator: "eq" | "neq" | "within" | "not_within", value: unknown): Rule =>
  ({ type: "rule", field, operator, value });
const step = (key: string, type: Step["type"], config: Step["config"] = {}): Step => ({ key, type, config });
const send = (key: string, template: string, kind: SendKind, subject?: string) =>
  step(key, "send_email", { template, kind, ...(subject ? { subject } : {}) });
const delay = (key: string, duration: string) => step(key, "delay", { duration });
const filter = (key: string, value: Rule, scope: "next" | "following" = "next") =>
  step(key, "filter", { rule: value, scope });
const edge = (from: string, to: string, type: Connection["type"] = "default"): Connection => ({ from, to, type });
const chain = (...keys: string[]): Connection[] => keys.slice(1).map((key, index) => edge(keys[index]!, key));
const activated = { key: "activated", type: "boolean" } as const;
const plan = { key: "plan", type: "string" } as const;

export const presetFreshness: Readonly<Record<string, { field: string; window: string }>> = {
  "newsletter-welcome": { field: "event.received_at", window: "7 days" },
  "onboarding-drip": { field: "contact.created_at", window: "14 days" },
  "invite-to-upgrade": { field: "event.received_at", window: "10 days" },
  "win-back": { field: "event.received_at", window: "14 days" },
  "failed-payment": { field: "event.received_at", window: "10 days" },
  "come-back": { field: "event.received_at", window: "21 days" },
};

const fresh = (slug: string) => {
  const { field, window } = presetFreshness[slug]!;
  return filter("freshness", rule(field, "within", window), "following");
};

export const presets: Preset[] = [
  {
    slug: "newsletter-welcome", name: "Newsletter welcome", stage: "acquisition",
    description: "Welcome a topic subscriber, then suggest the next step based on activation.",
    when: "Start when a contact subscribes to the topic chosen at install. The app sets activated when setup is complete.",
    trigger_config: { type: "topic_subscribed", topic_id: installTopic }, reentry: "once",
    events: [], properties: [activated], templates: ["newsletter-welcome", "feature-tips", "setup-reminder"],
    steps: [
      step("trigger", "trigger", { type: "topic_subscribed", topic_id: installTopic }),
      fresh("newsletter-welcome"), send("welcome", "newsletter-welcome", "marketing"), delay("wait", "3 days"),
      // The shared Branch needs at least two explicit paths plus Otherwise. A Condition
      // expresses the approved true/otherwise split without adding a third path.
      step("activation", "condition", rule("contact.activated", "eq", true) as Step["config"]),
      send("tips", "feature-tips", "marketing"), send("setup", "setup-reminder", "marketing"), step("exit", "exit"),
    ],
    connections: [
      ...chain("trigger", "freshness", "welcome", "wait", "activation"),
      edge("activation", "tips", "condition_met"), edge("activation", "setup", "condition_not_met"),
      edge("tips", "exit"), edge("setup", "exit"),
    ],
  },
  {
    slug: "onboarding-drip", name: "Onboarding drip", stage: "onboarding",
    description: "Welcome a new contact and help them finish setup over five days.",
    when: "Start when a contact is added. The app sets activated to true to stop the reminders.",
    trigger_config: { type: "contact_created" }, reentry: "once",
    events: [], properties: [activated], templates: ["welcome", "setup-reminder", "feature-tips"],
    steps: [
      step("trigger", "trigger", { type: "contact_created" }), fresh("onboarding-drip"),
      step("welcome", "send_email", { template: "welcome", kind: "transactional",
        variable_mapping: { RECIPIENT_NAME: "contact.first_name" } }),
      filter("not_activated", rule("contact.activated", "neq", true), "following"),
      delay("setup_wait", "2 days"), send("setup", "setup-reminder", "marketing"),
      delay("tips_wait", "3 days"), send("tips", "feature-tips", "marketing"), step("exit", "exit"),
    ],
    connections: chain("trigger", "freshness", "welcome", "not_activated", "setup_wait", "setup", "tips_wait", "tips", "exit"),
  },
  {
    slug: "invite-to-upgrade", name: "Invite to upgrade", stage: "retention",
    description: "Offer an upgrade after a free-plan contact reaches a usage limit.",
    when: "Send usage.limit_reached from the app at the limit. Keep plan current so upgraded contacts leave the flow.",
    trigger_config: { type: "event", event_name: "usage.limit_reached" }, reentry: "every_time",
    events: [{ name: "usage.limit_reached", schema: {} }], properties: [plan], templates: ["upgrade-invite"],
    steps: [
      step("trigger", "trigger", { type: "event", event_name: "usage.limit_reached" }), fresh("invite-to-upgrade"),
      filter("free_plan", rule("contact.plan", "eq", "free")), send("invite", "upgrade-invite", "marketing"),
      delay("wait", "4 days"), filter("still_free", rule("contact.plan", "eq", "free")),
      send("reminder", "upgrade-invite", "marketing", "Still need more room in {{{PRODUCT_NAME}}}?"), step("exit", "exit"),
    ],
    connections: chain("trigger", "freshness", "free_plan", "invite", "wait", "still_free", "reminder", "exit"),
  },
  {
    slug: "win-back", name: "Win back", stage: "reengagement",
    description: "Reach out to an inactive contact, then offer a reason to return.",
    when: "Send user.inactive from the app. Update last_active_at on activity; missing dates do not pass the second filter.",
    trigger_config: { type: "event", event_name: "user.inactive" }, reentry: "every_time",
    events: [{ name: "user.inactive", schema: {} }], properties: [{ key: "last_active_at", type: "date" }],
    templates: ["we-miss-you", "come-back-offer"],
    steps: [
      step("trigger", "trigger", { type: "event", event_name: "user.inactive" }), fresh("win-back"),
      send("miss_you", "we-miss-you", "marketing"), delay("wait", "7 days"),
      filter("still_inactive", rule("contact.last_active_at", "not_within", "7 days")),
      send("offer", "come-back-offer", "marketing"), step("exit", "exit"),
    ],
    connections: chain("trigger", "freshness", "miss_you", "wait", "still_inactive", "offer", "exit"),
  },
  {
    slug: "failed-payment", name: "Failed payment", stage: "dunning",
    description: "Follow up on an unpaid invoice and exit when a payment event arrives.",
    when: "Use Stripe invoice events. The billing system must cancel the subscription before the final cancellation notice; this flow does not cancel it.",
    trigger_config: { type: "event", event_name: "stripe.invoice.payment_failed" }, reentry: "every_time",
    events: [
      { name: "stripe.invoice.payment_failed", schema: { AMOUNT: "string", UPDATE_PAYMENT_URL: "string", INVOICE_NUMBER: "string", invoice_id: "string" } },
      { name: "stripe.invoice.paid", schema: { invoice_id: "string" } },
    ],
    properties: [], templates: ["payment-failed", "card-update-reminder", "subscription-canceled"],
    steps: [
      step("trigger", "trigger", { type: "event", event_name: "stripe.invoice.payment_failed" }), fresh("failed-payment"),
      send("failed", "payment-failed", "transactional"),
      step("first_wait", "wait_for_event", { event_name: "stripe.invoice.paid", timeout: "3 days" }),
      send("reminder", "card-update-reminder", "transactional"),
      step("second_wait", "wait_for_event", { event_name: "stripe.invoice.paid", timeout: "4 days" }),
      send("canceled", "subscription-canceled", "transactional"), step("exit", "exit"),
    ],
    connections: [
      ...chain("trigger", "freshness", "failed", "first_wait"),
      edge("first_wait", "exit", "event_received"), edge("first_wait", "reminder", "timeout"),
      edge("reminder", "second_wait"),
      edge("second_wait", "exit", "event_received"), edge("second_wait", "canceled", "timeout"), edge("canceled", "exit"),
    ],
  },
  {
    slug: "come-back", name: "Come back", stage: "reactivation",
    description: "Offer a return path two weeks after a contact's plan changes to canceled.",
    when: "The app changes plan to canceled after cancellation and keeps it current on reactivation.",
    trigger_config: { type: "contact_updated", field: "plan", to: "canceled" }, reentry: "once",
    events: [], properties: [plan], templates: ["come-back-offer"],
    steps: [
      step("trigger", "trigger", { type: "contact_updated", field: "plan", to: "canceled" }), fresh("come-back"),
      delay("wait", "14 days"), filter("still_canceled", rule("contact.plan", "eq", "canceled")),
      send("offer", "come-back-offer", "marketing"), step("exit", "exit"),
    ],
    connections: chain("trigger", "freshness", "wait", "still_canceled", "offer", "exit"),
  },
];

export type PresetValidation = {
  /** An actual mapped trigger payload, never a template preview/sample or a list of names. */
  triggerData?: Record<string, unknown>;
};

function includesFreshness(value: Rule, field: string, window: string): boolean {
  if (value.type === "rule") return value.field === field && value.operator === "within" && value.value === window;
  // An OR containing a freshness test does not guarantee freshness.
  return value.type === "and" && value.rules.some((child) => includesFreshness(child, field, window));
}

/** Pure pre-install checks. This does not resolve tenant sender/topic/template IDs. */
export function presetIssues(preset: Preset, templates: readonly LibraryTemplate[], validation: PresetValidation = {}): string[] {
  const issues: string[] = [];
  const fail = (message: string) => issues.push(`${preset.slug}: ${message}`);
  const parsed = automationGraphSchema.safeParse({ steps: preset.steps, connections: preset.connections });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) fail(issue.message);
    return issues;
  }
  const graph = parsed.data;
  for (const issue of automationIssues(graph.steps, graph.connections)) fail(issue);
  const trigger = triggerSchema.safeParse(preset.trigger_config);
  if (!trigger.success || JSON.stringify(trigger.data) !== JSON.stringify(graph.trigger_config)) fail("Trigger metadata does not match the graph");
  for (const event of preset.events) if (!eventSchema.safeParse(event).success) fail(`Invalid event definition ${event.name}`);
  for (const property of preset.properties) if (!propertySchema.safeParse(property).success) fail(`Invalid property ${property.key}`);
  const config = preset.trigger_config;
  const event = config.type === "event"
    ? preset.events.find((entry) => entry.name === config.event_name) : undefined;
  if (config.type === "event" && !event) fail("Trigger event has no declared schema");

  // Core event schemas type-check present values but do not require them. A declaration
  // alone therefore cannot prove that a required template variable will exist.
  const supplied = ["EMAIL", "contact.email"];
  if (event && validation.triggerData) {
    for (const issue of payloadIssues(event.schema, validation.triggerData)) fail(issue);
    for (const [key, type] of Object.entries(event.schema)) {
      const value = validation.triggerData[key];
      if (value !== undefined && value !== null && payloadIssues({ [key]: type }, { [key]: value }).length === 0) {
        supplied.push(key, `event.${key}`);
      }
    }
  }

  const used = new Set<string>();
  for (const node of graph.steps) {
    if (node.type !== "send_email") continue;
    const config = node.config as { kind: SendKind; subject?: string; template: { id: string } };
    used.add(config.template.id);
    const template = templates.find((item) => item.slug === config.template.id);
    if (!template) { fail(`${node.key}: unknown template ${config.template.id}`); continue; }
    if (template.kind !== config.kind || templateKind({ html: template.html, text: template.text }) === "marketing" && config.kind !== "marketing") {
      fail(`${node.key}: ${config.kind} step uses ${template.kind} template ${template.slug} with incompatible send intent`);
    }
    for (const issue of checkTemplateVariables({ ...template, subject: config.subject ?? template.subject }, supplied)) fail(`${node.key}: ${issue}`);
  }
  for (const slug of used) if (!preset.templates.includes(slug)) fail(`Used template ${slug} is not declared`);
  for (const slug of preset.templates) if (!used.has(slug)) fail(`Declared template ${slug} is not used`);

  const freshness = presetFreshness[preset.slug];
  if (freshness) {
    const guards = new Set(graph.steps.filter((node) => node.type === "filter" && node.config.scope === "following"
      && includesFreshness(node.config.rule as Rule, freshness.field, freshness.window)).map((node) => node.key));
    const pending: Array<[string, boolean]> = [[graph.steps.find((node) => node.type === "trigger")!.key, false]];
    const visited = new Set<string>();
    const reached = new Set<string>();
    let unguarded = guards.size === 0;
    while (pending.length) {
      const [key, hadGuard] = pending.pop()!;
      const guarded = hadGuard || guards.has(key);
      const identity = `${key}:${guarded}`;
      if (visited.has(identity)) continue;
      visited.add(identity);
      reached.add(key);
      if (graph.steps.find((node) => node.key === key)?.type === "send_email" && !guarded) unguarded = true;
      for (const connection of graph.connections.filter((connection) => connection.from === key)) pending.push([connection.to, guarded]);
    }
    if (unguarded) fail(`Every send needs a following freshness filter: ${freshness.field} within ${freshness.window}`);
    for (const node of graph.steps) if (!reached.has(node.key)) fail(`Unreachable step ${node.key}`);
  }
  return issues;
}
