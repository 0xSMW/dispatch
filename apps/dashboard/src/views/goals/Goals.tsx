import { useMemo, useState } from "react";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Empty } from "../../components/Empty";
import { Field, Select } from "../../components/Field";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Time } from "../../components/Time";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { contextFields, type ContextField } from "../../lib/rules";
import { useCan, useClient } from "../../shell/session";
import type { ContactProperty, Goal, Segment, Topic } from "../../types";
import { blankRule, ruleIssue, type Rule } from "../automations/graph";
import { RuleEditor } from "../automations/Steps";
import "../../styles/audience.css";

/** Goals use the shared ten-level grammar, not the tighter segment-filter limits. */
export function goalRuleIssue(rule: Rule, fields: ContextField[], target = false): string | null {
  const seen = new Set<Rule>();
  function visit(node: Rule, depth: number): string | null {
    if (!node || typeof node !== "object" || seen.has(node)) return "Invalid rule.";
    seen.add(node);
    if (depth > 10) return "Rules can nest at most ten levels.";
    if (node.type === "and" || node.type === "or") {
      if (!Array.isArray(node.rules) || !node.rules.length || node.rules.length > 50) return "A group needs one to fifty rules.";
      for (const child of node.rules) {
        const issue = visit(child, depth + 1);
        if (issue) return issue;
      }
      return null;
    }
    if (node.type !== "rule" || typeof node.field !== "string") return "Choose a declared contact field.";
    const field = fields.find((choice) => choice.path === node.field);
    if (!field || !node.field.startsWith("contact.") || node.field.slice(8).includes(".")) return "Choose a declared contact field.";
    if (node.scope !== undefined || node.window !== undefined) return "Email engagement is not supported in goal rules.";
    if (target && (field.type === "set" || ["contact.topics", "contact.segments"].includes(node.field))) return "Rule targets support recorded contact scalars only, not topics or segments.";
    const issue = ruleIssue(node, fields);
    if (issue) return issue;
    if (!["exists", "is_empty"].includes(node.operator)) {
      if (field.type === "string" && typeof node.value !== "string") return "Enter text to compare with.";
      if (field.type === "set" && !field.choices?.some((choice) => choice.value === node.value)) return "Choose a live topic or static segment.";
    }
    return null;
  }
  return visit(rule, 1);
}

export type GoalDraft = {
  name: string;
  target: { event: string } | { rule: Rule };
  eligibility: Rule | null;
  window_days: number;
};

export function goalDraftIssue(draft: GoalDraft, fields: ContextField[]): string | null {
  if (!draft.name.trim() || draft.name.trim().length > 120) return "Enter a name of one to 120 characters.";
  if (!Number.isInteger(draft.window_days) || draft.window_days < 1 || draft.window_days > 365) return "Use a whole conversion window from 1 to 365 days.";
  if ("event" in draft.target) {
    const event = draft.target.event.trim();
    if (!event || event.length > 120 || event.startsWith("@")) return "Enter a real event name of one to 120 characters.";
  } else {
    const issue = goalRuleIssue(draft.target.rule, fields, true);
    if (issue) return issue;
  }
  return draft.eligibility ? goalRuleIssue(draft.eligibility, fields) : null;
}

