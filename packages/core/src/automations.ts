import { z } from "zod";
import { address, addresses, templateRef } from "./addresses.js";
import { automationRuleSchema, durationSeconds } from "./rules.js";
import { splitSchema } from "./splits.js";

export const maxDelaySeconds = 30 * 86_400;

function checkDuration(value: string, ctx: z.RefinementCtx, path: string) {
  let seconds: number;
  try {
    seconds = durationSeconds(value);
  } catch {
    ctx.addIssue({ code: "custom", message: `Invalid duration: ${value}`, path: [path] });
    return;
  }
  if (seconds < 1 || seconds > maxDelaySeconds) ctx.addIssue({ code: "custom", message: `${path} must be between 1 second and 30 days`, path: [path] });
}

const storedEventName = z.string().min(1).max(120);
const eventName = storedEventName.refine((name) => !name.startsWith("@"), "Event names cannot start with @");
const stepEmail = z.string().email().optional();

export const triggerTypes = ["event", "contact_created", "contact_updated", "topic_subscribed", "segment_added"] as const;
const transitionValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const triggerUnion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event_name: eventName }),
  z.object({ type: z.literal("contact_created") }),
  z.object({
    type: z.literal("contact_updated"),
    field: z.string().regex(/^[A-Za-z0-9_]+$/, "Use a contact field without the contact. prefix").optional(),
    from: transitionValue.optional(),
    to: transitionValue.optional()
  }),
  z.object({ type: z.literal("topic_subscribed"), topic_id: z.string().min(1) }),
  z.object({ type: z.literal("segment_added"), segment_id: z.string().min(1) })
]).superRefine((config, ctx) => {
  if (config.type === "contact_updated" && !config.field && (config.from !== undefined || config.to !== undefined)) {
    ctx.addIssue({ code: "custom", message: "A field is required for from or to", path: ["field"] });
  }
});
export const triggerSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && !("type" in value) && "event_name" in value) return { ...value, type: "event" };
  return value;
}, triggerUnion);
export type TriggerConfig = z.infer<typeof triggerSchema>;

export function triggerKey(config: TriggerConfig): string {
  switch (config.type) {
    case "event": return config.event_name;
    case "contact_created": return "@contact.created";
    case "contact_updated": return "@contact.updated";
    case "topic_subscribed": return `@topic.subscribed:${config.topic_id}`;
    case "segment_added": return `@segment.added:${config.segment_id}`;
  }
}

export const stepConfigs = {
  split: splitSchema,
  trigger: triggerSchema,
  // Ordinary sends still use topic_id alone. Steps store intent even before a topic is chosen.
  send_email: z
    .object({
      kind: z.enum(["transactional", "marketing"]).optional(),
      from: address.optional(),
      to: stepEmail,
      topic_id: z.string().min(1).optional(),
      subject: z.string().min(1).max(998).optional(),
      reply_to: addresses.optional(),
      template: templateRef,
      variables: z.record(z.unknown()).optional(),
      variable_mapping: z.record(z.string().regex(/^(event|contact)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, "Use an event or contact field")).optional()
    })
    .superRefine((value, ctx) => {
      if (value.kind === "transactional" && value.topic_id) {
        ctx.addIssue({ code: "custom", message: "Transactional steps cannot have a topic", path: ["topic_id"] });
      }
    })
    .transform(({ template, variables, kind, ...rest }) => ({
      ...rest, kind: kind ?? (rest.topic_id ? "marketing" : "transactional"),
      template: { id: template.id, variables: { ...variables, ...template.variables } }
    })),
  delay: z
    .object({ duration: z.string().min(1).max(60).optional(), seconds: z.number().int().optional() })
    .transform((value, ctx) => {
      const duration = value.duration ?? (value.seconds === undefined ? undefined : `${value.seconds} seconds`);
      if (!duration) {
        ctx.addIssue({ code: "custom", message: "duration is required", path: ["duration"] });
        return z.NEVER;
      }
      checkDuration(duration, ctx, "duration");
      return { duration };
    }),
  wait_for_event: z
    .object({
      event_name: eventName.optional(),
      event: eventName.optional(),
      timeout: z.string().min(1).max(60).optional(),
      timeout_seconds: z.number().int().optional(),
      filter_rule: automationRuleSchema.optional()
    })
    .transform((value, ctx) => {
      const name = value.event_name ?? value.event;
      if (!name) {
        ctx.addIssue({ code: "custom", message: "event_name is required", path: ["event_name"] });
        return z.NEVER;
      }
      const timeout = value.timeout ?? (value.timeout_seconds === undefined ? undefined : `${value.timeout_seconds} seconds`);
      if (timeout) checkDuration(timeout, ctx, "timeout");
      return { event_name: name, ...(timeout ? { timeout } : {}), ...(value.filter_rule ? { filter_rule: value.filter_rule } : {}) };
    }),
  condition: automationRuleSchema,
  exit: z.object({}).strict(),
  filter: z.object({ rule: automationRuleSchema, scope: z.enum(["next", "following"]) }),
  branch: z.object({
    paths: z.array(z.object({
      key: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/).refine((key) => key !== "otherwise", "otherwise is reserved"),
      label: z.string().trim().min(1).max(120),
      rule: automationRuleSchema
    })).min(2).max(10)
  }).superRefine(({ paths }, ctx) => {
    const keys = new Set<string>();
    paths.forEach((path, index) => {
      if (keys.has(path.key)) ctx.addIssue({ code: "custom", message: "Path keys must be unique", path: ["paths", index, "key"] });
      keys.add(path.key);
    });
  }),
  add_to_segment: z.object({ segment_id: z.string().min(1), email: stepEmail }),
  contact_update: z.object({
    first_name: z.string().max(200).optional(),
    last_name: z.string().max(200).optional(),
    unsubscribed: z.boolean().optional(),
    properties: z.record(z.unknown()).optional(),
    email: stepEmail
  }),
  contact_delete: z.object({ email: stepEmail })
};
export type StepConfig<T extends StepType> = z.infer<(typeof stepConfigs)[T]>;

