import { useDateRange } from "../../components/DateRange";
import { useResource } from "../../hooks/useResource";
import { withQuery } from "../../lib/client";
import { toGraph, type Tree } from "./graph";

export type EmailCounts = {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  unsubscribed: number;
};
export type EmailReport = { data: Array<EmailCounts & { automation_id: string; automation_step: string | null }> };
export const zeroEmails: EmailCounts = { sent: 0, delivered: 0, opened: 0, clicked: 0, open_rate: 0, click_rate: 0, bounce_rate: 0, unsubscribed: 0 };

/** One request per editor and range, shared by the table, list, and canvas. */
export function useEmailMetrics(automationId: string | undefined) {
  const range = useDateRange();
  return useResource<EmailReport>(automationId ? withQuery("/emails/metrics", {
    automation_id: automationId, dimensions: "step", metrics: Object.keys(zeroEmails).join(","),
    start_date: range.start ?? "1970-01-01T00:00:00.000Z", end_date: range.end,
  }) : null);
}

export function countsByStep(report: EmailReport | null) {
  return Object.fromEntries((report?.data ?? []).filter((row) => typeof row.automation_step === "string").map((row) => [row.automation_step!, row]));
}

export function emailRows(tree: Tree | null, names: Record<string, string>, report: EmailReport | null) {
  const counts = countsByStep(report);
  const nodes = tree ? toGraph(tree).steps.filter((step) => step.type === "send_email") : [];
  const rows = nodes.map((step) => {
    const template = step.config.template;
    const ref = typeof template === "string" ? template : (template as { id?: string } | undefined)?.id ?? "";
    return { ...zeroEmails, ...counts[step.key], id: `step:${step.key}`, key: step.key, name: (names[ref] ?? ref) || "Email" };
  });
  const known = new Set(rows.map((row) => row.key));
  for (const row of report?.data ?? []) {
    if (row.automation_step && known.has(row.automation_step)) continue;
    rows.push({ ...row, id: row.automation_step ? `step:${row.automation_step}` : "legacy", key: row.automation_step ?? "legacy", name: row.automation_step ? "Step removed" : "Earlier emails (step unknown)" });
  }
  return rows;
}

export function EmailCountLine({ counts }: { counts?: EmailCounts }) {
  const row = counts ?? zeroEmails;
  return <span className="muted">{row.sent.toLocaleString()} sent · {row.opened.toLocaleString()} opened · {row.clicked.toLocaleString()} clicked</span>;
}
