import { useId, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Clock, Hourglass, Mail, Plus, Split, Trash2, UserCog, UserX, UsersRound, Zap } from "lucide-react";
import { Badge, statusToVariant, type BadgeVariant } from "../../components/Badge";
import { Code } from "../../components/Code";
import { Field, Select, Switch, TextArea, type Option } from "../../components/Field";
import { Menu, type MenuItem } from "../../components/Menu";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import {
  branchLabels,
  branchesOf,
  branching,
  canMove,
  describe,
  stepError,
  stepLabels,
  type ListPath,
  type Node,
  type Rule,
  type StepType,
} from "./graph";
import "../../styles/automations.css";

// The structured list for the automation builder and its run view.

export type StepOptions = { templates: Option[]; segments: Option[]; events: string[]; topics?: Option[] };

export type StepActions = {
  insert: (path: ListPath, index: number, type: StepType, key?: string) => void;
  remove: (path: ListPath, index: number, node: Node) => void;
  move: (path: ListPath, index: number, delta: -1 | 1) => void;
  change: (key: string, change: (node: Node) => Node) => void;
  waitBranches: (path: ListPath, index: number, on: boolean) => void;
};

export type RunStep = {
  key?: string;
  type: string;
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
  output?: unknown;
  error?: string | null;
};

export const stepIcons: Record<StepType | "trigger", ReactNode> = {
  trigger: <Zap size={14} />,
  send_email: <Mail size={14} />,
  delay: <Clock size={14} />,
  wait_for_event: <Hourglass size={14} />,
  condition: <Split size={14} />,
  add_to_segment: <UsersRound size={14} />,
  contact_update: <UserCog size={14} />,
  contact_delete: <UserX size={14} />,
};

export const stepTones: Record<StepType | "trigger", BadgeVariant> = {
  trigger: "accent",
  send_email: "success",
  delay: "warning",
  wait_for_event: "warning",
  condition: "info",
  add_to_segment: "neutral",
  contact_update: "neutral",
  contact_delete: "danger",
};

export interface StepListProps {
  nodes: Node[];
  path?: ListPath;
  /** Omit for a read-only list. */
  actions?: StepActions;
  disabled?: boolean;
  errors?: Record<string, Record<string, string>>;
  options?: StepOptions;
  /** Run view: each step's result by key. */
  run?: Map<string, RunStep>;
}

/** An ordered list of step cards. Branching steps end their list and hold one nested list per branch. */
export function StepList({ nodes, path = [], actions, disabled = false, errors = {}, options, run }: StepListProps) {
  const editable = Boolean(actions) && !disabled;
  const last = nodes.at(-1);
  return (
    <ol className="stepList">
      {nodes.map((node, index) => (
        <li key={node.key} className="stepItem">
          {editable ? <AddStep onPick={(type) => actions!.insert(path, index, type)} /> : null}
          <StepCard
            node={node}
            path={path}
            index={index}
            list={nodes}
            actions={editable ? actions : undefined}
            disabled={disabled}
            errors={errors[node.key] ?? {}}
            options={options}
            run={run}
          />
          {branchesOf(node).length ? (
            <div className="branches">
              {branchesOf(node).map((branch) => (
                <section key={branch} className={`branch ${branch}`} aria-label={`${branchLabels[branch]} branch of ${node.key}`}>
                  <div className="branchLabel">{branchLabels[branch]}</div>
                  <StepList
                    nodes={node.branches?.[branch] ?? []}
                    path={[...path, { key: node.key, branch }]}
                    actions={actions}
                    disabled={disabled}
                    errors={errors}
                    options={options}
                    run={run}
                  />
                </section>
              ))}
            </div>
          ) : null}
        </li>
      ))}
      {editable && !(last && branching(last)) ? (
        <li className="stepItem">
          <AddStep onPick={(type) => actions!.insert(path, nodes.length, type)} end={nodes.length === 0} />
        </li>
      ) : null}
      {!editable && nodes.length === 0 ? <li className="stepEnd dim">End</li> : null}
    </ol>
  );
}

const pickerGroups: StepType[][] = [
  ["send_email"],
  ["delay", "wait_for_event", "condition"],
  ["contact_update", "contact_delete", "add_to_segment"],
];