export const stepTypes = ["trigger", "send_email", "delay", "wait_for_event", "condition", "filter", "branch", "split", "exit", "add_to_segment", "contact_update", "contact_delete"] as const;
export type StepType = (typeof stepTypes)[number];

export const stepSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/, "key must be 1 to 60 letters, digits, underscores, or dashes"),
  type: z.enum(stepTypes),
  config: z.record(z.unknown()).default({})
});
export type Step = z.infer<typeof stepSchema>;
export type AutomationStep = Step;

export const connectionTypes = ["default", "condition_met", "condition_not_met", "timeout", "event_received", "branch", "variant"] as const;

export const connectionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(connectionTypes).default("default"),
  path: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/).optional()
});
export type Connection = z.infer<typeof connectionSchema>;

const legacyTypes: Record<string, StepType> = { update_contact: "contact_update", wait: "wait_for_event" };

function prefixIssues(error: z.ZodError, prefix: Array<string | number>) {
  return error.issues.map((issue) => ({ ...issue, path: [...prefix, ...issue.path] }));
}

// Accepts the old linear form { trigger, steps: [{ type, ...fields }] } and the graph form
// { steps: [{ key, type, config }], connections }, and returns the graph form with parsed configs.
export function normalizeAutomation(input: { trigger?: string | null; steps: Array<Record<string, unknown>>; connections?: unknown[] | null }, stored = false) {
  const keyed = input.steps.length > 0 && input.steps.every((step) => "key" in step);
  const raw = keyed
    ? input.steps
    : [
        { key: "trigger", type: "trigger", config: { event_name: input.trigger ?? undefined } },
        ...input.steps.map(({ type, ...config }, index) => ({ key: `step_${index + 1}`, type: legacyTypes[String(type)] ?? type, config }))
      ];
  const shaped = z.array(stepSchema).safeParse(raw);
  if (!shaped.success) throw new z.ZodError(prefixIssues(shaped.error, ["steps"]));

  const issues: z.ZodIssue[] = [];
  const steps: Step[] = shaped.data.map((step, index) => {
    // Existing event automations retain their namespace, including old @ names.
    if (stored && step.type === "trigger" && (!step.config.type || step.config.type === "event")) {
      const name = storedEventName.safeParse(step.config.event_name);
      if (name.success) return { ...step, config: { type: "event", event_name: name.data } };
    }
    if (stored && step.type === "wait_for_event" && String(step.config.event_name ?? step.config.event).startsWith("@")) {
      const name = storedEventName.safeParse(step.config.event_name ?? step.config.event);
      const config = stepConfigs.wait_for_event.safeParse({ ...step.config, event_name: "legacy", event: undefined });
      if (name.success && config.success) return { ...step, config: { ...config.data, event_name: name.data } };
      if (!name.success) issues.push(...prefixIssues(name.error, ["steps", index, "config", "event_name"]));
      if (!config.success) issues.push(...prefixIssues(config.error, ["steps", index, "config"]));
      return step;
    }
    const config = stepConfigs[step.type].safeParse(step.config);
    if (config.success) return { ...step, config: config.data as Record<string, unknown> };
    issues.push(...prefixIssues(config.error, ["steps", index, "config"]));
    return step;
  });
  if (issues.length) throw new z.ZodError(issues);

  if (!keyed) {
    const connections: Connection[] = steps.slice(1).map((step, index) => ({ from: steps[index]!.key, to: step.key, type: "default" }));
    return { steps, connections };
  }
  const connections = z.array(connectionSchema).safeParse(input.connections ?? []);
  if (!connections.success) throw new z.ZodError(prefixIssues(connections.error, ["connections"]));
  return { steps, connections: connections.data };
}

