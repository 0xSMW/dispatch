import { z } from "zod";

export const splitSchema = z.object({
  variants: z.array(z.object({
    key: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
    label: z.string().trim().min(1).max(120),
    weight: z.number().int().min(0).max(100),
  })).min(2).max(4),
}).superRefine(({ variants }, ctx) => {
  if (new Set(variants.map((variant) => variant.key)).size !== variants.length) {
    ctx.addIssue({ code: "custom", path: ["variants"], message: "Variant keys must be unique" });
  }
  if (variants.reduce((sum, variant) => sum + variant.weight, 0) !== 100) {
    ctx.addIssue({ code: "custom", path: ["variants"], message: "Variant weights must sum to 100" });
  }
});

export type SplitConfig = z.infer<typeof splitSchema>;
export const splitWinnerSchema = z.object({ variant: z.string().min(1).max(60), version: z.number().int().min(0) }).strict();
export type SplitVariant = SplitConfig["variants"][number];
export type SplitMetricsInput = { automationId: string; stepKey: string; start: Date; end: Date };
export type SplitMetric = {
  key: string; label: string; weight: number | null; runs: number;
  sent: number; delivered: number; opened: number; clicked: number;
  unique_opened: number; unique_clicked: number; bounced: number;
  complained: number; unsubscribed: number;
  delivery_rate: number; open_rate: number; click_rate: number;
  bounce_rate: number; complaint_rate: number; unsubscribe_rate: number;
};
export type SplitReport = {
  object: "automation_split_metrics"; automation_id: string; step_key: string;
  start_date: string; end_date: string; data: SplitMetric[];
};
