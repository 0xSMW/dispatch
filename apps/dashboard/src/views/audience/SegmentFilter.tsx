import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useList } from "../../hooks/useList";
import { errorMessage } from "../../lib/client";
import { contextFields, type ContextField } from "../../lib/rules";
import { useClient } from "../../shell/session";
import type { Automation, Broadcast, ContactProperty, Segment, SegmentPreview, Topic } from "../../types";
import { durationSeconds, ruleIssue, type Rule } from "../automations/graph";
import { RuleEditor } from "../automations/Steps";

export interface SegmentFilterProps {
  rule: Rule;
  onChange: (rule: Rule) => void;
  disabled?: boolean;
  onValidityChange?: (valid: boolean) => void;
}

/** Audience restrictions, not an alternate rule grammar or evaluator. */
export function segmentRuleIssue(rule: Rule, fields: ContextField[], scopes: {
  automations: readonly { value: string; label: string }[];
  broadcasts: readonly { value: string; label: string }[];
}): string | null {
  let conditions = 0;
  const seen = new Set<Rule>();
  function visit(node: Rule, depth: number): string | null {
    if (!node || typeof node !== "object" || seen.has(node)) return "Invalid rule.";
    seen.add(node);
    if (depth > 5) return "Filters support at most five levels.";
    if (node.type === "and" || node.type === "or") {
      if (!Array.isArray(node.rules) || !node.rules.length) return "A group needs at least one rule.";
      for (const child of node.rules) {
        const issue = visit(child, depth + 1);
        if (issue) return issue;
      }
      return null;
    }
    if (node.type !== "rule") return "Invalid rule.";
    if (++conditions > 20) return "Filters support at most twenty conditions.";
    if (typeof node.field !== "string") return "Choose a declared contact field.";
    if (node.field.startsWith("email.")) {
      if (!["email.sent", "email.delivered", "email.opened", "email.clicked", "email.bounced"].includes(node.field)) return "Choose a supported email fact.";
      if (!["eq", "neq"].includes(node.operator) || typeof node.value !== "boolean") return "Email facts require equals or does not equal and true or false.";
      if (node.scope !== undefined) {
        if (!node.scope || typeof node.scope !== "object" || Array.isArray(node.scope)) return "Choose one email scope.";
        const keys = Object.keys(node.scope);
        const automation = node.scope.automation_id;
        const broadcast = node.scope.broadcast_id;
        if (keys.length !== 1 || !((keys[0] === "automation_id" && automation) || (keys[0] === "broadcast_id" && broadcast))) return "Choose one email scope.";
        if (!(automation ? scopes.automations : scopes.broadcasts).some((choice) => choice.value === (automation ?? broadcast))) return "Choose a live email scope.";
      }
      if (node.window !== undefined) {
        const seconds = typeof node.window === "string" ? durationSeconds(node.window) : null;
        if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "Enter a positive email window, such as 30 days.";
      }
      return null;
    }
    const field = fields.find((choice) => choice.path === node.field);
    if (!field || !node.field.startsWith("contact.")) return "Choose a declared contact field.";
    if (node.scope !== undefined || node.window !== undefined) return "Email scope and window apply only to email facts.";
    if (field.type === "set" && !["exists", "is_empty"].includes(node.operator) && !field.choices?.some((choice) => choice.value === node.value)) return "Choose a live topic or static segment.";
    const issue = ruleIssue(node, fields);
    if (issue) return issue;
    if (field.type === "string" && !["exists", "is_empty"].includes(node.operator) && typeof node.value !== "string") return "Enter text to compare with.";
    return null;
  }
  return visit(rule, 1);
}