export function automationIssues(steps: Step[], connections: Connection[]) {
  const issues: string[] = [];
  if (steps.filter((step) => step.type === "trigger").length !== 1) issues.push("An automation needs exactly one trigger step");
  const byKey = new Map<string, Step>();
  for (const step of steps) {
    if (byKey.has(step.key)) issues.push(`Step key ${step.key} is used more than once`);
    byKey.set(step.key, step);
  }

  const edges = new Map<string, string[]>();
  const branches = new Map<string, number>();
  for (const connection of connections) {
    const from = byKey.get(connection.from);
    if (!from) issues.push(`Connection starts at unknown step ${connection.from}`);
    if (!byKey.has(connection.to)) issues.push(`Connection ends at unknown step ${connection.to}`);
    if (!from || !byKey.has(connection.to)) continue;
    if (from.type === "exit") issues.push(`Exit ${from.key} cannot have outgoing connections`);
    if (connection.type === "variant") {
      if (from.type !== "split") issues.push(`A variant connection must start at a split step, not ${from.key}`);
      else if (!connection.path || !(from.config as StepConfig<"split">).variants.some((variant) => variant.key === connection.path)) {
        issues.push(`Split ${from.key} has an unknown variant ${connection.path ?? ""}`);
      }
    } else if (connection.type === "branch") {
      if (from.type !== "branch") issues.push(`A branch connection must start at a branch step, not ${from.key}`);
      else if (!connection.path || ![...(from.config as StepConfig<"branch">).paths.map((path) => path.key), "otherwise"].includes(connection.path)) {
        issues.push(`Branch ${from.key} has an unknown path ${connection.path ?? ""}`);
      }
    } else {
      if (connection.path !== undefined) issues.push(`Only branch or variant connections can have a path`);
      if (from.type === "branch") issues.push(`Branch ${from.key} must use branch connections`);
    }
    if (from.type === "split" && connection.type !== "variant") issues.push(`Split ${from.key} must use variant connections`);
    if (from.type === "filter" && connection.type !== "default") issues.push(`Filter ${from.key} can only have a default connection`);
    if ((connection.type === "condition_met" || connection.type === "condition_not_met") && from.type !== "condition") {
      issues.push(`A ${connection.type} connection must start at a condition step, not ${from.key}`);
    }
    if ((connection.type === "timeout" || connection.type === "event_received") && from.type !== "wait_for_event") {
      issues.push(`A ${connection.type} connection must start at a wait_for_event step, not ${from.key}`);
    }
    // A run follows one edge of each type out of a step. A second one would never be taken.
    const branch = `${connection.from}:${connection.type}:${connection.path ?? ""}`;
    branches.set(branch, (branches.get(branch) ?? 0) + 1);
    if (branches.get(branch) === 2) {
      issues.push(
        connection.type === "default"
          ? `Step ${connection.from} has more than one outgoing connection`
          : `${from.type === "condition" ? "Condition" : "Step"} ${connection.from} has more than one ${connection.type} connection`,
      );
    }
    edges.set(connection.from, [...(edges.get(connection.from) ?? []), connection.to]);
  }

  for (const step of steps.filter((step) => step.type === "branch")) {
    for (const path of [...(step.config as StepConfig<"branch">).paths.map((path) => path.key), "otherwise"]) {
      if (branches.get(`${step.key}:branch:${path}`) !== 1) issues.push(`Branch ${step.key} needs exactly one connection for path ${path}`);
    }
  }
  for (const step of steps.filter((step) => step.type === "split")) {
    for (const variant of (step.config as StepConfig<"split">).variants) {
      if (branches.get(`${step.key}:variant:${variant.key}`) !== 1) issues.push(`Split ${step.key} needs exactly one connection for variant ${variant.key}`);
    }
  }

  const state = new Map<string, "open" | "closed">();
  const visit = (key: string): boolean => {
    if (state.get(key) === "open") return true;
    if (state.get(key) === "closed") return false;
    state.set(key, "open");
    const cyclic = (edges.get(key) ?? []).some(visit);
    state.set(key, "closed");
    return cyclic;
  };
  if ([...byKey.keys()].some(visit)) issues.push("Connections form a cycle");
  return issues;
}

