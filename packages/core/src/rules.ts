import { z } from "zod";
import { isIsoDate, type PropertyType } from "./properties.js";
import { ApiError } from "./errors.js";
export { isIsoDate } from "./properties.js";

export const operators = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "starts_with", "ends_with", "within", "not_within", "exists", "is_empty"] as const;
export type Operator = (typeof operators)[number];
export type RuleFieldType = PropertyType | "set";
export function operatorsForType(type: RuleFieldType): readonly Operator[] {
  const unary: Operator[] = ["exists", "is_empty"];
  switch (type) {
    case "string": return ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", ...unary];
    case "number": return ["eq", "neq", "gt", "gte", "lt", "lte", ...unary];
    case "boolean": return ["eq", "neq", ...unary];
    case "date": return ["eq", "neq", "gt", "gte", "lt", "lte", "within", "not_within", ...unary];
    case "set": return ["contains", "not_contains", ...unary];
  }
}

export type Rule =
  | { type: "rule"; field: string; operator: Operator; value?: unknown; scope?: EngagementScope; window?: string }
  | { type: "and" | "or"; rules: Rule[] };

export const engagementFields = ["email.sent", "email.delivered", "email.opened", "email.clicked", "email.bounced"] as const;
export type EngagementField = (typeof engagementFields)[number];
export type EngagementScope = { automation_id: string; broadcast_id?: never } | { broadcast_id: string; automation_id?: never };
export type EngagementRule = { type: "rule"; field: EngagementField; operator: "eq" | "neq"; value: boolean; scope?: EngagementScope; window?: string };
const engagementScopeSchema = z.union([
  z.object({ automation_id: z.string().min(1) }).strict(),
  z.object({ broadcast_id: z.string().min(1) }).strict()
]);

const nestedRule: z.ZodType<Rule> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("rule"), field: z.string().min(1).max(200), operator: z.enum(operators), value: z.unknown().optional(),
      scope: engagementScopeSchema.optional(), window: z.string().refine(validWindow, "Use a positive finite duration").optional() })
      .refine((rule) => rule.operator !== "within" && rule.operator !== "not_within" || validWindow(rule.value), {
        message: "Date windows need a positive duration, such as 30 days", path: ["value"]
      })
      .superRefine((rule, context) => {
        if (rule.field.startsWith("email.")) {
          if (!(engagementFields as readonly string[]).includes(rule.field) || !["eq", "neq"].includes(rule.operator) || typeof rule.value !== "boolean")
            context.addIssue({ code: z.ZodIssueCode.custom, message: "Email engagement requires a supported fact, eq/neq and a boolean" });
        } else if (rule.scope !== undefined || rule.window !== undefined) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "Scope and window are only supported on email engagement" });
        }
      }),
    z.object({ type: z.enum(["and", "or"]), rules: z.array(nestedRule).min(1).max(50) })
  ])
);

export const maxRuleDepth = 10;

// Measured without recursion, so a rule nested thousands deep is refused before zod walks it.
function ruleDepth(value: unknown) {
  let deepest = 0;
  const pending: Array<[unknown, number]> = [[value, 1]];
  while (pending.length > 0) {
    const [node, depth] = pending.pop()!;
    deepest = Math.max(deepest, depth);
    if (deepest > maxRuleDepth) break;
    const rules = (node as { rules?: unknown } | null)?.rules;
    if (Array.isArray(rules)) for (const child of rules) pending.push([child, depth + 1]);
  }
  return deepest;
}

export const ruleSchema: z.ZodType<Rule, unknown> = z
  .custom<unknown>((value) => ruleDepth(value) <= maxRuleDepth, `Rules can nest at most ${maxRuleDepth} levels`)
  .pipe(nestedRule);

export function hasEngagement(rule: Rule): boolean {
  return rule.type === "rule" ? rule.field.startsWith("email.") : rule.rules.some(hasEngagement);
}

export const automationRuleSchema = ruleSchema.refine((rule) => !hasEngagement(rule), "Email engagement is not supported in automation rules");

export const segmentRuleSchema = z.custom<unknown>((value) => {
  const pending: Array<[unknown, number]> = [[value, 1]];
  let conditions = 0;
  while (pending.length) {
    const [node, depth] = pending.pop()!;
    if (depth > 5 || !node || typeof node !== "object") return false;
    if ((node as { type?: unknown }).type === "rule" && ++conditions > 20) return false;
    const children = (node as { rules?: unknown }).rules;
    if (Array.isArray(children)) {
      if (children.length > 20) return false;
      children.forEach((child) => pending.push([child, depth + 1]));
    }
  }
  return true;
}, "Segment rules allow at most five levels and twenty conditions").pipe(ruleSchema);
export const segmentPreviewSchema = z.object({ rule: segmentRuleSchema }).strict();

// Two numbers, or two dates, to compare. Anything else (null, an empty string, a list, a number
// against a date) has no order, and the rule is false.
function comparable(actual: unknown, expected: unknown): [number, number] | null {
  const number = (value: unknown) =>
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const left = number(actual);
  const right = number(expected);
  if (left !== null && right !== null) return [left, right];
  const date = (value: unknown) => (typeof value === "string" && left === null && right === null && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null);
  const earlier = date(actual);
  const later = date(expected);
  return earlier !== null && later !== null ? [earlier, later] : null;
}

// Reads a dotted path such as "event.plan" or "contact.first_name" from the run context.
function validWindow(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 60) return false;
  try {
    const seconds = durationSeconds(value);
    return Number.isFinite(seconds) && seconds > 0;
  } catch {
    return false;
  }
}

export function evaluate(rule: Rule, context: Record<string, unknown>, now = Date.now()): boolean {
  if (rule.type !== "rule") {
    return rule.type === "and" ? rule.rules.every((child) => evaluate(child, context, now)) : rule.rules.some((child) => evaluate(child, context, now));
  }
  const actual = rule.field
    .split(".")
    .reduce<unknown>((value, part) => (value !== null && typeof value === "object" && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined), context);
  const expected = rule.value;
  const order = comparable(actual, expected);
  switch (rule.operator) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt": return order !== null && order[0] > order[1];
    case "gte": return order !== null && order[0] >= order[1];
    case "lt": return order !== null && order[0] < order[1];
    case "lte": return order !== null && order[0] <= order[1];
    case "contains": return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected));
    case "not_contains": return !(Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected)));
    case "within":
    case "not_within": {
      if (!isIsoDate(actual) || !validWindow(expected) || !Number.isFinite(now)) return false;
      const timestamp = Date.parse(actual);
      const within = timestamp >= now - durationSeconds(expected) * 1_000 && timestamp <= now;
      return rule.operator === "within" ? within : !within;
    }
    case "starts_with": return String(actual ?? "").startsWith(String(expected));
    case "ends_with": return String(actual ?? "").endsWith(String(expected));
    case "exists": return actual !== undefined && actual !== null;
    case "is_empty": return actual === undefined || actual === null || actual === "" || (Array.isArray(actual) && actual.length === 0);
  }
}

const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 };

export function durationSeconds(value: string) {
  const match = value.trim().toLowerCase().match(/^(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)$/);
  if (!match?.[1] || !match[2]) throw new ApiError("validation_error", 422, `Invalid duration: ${value}`);
  return Number(match[1]) * unitSeconds[match[2][0]];
}
