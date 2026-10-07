import type { AutomationRunDetail } from "../../types";
import { ruleText, type Rule, type Tree } from "./graph";
import { locate } from "./layout";

/** Why a rule stopped matching, without exposing its raw operator names. */
export function filterFailure(rule?: Rule): string {
  if (!rule) return "the rule no longer matched";
  if (rule.type !== "rule") return `the rule no longer matched (${ruleText(rule)})`;
  const opposite: Record<string, string> = {
    eq: "neq", neq: "eq", gt: "lte", gte: "lt", lt: "gte", lte: "gt",
    contains: "not_contains", not_contains: "contains", within: "not_within", not_within: "within",
  };
  if (opposite[rule.operator]) return ruleText({ ...rule, operator: opposite[rule.operator]! });
  if (rule.operator === "exists") return `${rule.field} does not exist`;
  if (rule.operator === "is_empty") return `${rule.field} is not empty`;
  return `the rule no longer matched (${ruleText(rule)})`;
}

/** The saved guard wins over the current graph: a paused edit may have changed its rule. */
export function runReason(run: AutomationRunDetail, tree: Tree | null = null): string | null {
  const reason = run.exit_reason ?? (run.cancellation_reason === "stranded" ? "stranded" : null);
  switch (reason) {
    case "completed": return "Reached the end of this run.";
    case "exit": return "Left at the Exit step.";
    case "stopped": return "Cancelled when the automation was stopped.";
    case "stranded": return "Cancelled because its waiting step was removed or changed.";
    case "filter": {
      const failed = [...run.steps ?? []].reverse().find((step) => {
        const output = (step.output ?? step.data) as { exited?: string } | undefined;
        return output?.exited === "filter";
      });
      const output = (failed?.output ?? failed?.data) as { filter?: string } | undefined;
      const source = output?.filter ?? failed?.key;
      const guard = run.guards?.find((guard) => guard.filter === source);
      const node = source && tree ? locate(tree, source)?.node : null;
      const rule = guard?.rule ?? (node?.type === "filter" ? node.config.rule as Rule : undefined);
      return `Left at the Filter step: ${filterFailure(rule)}${source ? ` (${source})` : ""}.`;
    }
    default: return null;
  }
}