export function Goals() {
  const client = useClient();
  const can = useCan();
  const list = useList<Goal>("/goals");
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  return <ListPage
    title="Goals"
    actions={can ? <button type="button" onClick={() => setEditing("new")}>Create goal</button> : null}
    list={list}
    noun="goals"
    onRowClick={setEditing}
    empty={<Empty title="No goals" body="Create an event or contact-state goal, then measure it against earlier sends." />}
    columns={[
      { header: "Name", cell: (row) => <strong>{row.name}</strong> },
      { header: "Target", cell: (row) => "event" in row.target ? row.target.event : "Contact state" },
      { header: "Window", cell: (row) => `${row.window_days} days` },
      { header: "Eligibility", cell: (row) => row.eligibility ? "Current contact filter" : "All contacts" },
      { header: "Created", cell: (row) => <Time value={row.created_at} /> },
    ]}
    menu={(row) => <Menu items={[
      { label: can ? "Edit" : "View", read: !can, onSelect: () => setEditing(row) },
      ...(can ? [{ label: "Delete", danger: true, onSelect: () => setDeleting(row) }] : []),
    ]} />}
  >
    {editing ? <GoalForm key={editing === "new" ? "new" : editing.id} goal={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onDone={list.reload} /> : null}
    {deleting && can ? <ConfirmPhrase
      title="Delete goal" body="This goal will no longer be available for conversion reports. Contacts and emails stay unchanged."
      phrase={deleting.name} action="Delete goal"
      onConfirm={() => { if (!can) throw new Error("Read-only access."); return client.delete(`/goals/${deleting.id}`); }}
      onClose={() => setDeleting(null)} onDone={list.reload}
    /> : null}
  </ListPage>;
}

function GoalForm({ goal, onClose, onDone }: { goal?: Goal; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const can = useCan();
  const properties = useList<ContactProperty>("/contact-properties", {}, { all: true });
  const topics = useList<Topic>("/topics", {}, { all: true });
  const segments = useList<Segment>("/segments", {}, { all: true });
  const fields = useMemo(() => contextFields({
    properties: properties.rows,
    topics: topics.rows.map((row) => ({ value: row.id, label: row.name })),
    segments: segments.rows.filter((row) => row.type === "static").map((row) => ({ value: row.id, label: row.name })),
  }).filter((field) => field.path.startsWith("contact.")), [properties.rows, topics.rows, segments.rows]);
  const targetFields = fields.filter((field) => field.type !== "set" && !["contact.topics", "contact.segments"].includes(field.path));
  const [name, setName] = useState(goal?.name ?? "");
  const [kind, setKind] = useState(goal && "rule" in goal.target ? "rule" : "event");
  const [event, setEvent] = useState(goal && "event" in goal.target ? goal.target.event : "");
  const [rule, setRule] = useState<Rule>(() => goal && "rule" in goal.target ? goal.target.rule : blankRule());
  const [eligibility, setEligibility] = useState<Rule | null>(goal?.eligibility ?? null);
  const [window, setWindow] = useState(String(goal?.window_days ?? 30));
  const draft: GoalDraft = { name: name.trim(), target: kind === "event" ? { event: event.trim() } : { rule }, eligibility, window_days: Number(window) };
  const sources = [properties, topics, segments];
  const choicesIssue = sources.find((source) => source.error)?.error
    ?? (sources.some((source) => source.loading) ? "Loading contact fields…" : sources.some((source) => source.hasMore) ? "Not all contact choices could be loaded." : null);
  const issue = choicesIssue ?? goalDraftIssue(draft, fields);
  const save = useMutation(() => {
    if (!can || issue) throw new Error(issue ?? "Read-only access.");
    return goal ? client.patch(`/goals/${goal.id}`, draft) : client.post("/goals", draft);
  }, { success: goal ? "Goal saved." : "Goal created.", onSuccess: () => { onDone(); onClose(); } });
  const disabled = !can || save.isLoading;
  return <Modal isOpen size="large" title={can ? goal ? "Edit goal" : "Create goal" : "View goal"}
    onClose={onClose} onSubmit={can ? () => void save.mutate() : undefined}
    submitLabel={goal ? "Save" : "Create"} submitDisabled={!can || Boolean(issue)} submitting={save.isLoading}>
    <div className="stack">
      <Field label="Name" value={name} onChange={setName} required autoFocus disabled={disabled} />
      <Select label="Target" value={kind} onChange={setKind} disabled={disabled} options={[{ value: "event", label: "Custom event" }, { value: "rule", label: "Contact state" }]} />
      {kind === "event" ? <Field label="Event name" value={event} onChange={setEvent} required disabled={disabled} /> : <>
        <RuleEditor rule={rule} onChange={setRule} fields={targetFields} disabled={disabled || Boolean(choicesIssue)} />
        <p className="muted">A rule target counts entry into recorded contact state. Historical events, email engagement, topics and segment membership are not supported as rule targets. Earlier unrecorded transitions cannot be inferred.</p>
      </>}
      <Field label="Conversion window (days)" type="number" value={window} onChange={setWindow} required disabled={disabled} hint="1–365 days after the first scoped send; default 30. The window endpoint is inclusive." />
      <Select label="Eligibility" value={eligibility ? "rule" : "all"} disabled={disabled} onChange={(next) => setEligibility(next === "rule" ? blankRule() : null)}
        options={[{ value: "all", label: "All contacts" }, { value: "rule", label: "Current contact filter" }]} />
      {eligibility ? <RuleEditor rule={eligibility} onChange={setEligibility} fields={fields} disabled={disabled || Boolean(choicesIssue)} /> : null}
      <p className="muted">Eligibility uses current live contact state, including current topics and static segment membership, not state at send time. Sandbox sends never count.</p>
      {issue ? <p role={sources.some((source) => source.loading) ? "status" : "alert"} className="fieldError">{issue}</p> : null}
      {sources.some((source) => source.error) ? <button type="button" className="secondary" onClick={() => { for (const source of sources) void source.reload(); }}>Retry choices</button> : null}
    </div>
  </Modal>;
}