/** The "+" between steps that opens the step picker. */
export function AddStep({ onPick, end = false }: { onPick: (type: StepType) => void; end?: boolean }) {
  const items: MenuItem[] = pickerGroups.flatMap((group, index) => [
    ...(index ? (["divider"] as MenuItem[]) : []),
    ...group.map((type) => ({ label: stepLabels[type], icon: stepIcons[type], onSelect: () => onPick(type) })),
  ]);
  return (
    <div className={end ? "addStep end" : "addStep"}>
      <Menu
        items={items}
        label="Add step"
        align="start"
        triggerClassName="secondary small addStepButton"
        trigger={
          <>
            <Plus size={14} />
            {end ? "Add step" : null}
          </>
        }
      />
    </div>
  );
}

function StepCard({
  node,
  path,
  index,
  list,
  actions,
  disabled,
  errors,
  options,
  run,
}: {
  node: Node;
  path: ListPath;
  index: number;
  list: Node[];
  actions?: StepActions;
  disabled: boolean;
  errors: Record<string, string>;
  options?: StepOptions;
  run?: Map<string, RunStep>;
}) {
  const result = run?.get(node.key);
  const status = run ? (result?.status ?? "not_started") : null;
  const tint = status ? statusToVariant(status) : null;
  return (
    <article className={["stepCard", tint ? `tint ${tint}` : "", status === "not_started" ? "skipped" : ""].filter(Boolean).join(" ")} aria-label={`Step ${node.key}`}>
      <header className="stepHeader">
        <Tile tone={stepTones[node.type]}>{stepIcons[node.type]}</Tile>
        <div className="stepTitle">
          <strong>{stepLabels[node.type]}</strong>
          <span className="mono dim">{node.key}</span>
        </div>
        {status ? <Badge value={status} /> : null}
        {actions ? (
          <div className="toolbar">
            <button
              type="button"
              className="ghost icon small"
              aria-label="Move up"
              disabled={!canMove(list, index, -1)}
              onClick={() => actions.move(path, index, -1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className="ghost icon small"
              aria-label="Move down"
              disabled={!canMove(list, index, 1)}
              onClick={() => actions.move(path, index, 1)}
            >
              <ArrowDown size={14} />
            </button>
            <button type="button" className="ghost icon small" aria-label="Remove step" onClick={() => actions.remove(path, index, node)}>
              <Trash2 size={14} />
            </button>
          </div>
        ) : null}
      </header>
      {run ? (
        <RunResult node={node} result={result} />
      ) : (
        <StepForm node={node} path={path} index={index} actions={actions} disabled={disabled || !actions} errors={errors} options={options} />
      )}
      {!run && errors[stepError] ? (
        <p className="fieldError" role="alert">
          {errors[stepError]}
        </p>
      ) : null}
    </article>
  );
}

export function RunResult({ node, result }: { node: Node; result?: RunStep }) {
  return (
    <div className="stack">
      <p className="muted">{describe(node)}</p>
      {result ? (
        <dl className="stepTimes">
          <div>
            <dt>Started</dt>
            <dd>{result.started_at ? <Time value={result.started_at} mode="absolute" /> : "—"}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>{result.completed_at ? <Time value={result.completed_at} mode="absolute" /> : "—"}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{elapsed(result.started_at, result.completed_at)}</dd>
          </div>
        </dl>
      ) : (
        <p className="dim">Not reached in this run.</p>
      )}
      {result?.error ? (
        <div className="alert" role="alert">
          {result.error}
        </div>
      ) : null}
      {result && result.output && Object.keys(result.output as object).length ? <Code value={result.output} /> : null}
    </div>
  );
}

/** "1.2s", "4m 10s", "3h 5m", "2d 4h". Blank while running. */
export function elapsed(start?: string | null, end?: string | null): string {
  if (!start || !end) return "—";
  const seconds = Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 1000);
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

type FormProps = {
  node: Node;
  path: ListPath;
  index: number;
  actions?: StepActions;
  disabled: boolean;
  errors: Record<string, string>;
  options?: StepOptions;
};

/** A step's config form. The list card and the canvas side panel both render it. */
export function StepForm({ node, path, index, actions, disabled, errors, options }: FormProps) {
  const config = node.config;
  const set = (field: string, value: unknown) =>
    actions?.change(node.key, (current) => ({ ...current, config: { ...current.config, [field]: value } }));
  const text = (field: string) => (config[field] === undefined || config[field] === null ? "" : String(config[field]));
  const json = (field: string, value: unknown) => node.drafts?.[field] ?? (value && Object.keys(value as object).length ? JSON.stringify(value, null, 2) : "");
  const setJson = (field: string, raw: string, apply: (parsed: Record<string, unknown>, current: Node) => Node["config"]) =>
    actions?.change(node.key, (current) => {
      const drafts = { ...current.drafts, [field]: raw };
      let parsed: unknown = {};
      try {
        parsed = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        return { ...current, drafts };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...current, drafts };
      return { ...current, drafts, config: apply(parsed as Record<string, unknown>, current) };
    });

  switch (node.type) {
    case "send_email": {
      const template = (typeof config.template === "string" ? { id: config.template } : (config.template ?? {})) as {
        id?: string;
        variables?: Record<string, unknown>;
      };
      const templates = options?.templates ?? [];
      const choices = template.id && !templates.some((option) => option.value === template.id)
        ? [{ value: template.id, label: template.id }, ...templates]
        : templates;
      const replyTo = Array.isArray(config.reply_to) ? config.reply_to.join(", ") : text("reply_to");
      return (
        <div className="form two">
          <Select
            label="Template"
            value={template.id ?? ""}
            onChange={(id) => set("template", { ...template, id })}
            options={choices}
            placeholder="Choose a template"
            error={errors.template}
            disabled={disabled}
            required
          />
          <Field
            label="From"
            value={text("from")}
            onChange={(value) => set("from", value)}
            placeholder="Acme <hello@acme.com>"
            hint="Leave blank to use the sender saved on the template."
            error={errors.from}
            disabled={disabled}
          />
          <Select
            label="Topic"
            value={text("topic_id")}
            onChange={(value) => set("topic_id", value)}
            placeholder="None: always send"
            options={options?.topics ?? []}
            hint="With a topic, contacts who unsubscribed or opted out of it are skipped. With none, the email always sends, as a receipt or a password reset should."
            disabled={disabled}
          />
          <Field
            label="To"
            value={text("to")}
            onChange={(value) => set("to", value)}
            placeholder="Contact who fired the event"
            hint="Leave blank to send to the contact who fired the event."
            error={errors.to}
            disabled={disabled}
          />
          <Field label="Subject" value={text("subject")} onChange={(value) => set("subject", value)} hint="Overrides the template subject." disabled={disabled} />
          <Field
            label="Reply-to"
            value={replyTo}
            onChange={(value) => {
              const list = value.split(",").map((item) => item.trim()).filter(Boolean);
              set("reply_to", list.length > 1 ? list : value.trim());
            }}
            disabled={disabled}
          />
          <TextArea
            label="Variables"
            value={json("variables", template.variables)}
            onChange={(raw) =>
              setJson("variables", raw, (parsed, current) => {
                const ref = current.config.template;
                const base = typeof ref === "string" ? { id: ref } : ((ref ?? {}) as Record<string, unknown>);
                return { ...current.config, template: { ...base, variables: parsed } };
              })
            }
            placeholder={'{"plan": "pro"}'}
            hint="JSON. The event payload is passed too, so {{{plan}}} works without listing it here."
            error={errors.variables}
            mono
            rows={3}
            disabled={disabled}
            wide
          />
        </div>
      );
    }
    case "delay":
      return (
        <div className="form">
          <Field
            label="Duration"
            value={text("duration")}
            onChange={(value) => set("duration", value)}
            placeholder="1 hour"
            hint="Up to 30 days, such as 30 minutes, 2 hours, or 3 days."
            error={errors.duration}
            disabled={disabled}
            required
          />
        </div>
      );
    case "wait_for_event":
      return (
        <div className="form two">
          <EventInput label="Event" value={text("event_name")} onChange={(value) => set("event_name", value)} events={options?.events ?? []} error={errors.event_name} disabled={disabled} />
          <Field
            label="Timeout"
            value={text("timeout")}
            onChange={(value) => set("timeout", value)}
            placeholder="3 days"
            hint="Leave blank to wait with no limit."
            error={errors.timeout}
            disabled={disabled}
          />
          <div className="wide stack">
            <Switch
              label="Branch on timeout"
              hint="Run different steps when the event arrives and when the wait times out. A branch with no steps in it is not saved."
              checked={Boolean(node.branches)}
              disabled={disabled || Boolean(node.branches?.timeout?.length)}
              onChange={(on) => actions?.waitBranches(path, index, on)}
            />
            <Switch
              label="Only match some events"
              hint="Resume only when the event payload passes a rule."
              checked={Boolean(config.filter_rule)}
              disabled={disabled}
              onChange={(on) => set("filter_rule", on ? { type: "rule", field: "event.", operator: "eq", value: "" } : undefined)}
            />
            {config.filter_rule ? (
              <RuleEditor rule={config.filter_rule as Rule} onChange={(rule) => set("filter_rule", rule)} disabled={disabled} />
            ) : null}
            {errors.filter_rule ? <span className="fieldError" role="alert">{errors.filter_rule}</span> : null}
          </div>
        </div>
      );
    case "condition":
      return (
        <div className="stack">
          <RuleEditor
            rule={config as Rule}
            onChange={(rule) => actions?.change(node.key, (current) => ({ ...current, config: rule as Record<string, unknown> }))}
            disabled={disabled}
          />
          {errors.rule ? (
            <span className="fieldError" role="alert">
              {errors.rule}
            </span>
          ) : (
            <span className="fieldHint">Fields read from the event payload as event.name and from the contact as contact.name.</span>
          )}
        </div>
      );
    case "add_to_segment": {
      const segments = options?.segments ?? [];
      const id = text("segment_id");
      const choices = id && !segments.some((option) => option.value === id) ? [{ value: id, label: id }, ...segments] : segments;
      return (
        <div className="form two">
          <Select label="Segment" value={id} onChange={(value) => set("segment_id", value)} options={choices} placeholder="Choose a segment" error={errors.segment_id} disabled={disabled} required />
          <Field label="Email" value={text("email")} onChange={(value) => set("email", value)} hint="Leave blank for the contact who fired the event." error={errors.email} disabled={disabled} />
        </div>
      );
    }
    case "contact_update": {
      const unsubscribed = config.unsubscribed === true ? "true" : config.unsubscribed === false ? "false" : "";
      return (
        <div className="form two">
          <Field label="First name" value={text("first_name")} onChange={(value) => set("first_name", value)} disabled={disabled} />
          <Field label="Last name" value={text("last_name")} onChange={(value) => set("last_name", value)} disabled={disabled} />
          <Select
            label="Subscription"
            value={unsubscribed}
            onChange={(value) => set("unsubscribed", value === "" ? undefined : value === "true")}
            options={[
              { value: "", label: "Leave as is" },
              { value: "true", label: "Unsubscribe" },
              { value: "false", label: "Resubscribe" },
            ]}
            disabled={disabled}
          />
          <Field label="Email" value={text("email")} onChange={(value) => set("email", value)} hint="Leave blank for the contact who fired the event." error={errors.email} disabled={disabled} />
          <TextArea
            label="Properties"
            value={json("properties", config.properties)}
            onChange={(raw) => setJson("properties", raw, (parsed, current) => ({ ...current.config, properties: parsed }))}
            placeholder={'{"plan": "pro"}'}
            hint="JSON. Merged into the contact's properties."
            error={errors.properties}
            mono
            rows={3}
            disabled={disabled}
            wide
          />
        </div>
      );
    }
    case "contact_delete":
      return (
        <div className="form">
          <Field label="Email" value={text("email")} onChange={(value) => set("email", value)} hint="Leave blank for the contact who fired the event." error={errors.email} disabled={disabled} />
        </div>
      );
  }
}

/** A text input with the defined event names as suggestions. */
export function EventInput({
  label,
  value,
  onChange,
  events,
  error,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  events: string[];
  error?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const listId = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="mono"
        list={listId}
        value={value}
        placeholder="user.created"
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
      />
      <datalist id={listId}>
        {events.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {error ? (
        <span className="fieldError" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="fieldHint">{hint}</span>
      ) : null}
    </div>
  );
}

export const operatorLabels: Record<string, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  contains: "contains",
  starts_with: "starts with",
  ends_with: "ends with",
  exists: "exists",
  is_empty: "is empty",
};

const blankRule: Rule = { type: "rule", field: "", operator: "eq", value: "" };

/** One rule, or an all-of / any-of group of rules, as the core `ruleSchema` defines them. */
export function RuleEditor({ rule, onChange, disabled = false, depth = 0 }: { rule: Rule; onChange: (rule: Rule) => void; disabled?: boolean; depth?: number }) {
  const mode = rule?.type === "and" || rule?.type === "or" ? rule.type : "rule";
  const setMode = (next: string) => {
    if (next === mode) return;
    if (next === "rule") onChange(rule.type === "rule" ? rule : (rule.rules[0] ?? blankRule));
    else onChange(rule.type === "rule" ? { type: next as "and" | "or", rules: [rule] } : { ...rule, type: next as "and" | "or" });
  };
  return (
    <div className={depth ? "ruleEditor nested" : "ruleEditor"}>
      <Select
        label={depth ? "Match" : "Condition"}
        value={mode}
        onChange={setMode}
        options={[
          { value: "rule", label: "One rule" },
          { value: "and", label: "All of these rules" },
          { value: "or", label: "Any of these rules" },
        ]}
        disabled={disabled}
      />
      {rule.type === "rule" ? (
        <RuleRow rule={rule} onChange={onChange} disabled={disabled} />
      ) : (
        <div className="stack">
          {rule.rules.map((child, index) => (
            <div key={index} className="ruleChild">
              {child.type === "rule" ? (
                <RuleRow
                  rule={child}
                  onChange={(next) => onChange({ ...rule, rules: rule.rules.map((item, at) => (at === index ? next : item)) })}
                  disabled={disabled}
                />
              ) : (
                <RuleEditor
                  rule={child}
                  depth={depth + 1}
                  onChange={(next) => onChange({ ...rule, rules: rule.rules.map((item, at) => (at === index ? next : item)) })}
                  disabled={disabled}
                />
              )}
              <button
                type="button"
                className="ghost icon small"
                aria-label="Remove rule"
                disabled={disabled || rule.rules.length <= 1}
                onClick={() => onChange({ ...rule, rules: rule.rules.filter((_, at) => at !== index) })}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="toolbar">
            <button type="button" className="secondary small" disabled={disabled} onClick={() => onChange({ ...rule, rules: [...rule.rules, blankRule] })}>
              Add rule
            </button>
            {depth === 0 ? (
              <button
                type="button"
                className="secondary small"
                disabled={disabled}
                onClick={() => onChange({ ...rule, rules: [...rule.rules, { type: rule.type === "and" ? "or" : "and", rules: [blankRule] }] })}
              >
                Add group
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

type ValueKind = "text" | "number" | "boolean";

function kindOf(value: unknown): ValueKind {
  return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "text";
}

function RuleRow({ rule, onChange, disabled }: { rule: Extract<Rule, { type: "rule" }>; onChange: (rule: Rule) => void; disabled: boolean }) {
  const unary = rule.operator === "exists" || rule.operator === "is_empty";
  const kind = kindOf(rule.value);
  // The number field keeps what was typed. An empty or half-typed value is stored as NaN, which
  // the editor reports, instead of quietly becoming 0 or null.
  const [text, setText] = useState(typeof rule.value === "number" && Number.isFinite(rule.value) ? String(rule.value) : "");
  const convert = (next: ValueKind): unknown =>
    next === "number" ? Number(rule.value) || 0 : next === "boolean" ? rule.value === true || rule.value === "true" : String(rule.value ?? "");
  return (
    <div className="ruleRow">
      <Field label="Field" value={rule.field} onChange={(field) => onChange({ ...rule, field })} placeholder="event.plan" mono disabled={disabled} />
      <Select
        label="Operator"
        value={rule.operator}
        onChange={(operator) => {
          const next: Rule = { ...rule, operator };
          if (operator === "exists" || operator === "is_empty") delete (next as { value?: unknown }).value;
          else if (next.value === undefined) next.value = "";
          onChange(next);
        }}
        options={Object.entries(operatorLabels).map(([value, label]) => ({ value, label }))}
        disabled={disabled}
      />
      {unary ? null : (
        <>
          <Select
            label="Type"
            value={kind}
            onChange={(next) => {
              const value = convert(next as ValueKind);
              if (next === "number") setText(String(value));
              onChange({ ...rule, value });
            }}
            options={[
              { value: "text", label: "Text" },
              { value: "number", label: "Number" },
              { value: "boolean", label: "True or false" },
            ]}
            disabled={disabled}
          />
          {kind === "boolean" ? (
            <Select
              label="Value"
              value={String(rule.value)}
              onChange={(value) => onChange({ ...rule, value: value === "true" })}
              options={["true", "false"]}
              disabled={disabled}
            />
          ) : (
            <Field
              label="Value"
              type={kind === "number" ? "number" : "text"}
              value={kind === "number" ? text : String(rule.value ?? "")}
              onChange={(value) => {
                if (kind !== "number") return onChange({ ...rule, value });
                setText(value);
                onChange({ ...rule, value: value.trim() === "" ? Number.NaN : Number(value) });
              }}
              disabled={disabled}
            />
          )}
        </>
      )}
    </div>
  );
}