/** Only referenced resources should block a draft; unrelated picker failures are recoverable. */
export function ruleSources(rule: Rule | null): Set<string> {
  const result = new Set<string>();
  const seen = new Set<Rule>();
  function visit(node: Rule | null) {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.type === "and" || node.type === "or") { if (Array.isArray(node.rules)) node.rules.forEach(visit); return; }
    if (node.type !== "rule") return;
    if (node.field === "contact.topics") result.add("topics");
    if (node.field === "contact.segments") result.add("segments");
    // Legacy scalar properties can override topics/segments, so their definitions are required.
    if (node.field?.startsWith("contact.") && !["contact.email", "contact.first_name", "contact.last_name", "contact.unsubscribed", "contact.created_at"].includes(node.field)) result.add("properties");
    if (node.scope?.automation_id) result.add("automations");
    if (node.scope?.broadcast_id) result.add("broadcasts");
  }
  visit(rule);
  return result;
}

/** Live, paginated choices and an uncached read-only preview of the controlled draft. */
export function SegmentFilter({ rule, onChange, disabled = false, onValidityChange }: SegmentFilterProps) {
  const client = useClient();
  const properties = useList<ContactProperty>("/contact-properties", {}, { all: true });
  const topics = useList<Topic>("/topics", {}, { all: true });
  const segments = useList<Segment>("/segments", {}, { all: true });
  const automations = useList<Automation>("/automations", {}, { all: true });
  const broadcasts = useList<Broadcast>("/broadcasts", {}, { all: true });
  const fields = useMemo(() => contextFields({
    properties: properties.rows,
    topics: topics.rows.map((row) => ({ value: row.id, label: row.name })),
    segments: segments.rows.filter((row) => row.type === "static").map((row) => ({ value: row.id, label: row.name })),
  }).filter((field) => !field.path.startsWith("event.")), [properties.rows, topics.rows, segments.rows]);
  const scopes = useMemo(() => ({
    automations: automations.rows.map((row) => ({ value: row.id, label: row.name })),
    broadcasts: broadcasts.rows.map((row) => ({ value: row.id, label: row.name })),
  }), [automations.rows, broadcasts.rows]);
  const sources = { properties, topics, segments, automations, broadcasts };
  const needed = ruleSources(rule);
  const relevant = Object.entries(sources).filter(([key]) => needed.has(key)).map(([, source]) => source);
  const loading = relevant.some((source) => source.loading);
  const sourceError = relevant.find((source) => source.error)?.error;
  const issue = sourceError ?? (loading ? "Loading filter choices…" : segmentRuleIssue(rule, fields, scopes));
  const valid = !issue;
  useEffect(() => onValidityChange?.(valid), [valid, onValidityChange]);

  const [preview, setPreview] = useState<{ rule: Rule; data?: SegmentPreview; error?: string } | null>(null);
  useEffect(() => {
    let current = true;
    if (!valid) return;
    const timer = setTimeout(() => {
      client.post<SegmentPreview>("/segments/preview", { rule }).then(
        (data) => { if (current) setPreview({ rule, data: { ...data, sample: data.sample.slice(0, 10) } }); },
        (error) => { if (current) setPreview({ rule, error: errorMessage(error) }); },
      );
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [client, rule, valid]);
  const result = valid && preview?.rule === rule ? preview : null;

  return (
    <div className="stack">
      <RuleEditor rule={rule} onChange={(next) => { if (!disabled) onChange(next); }} disabled={disabled} fields={fields} context="segment" engagementScopes={scopes} />
      {issue ? <p className="fieldError" role={loading ? "status" : "alert"}>{issue}</p> : null}
      {Object.values(sources).some((source) => source.error) ? <button type="button" className="secondary" onClick={() => { for (const source of Object.values(sources)) void source.reload(); }}>Retry choices</button> : null}
      <section aria-label="Filter preview" className="stack" aria-live="polite">
        {valid && !result ? <p className="muted" role="status">Updating preview…</p> : null}
        {result?.error ? <p className="fieldError" role="alert">{result.error}</p> : null}
        {result?.data ? <>
          <p role="status">{result.data.count.toLocaleString()} matching contacts</p>
          <p className="muted">Sample of up to 10 contacts. Membership changes as contacts and email activity change.</p>
          <ul>{result.data.sample.map((contact) => <li key={contact.id}><Link to={`/audience/contacts/${contact.id}`}>{contact.email}</Link></li>)}</ul>
        </> : null}
      </section>
    </div>
  );
}