const graphFields = {
  trigger: eventName.optional(),
  steps: z.array(z.record(z.unknown())).min(1).max(100),
  connections: z.array(z.unknown()).max(200).optional()
};

function toGraph(input: { trigger?: string; steps: Array<Record<string, unknown>>; connections?: unknown[] }, ctx: z.RefinementCtx) {
  try {
    const graph = normalizeAutomation(input);
    const issues = automationIssues(graph.steps, graph.connections);
    for (const message of issues) ctx.addIssue({ code: "custom", message, path: ["connections"] });
    if (issues.length) return z.NEVER;
    const trigger_config = graph.steps.find((step) => step.type === "trigger")!.config as TriggerConfig;
    return { ...graph, trigger: triggerKey(trigger_config), trigger_type: trigger_config.type, trigger_config };
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    for (const issue of error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    return z.NEVER;
  }
}

export const automationGraphSchema = z.object(graphFields).transform(toGraph);

const automationStatus = z.enum(["enabled", "disabled"]);

export const automationSchema = z
  .object({ name: z.string().min(1).max(120), status: automationStatus.optional(), enabled: z.boolean().optional(), reentry: z.enum(["once", "every_time"]).optional(), ...graphFields })
  .transform(({ name, status, enabled, reentry, ...graph }, ctx) => {
    const parsed = toGraph(graph, ctx);
    if (parsed === z.NEVER) return z.NEVER;
    return { name, enabled: status ? status === "enabled" : (enabled ?? false), ...parsed,
      reentry: reentry ?? (parsed.trigger_type === "event" ? "every_time" : "once") };
  });
export type AutomationInput = z.input<typeof automationSchema>;
export const automationInstallSchema = z.object({
  name: automationSchema.innerType().shape.name.optional(),
  from: address,
  topic_id: z.string().min(1).optional(),
});

export const automationUpdateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    status: z.enum(["enabled", "paused", "disabled"]).optional(),
    enabled: z.boolean().optional(),
    reentry: z.enum(["once", "every_time"]).optional(),
    expected_version: z.number().int().min(0).optional(),
    trigger: graphFields.trigger,
    steps: graphFields.steps.optional(),
    connections: graphFields.connections
  })
  .transform(({ status, enabled, ...rest }) => ({
    ...rest, status: status ?? (enabled === undefined ? undefined : enabled ? "enabled" : "disabled"),
    enabled: status ? status !== "disabled" : enabled
  }));
export type AutomationUpdateInput = z.input<typeof automationUpdateSchema>;
export const automationStopSchema = z.object({ reset_reentry: z.boolean().default(false) }).strict();

export const eventFieldTypes = ["string", "number", "boolean", "date"] as const;

const definedEventName = eventName.refine(
  (name) => !/^(resend|dispatch):/i.test(name),
  "Event names cannot start with resend: or dispatch:"
);

export const eventSchema = z.object({
  name: definedEventName,
  schema: z.record(z.string().min(1).max(100), z.enum(eventFieldTypes)).default({})
});
export type EventInput = z.input<typeof eventSchema>;

export const eventUpdateSchema = eventSchema.pick({ schema: true }).required();

export const eventSendSchema = z
  .object({
    event: eventName,
    contact_id: z.string().min(1).optional(),
    email: z.string().email().transform((value) => value.toLowerCase()).optional(),
    payload: z.record(z.unknown()).default({})
  })
  .refine((value) => !(value.contact_id && value.email), { message: "Use contact_id or email, not both", path: ["contact_id"] });
export type EventSendInput = z.input<typeof eventSendSchema>;

// Returns one message per payload field whose type does not match the event definition.
export function payloadIssues(schema: Record<string, string>, payload: Record<string, unknown>) {
  const issues: string[] = [];
  for (const [field, type] of Object.entries(schema)) {
    const value = Object.hasOwn(payload, field) ? payload[field] : undefined;
    if (value === undefined || value === null) continue;
    const valid =
      type === "date"
        ? (typeof value === "string" || typeof value === "number") && !Number.isNaN(new Date(value).getTime())
        : typeof value === type && !(type === "number" && !Number.isFinite(value));
    if (!valid) issues.push(`payload.${field} must be a ${type}`);
  }
  return issues;
}
