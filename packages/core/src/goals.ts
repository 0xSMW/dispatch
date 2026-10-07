import { z } from "zod";
import { hasEngagement, ruleSchema, type Rule } from "./index.js";

const contactRule = z.lazy(() => ruleSchema).refine((rule) => {
  const pending = [rule];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type !== "rule") pending.push(...node.rules);
    else if (!node.field.startsWith("contact.") || node.field.slice(8).includes(".")) return false;
  }
  return !hasEngagement(rule);
}, "Goals require contact-state rules, not event fields or email engagement");
export const goalTargetSchema = z.union([
  z.object({ event: z.string().trim().min(1).max(120).refine((name) => !name.startsWith("@"), "Use a real event name") }).strict(),
  z.object({ rule: contactRule }).strict(),
]);
export const goalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  target: goalTargetSchema,
  eligibility: contactRule.nullable().optional(),
  window_days: z.number().int().min(1).max(365).default(30),
}).strict();
export const goalUpdateSchema = goalSchema.partial();
export const goalMetricsSchema = z.object({
  automation_id: z.string().min(1).optional(),
  broadcast_id: z.string().min(1).optional(),
  step_key: z.string().min(1).optional(),
  start_date: z.string().datetime({ offset: true }).optional(),
  end_date: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((query, ctx) => {
  if (query.automation_id && query.broadcast_id) ctx.addIssue({ code: "custom", message: "Choose one automation or broadcast" });
  if (query.step_key && !query.automation_id) ctx.addIssue({ code: "custom", message: "step_key requires automation_id" });
  if (query.start_date && query.end_date && Date.parse(query.start_date) >= Date.parse(query.end_date))
    ctx.addIssue({ code: "custom", message: "start_date must precede end_date" });
});
export type GoalInput = z.input<typeof goalSchema>;
export type GoalUpdate = z.input<typeof goalUpdateSchema>;
export type GoalQuery = z.infer<typeof goalMetricsSchema>;
export type Goal = {
  object: "goal"; id: string; name: string; target: { event: string } | { rule: Rule };
  eligibility: Rule | null; window_days: number; created_at: string; updated_at: string;
};
export type GoalMetrics = {
  object: "goal_metrics"; goal_id: string; start_date: string; end_date: string;
  contacts_reached: number; converted: number; rate: number;
  data: Array<{ date: string; contacts_reached: number; converted: number; rate: number }>;
  history: { available_from: string | null; limitation: string };
};
export const goalHistoryLimit = "Rule conversions require recorded contact changes (available since contact history was introduced). Unrecorded earlier transitions cannot be inferred. Eligibility uses current live contact state. Days are UTC first-send cohorts; rates are fractions, zero for empty cohorts.";
