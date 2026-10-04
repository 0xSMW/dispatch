import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Clock, Funnel, Hourglass, LogOut, Mail, Plus, Split, Trash2, UserCog, UserX, UsersRound, Zap } from "lucide-react";
import { Badge, statusToVariant, type BadgeVariant } from "../../components/Badge";
import { Code } from "../../components/Code";
import { Field, Select, Switch, TextArea, type Option } from "../../components/Field";
import { Menu, type MenuItem } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { ContextField } from "../../components/ContextField";
import { TypedValue } from "../../components/TypedValue";
import { useResource } from "../../hooks/useResource";
import { contextFields, isIsoDate, operatorsForType, propertyTypes, typedValue, valueIssue, valueKind, type ContextField as ContextFieldRow } from "../../lib/rules";
import type { ContactProperty, EventDefinition, PropertyType, SendKind, Template } from "../../types";
import { contentKind, kindLabels, sendKind, sendSemantics, templateKind } from "../../lib/emailKind";
import { EmailCountLine, type EmailCounts } from "./EmailMetrics";
import {
  blankRule as emptyRule,
  branchLabel,
  branchSteps,
  branchesOf,
  canMove,
  configuredPaths,
  descendants,
  describe,
  keys,
  setBranchPaths,
  stepError,
  stepLabels,
  terminal,
  type ListPath,
  type Node,
  type Rule,
  type StepType,
} from "./graph";
import "../../styles/automations.css";

// The structured list for the automation builder and its run view.

export type StepOptions = {
  templates: Array<Option & { kind?: SendKind }>; segments: Option[]; events: string[]; topics?: Option[];
  eventDefinitions?: EventDefinition[];
  contactProperties?: ContactProperty[];
  topicsReady?: boolean;
  segmentsReady?: boolean;
  propertiesReady?: boolean;
  topicsError?: string | null;
  segmentsError?: string | null;
  propertiesError?: string | null;
  eventName?: string;
  templateNames?: Record<string, string>;
  emailCounts?: Record<string, EmailCounts>;
};

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
  branch: <Split size={14} />,
  filter: <Funnel size={14} />,
  exit: <LogOut size={14} />,
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
  branch: "info",
  filter: "info",
  exit: "neutral",
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
          {editable ? <AddStep onPick={(type) => actions!.insert(path, index, type)} allowExit={!nodes.slice(index).some((node) => node.type !== "exit")} /> : null}
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
            <div className={node.type === "branch" ? "branches ordered" : "branches"}>
              {branchesOf(node).map((branch) => (
                <section key={branch} className={`branch ${node.type === "branch" ? branch === "otherwise" ? "otherwise" : "orderedPath" : branch}`} aria-label={`${branchLabel(node, branch)} branch of ${node.key}`}>
                  <div className="branchLabel">{branchLabel(node, branch)}</div>
                  <StepList
                    nodes={branchSteps(node, branch)}
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
      {editable && !(last && terminal(last)) ? (
        <li className="stepItem">
          <AddStep onPick={(type) => actions!.insert(path, nodes.length, type)} end={nodes.length === 0} />
        </li>
      ) : null}
      {!editable && nodes.length === 0 ? <li className="stepEnd dim">{path.length ? "Exit" : "End"}</li> : null}
    </ol>
  );
}

const pickerGroups: StepType[][] = [
  ["send_email"],
  ["delay", "wait_for_event", "condition", "branch", "filter", "exit"],
  ["contact_update", "contact_delete", "add_to_segment"],
];

/** The "+" between steps that opens the step picker. */
export function AddStep({ onPick, end = false, allowExit = true }: { onPick: (type: StepType) => void; end?: boolean; allowExit?: boolean }) {
  const items: MenuItem[] = pickerGroups.flatMap((group, index) => [
    ...(index ? (["divider"] as MenuItem[]) : []),
    ...group.map((type) => ({
      label: stepLabels[type], icon: stepIcons[type], onSelect: () => onPick(type),
      disabled: type === "exit" && !allowExit,
      hint: type === "exit" && !allowExit ? "Only at the end of a path" : undefined,
    })),
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
            {end ? "Add step" : <span className="addStepName">Add step</span>}
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
          {node.type === "send_email" ? <Badge value={sendKind(node.config)} label={kindLabels[sendKind(node.config)]} /> : null}
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
      {node.type === "send_email" && options?.emailCounts ? <EmailCountLine counts={options.emailCounts[node.key]} /> : null}
      {!run && errors[stepError] ? (
        <p className="fieldError" role="alert">
          {errors[stepError]}
        </p>
      ) : null}
    </article>
  );
}

export function RunResult({ node, result }: { node: Node; result?: RunStep }) {
  const output = result?.output as { exited?: string; filter?: string; path?: string; passed?: boolean } | undefined;
  return (
    <div className="stack">
      <p className="muted">{describe(node)}</p>
      {node.type === "send_email" ? <p className="fieldHint">{sendSemantics[sendKind(node.config)]}</p> : null}
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
      {output?.exited === "filter" ? <p role="status">Left at the Filter step{output.filter ? ` (${output.filter})` : ""}. No further steps ran.</p> : null}
      {node.type === "filter" && output?.passed === true ? <p role="status">Filter matched{node.config.scope === "following" ? "; it will be checked before every following step" : ""}.</p> : null}
      {node.type === "branch" && output?.path ? <p role="status">Took the {branchLabel(node, output.path)} path.</p> : null}
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
  const fields = contextFields({
    events: options?.eventDefinitions, properties: options?.contactProperties, topics: options?.topics, segments: options?.segments,
  }, node.type === "wait_for_event" ? String(config.event_name ?? "") : options?.eventName);
  const set = (field: string, value: unknown) =>
    actions?.change(node.key, (current) => ({ ...current, config: { ...current.config, [field]: value } }));
  const setRuleTypes = (ruleTypes: Record<string, PropertyType>) =>
    actions?.change(node.key, (current) => ({ ...current, ruleTypes }));
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
            onChange={(id) => actions?.change(node.key, (current) => ({
              ...current, config: {
                ...current.config, template: { ...template, id },
                ...(templates.find((item) => item.value === id)?.kind === "marketing" ? { kind: "marketing" } : {}),
              },
            }))}
            options={choices}
            placeholder="Choose a template"
            error={errors.template}
            disabled={disabled}
            required
          />
          <SendKindControl
            key={template.id ?? ""}
            node={node}
            templateId={template.id}
            templateKind={templates.find((item) => item.value === template.id)?.kind}
            actions={actions}
            disabled={disabled}
            error={errors.kind}
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
          {sendKind(config) === "marketing" || config.topic_id ? <Select
            label="Topic"
            value={text("topic_id")}
            onChange={(value) => set("topic_id", value)}
            placeholder="Choose a topic"
            options={options?.topics ?? []}
            hint="Required before starting Marketing emails. You can save a draft without a topic."
            error={errors.topic_id}
            disabled={disabled || sendKind(config) === "transactional"}
          /> : null}
          {config.topic_id && template.id ? <UnsubscribeWarning templateId={template.id} /> : null}
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
          <VariableMappings
            mapping={(config.variable_mapping ?? {}) as Record<string, string>}
            onChange={(mapping) => set("variable_mapping", mapping)}
            fields={fields}
            disabled={disabled}
            error={errors.variable_mapping}
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
            hint='Examples: "2 days", "1 hour". Up to 30 days.'
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
              hint="Run different steps when the event arrives and when the wait times out. Empty paths end at an Exit step."
              checked={Boolean(node.branches)}
              disabled={disabled || Boolean(node.branches?.timeout?.some((step) => step.type !== "exit"))}
              onChange={(on) => actions?.waitBranches(path, index, on)}
            />
            <Switch
              label="Only match some events"
              hint="Resume only when the event payload passes a rule."
              checked={Boolean(config.filter_rule)}
              disabled={disabled}
              onChange={(on) => actions?.change(node.key, (current) => ({
                ...current, ruleTypes: {}, config: { ...current.config, filter_rule: on ? { type: "rule", field: "event.", operator: "eq", value: "" } : undefined },
              }))}
            />
            {config.filter_rule ? (
              <RuleEditor rule={config.filter_rule as Rule} onChange={(rule) => set("filter_rule", rule)} disabled={disabled} fields={fields} valueTypes={node.ruleTypes} onTypesChange={setRuleTypes} />
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
            fields={fields}
            valueTypes={node.ruleTypes}
            onTypesChange={setRuleTypes}
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
    case "filter":
      return (
        <div className="stack">
          <RuleEditor rule={(config.rule as Rule) ?? emptyRule()} onChange={(rule) => set("rule", rule)} disabled={disabled} fields={fields} valueTypes={node.ruleTypes} onTypesChange={setRuleTypes} />
          {errors.rule ? <span className="fieldError" role="alert">{errors.rule}</span> : null}
          <Select
            label="Check"
            value={text("scope")}
            onChange={(value) => set("scope", value)}
            options={[{ value: "next", label: "Here only" }, { value: "following", label: "Before every following step" }]}
            hint="If the rule fails, the contact leaves this run. Following filters use fresh contact data before each later step."
            error={errors.scope}
            disabled={disabled}
          />
        </div>
      );
    case "branch":
      return <BranchEditor node={node} actions={actions} disabled={disabled} fields={fields} errors={errors} />;
    case "exit":
      return <p className="muted">End this run here. No following step runs.</p>;
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

/** The ordered lanes and their rules. Keys stay fixed through rename and reorder. */
function BranchEditor({ node, actions, disabled, fields, errors }: {
  node: Node; actions?: StepActions; disabled: boolean; fields: ContextFieldRow[]; errors: Record<string, string>;
}) {
  const paths = configuredPaths(node);
  const [removing, setRemoving] = useState<string | null>(null);
  const edit = (change: (current: Node) => Node) => {
    if (!disabled) actions?.change(node.key, change);
  };
  const update = (key: string, change: (path: (typeof paths)[number]) => (typeof paths)[number]) =>
    edit((current) => setBranchPaths(current, configuredPaths(current).map((path) => path.key === key ? change(path) : path)));
  const move = (key: string, delta: -1 | 1) => edit((current) => {
    const ordered = [...configuredPaths(current)];
    const index = ordered.findIndex((path) => path.key === key);
    if (index < 0 || index + delta < 0 || index + delta >= ordered.length) return current;
    [ordered[index], ordered[index + delta]] = [ordered[index + delta]!, ordered[index]!];
    return setBranchPaths(current, ordered);
  });
  const remove = (key: string) => {
    edit((current) => {
      const ordered = configuredPaths(current);
      if (ordered.length <= 2) return current;
      const ruleTypes = Object.fromEntries(Object.entries(current.ruleTypes ?? {}).filter(([location]) => location !== `paths.${key}` && !location.startsWith(`paths.${key}.`)));
      return { ...setBranchPaths(current, ordered.filter((path) => path.key !== key)), ruleTypes };
    });
    setRemoving(null);
  };
  const removedPath = paths.find((path) => path.key === removing);
  const count = removing ? branchSteps(node, removing).reduce((sum, child) => sum + 1 + descendants(child), 0) : 0;
  return (
    <div className="stack branchEditor">
      <p className="fieldHint">Checked from top to bottom. The first matching path wins. If none match, use Otherwise.</p>
      {paths.map((path, index) => (
        <section className="branchRule" key={path.key} aria-label={`Path ${index + 1} settings`}>
          <header className="stepHeader">
            <strong className="stepTitle">Path {index + 1}</strong>
            <span className="mono dim">{path.key}</span>
            <div className="toolbar">
              <button type="button" className="ghost icon small" aria-label={`Move path ${index + 1} up`} disabled={disabled || index === 0} onClick={() => move(path.key, -1)}><ArrowUp size={14} /></button>
              <button type="button" className="ghost icon small" aria-label={`Move path ${index + 1} down`} disabled={disabled || index === paths.length - 1} onClick={() => move(path.key, 1)}><ArrowDown size={14} /></button>
              <button type="button" className="ghost icon small" aria-label={`Remove path ${index + 1}`} disabled={disabled || paths.length <= 2} onClick={() => {
                if (branchSteps(node, path.key).some((child) => child.type !== "exit")) setRemoving(path.key);
                else remove(path.key);
              }}><Trash2 size={14} /></button>
            </div>
          </header>
          <Field label="Path label" value={path.label} onChange={(label) => update(path.key, (current) => ({ ...current, label }))} disabled={disabled} error={errors[`path.${path.key}.label`]} required />
          <RuleEditor
            rule={path.rule ?? emptyRule()}
            onChange={(rule) => update(path.key, (current) => ({ ...current, rule }))}
            disabled={disabled}
            fields={fields}
            valueTypes={node.ruleTypes}
            onTypesChange={(ruleTypes) => edit((current) => ({ ...current, ruleTypes }))}
            location={`paths.${path.key}`}
          />
          {errors[`path.${path.key}.rule`] ? <span className="fieldError" role="alert">{errors[`path.${path.key}.rule`]}</span> : null}
        </section>
      ))}
      {errors.paths ? <span className="fieldError" role="alert">{errors.paths}</span> : null}
      <div className="toolbar">
        <button type="button" className="secondary small" disabled={disabled || paths.length >= 10} onClick={() => edit((current) => {
          const ordered = configuredPaths(current);
          if (ordered.length >= 10) return current;
          let key: string;
          do { key = `path_${keys.suffix()}`; } while (ordered.some((path) => path.key === key));
          return setBranchPaths(current, [...ordered, { key, label: `Path ${ordered.length + 1}`, rule: emptyRule() }]);
        })}><Plus size={14} />Add path</button>
        <span className="fieldHint">2 to 10 paths, plus Otherwise.</span>
      </div>
      <p className="fieldHint">Otherwise is always last and needs no rule. Empty paths end at an Exit step.</p>
      <Modal
        isOpen={Boolean(removedPath)}
        title="Remove path"
        onClose={() => setRemoving(null)}
        onSubmit={() => removing && remove(removing)}
        submitLabel="Remove path"
        submitDisabled={disabled || paths.length <= 2}
        danger
      >
        <p>This removes the {removedPath?.label} path and its {count} {count === 1 ? "step" : "steps"}. Other path keys and steps stay unchanged.</p>
      </Modal>
    </div>
  );
}

type KindControlProps = {
  node: Node; templateId?: string; templateKind?: SendKind;
  actions?: StepActions; disabled: boolean; error?: string;
};

/** Only older list responses need the detail-content fallback. */
function SendKindControl(props: KindControlProps) {
  if (props.templateId && !props.templateKind) return <LoadedSendKind {...props} />;
  return <KindChoices {...props} />;
}

function LoadedSendKind(props: KindControlProps) {
  const detail = useResource<Template>(`/templates/${encodeURIComponent(props.templateId!)}`);
  return <KindChoices {...props} templateKind={detail.data ? templateKind(detail.data) : undefined} />;
}

function KindChoices({ node, templateKind: template, actions, disabled, error }: KindControlProps) {
  const reasonId = useId();
  const kind = sendKind(node.config);
  const marketing = template === "marketing";
  useEffect(() => {
    // Also covers a selection whose older list entry needed a detail request.
    if (marketing && !disabled && actions && kind !== "marketing") {
      actions.change(node.key, (current) => ({ ...current, config: { ...current.config, kind: "marketing" } }));
    }
  }, [marketing, disabled, actions, node.key, kind]);
  const choose = (next: SendKind) => {
    if (disabled || (next === "transactional" && marketing)) return;
    actions?.change(node.key, (current) => {
      const config: Record<string, unknown> = { ...current.config, kind: next };
      if (next === "transactional") delete config.topic_id;
      return { ...current, config };
    });
  };
  return (
    <fieldset className="field sendKind">
      <legend>Email kind</legend>
      <div className="toolbar">
        {(["transactional", "marketing"] as const).map((value) => (
          <label key={value}>
            <input type="radio" name={`kind-${reasonId}`} value={value} checked={kind === value}
              onChange={() => choose(value)} disabled={disabled || (value === "transactional" && marketing)}
              aria-describedby={value === "transactional" && marketing ? reasonId : undefined} />
            {kindLabels[value]}
          </label>
        ))}
      </div>
      {marketing ? <span id={reasonId} className="fieldHint">Transactional is unavailable: this is a Marketing template (library kind or unsubscribe placeholder).</span> : null}
      <span className="fieldHint">{sendSemantics[kind]}</span>
      {error ? <span className="fieldError" role="alert">{error}</span> : null}
    </fieldset>
  );
}

function UnsubscribeWarning({ templateId }: { templateId: string }) {
  type Content = { html?: string | null; text?: string | null };
  const template = useResource<Content & { published_version_id?: string; current_version_id?: string }>(`/templates/${encodeURIComponent(templateId)}`);
  const publishedId = template.data?.published_version_id;
  const needsPublished = Boolean(publishedId && template.data?.current_version_id !== publishedId);
  const published = useResource<{ data: Array<Content & { id: string }> }>(needsPublished ? `/templates/${encodeURIComponent(templateId)}/versions` : null);
  const version = needsPublished ? published.data?.data.find((row) => row.id === publishedId) : template.data;
  if (!version || contentKind(version) === "marketing") return null;
  return <p className="fieldHint wide" role="status">This email has no unsubscribe link. The header is added, but most mail apps also expect a link in the body.</p>;
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
  not_contains: "does not contain",
  within: "within the last",
  not_within: "not within the last",
  starts_with: "starts with",
  ends_with: "ends with",
  exists: "exists",
  is_empty: "is empty",
};

const blankRule: Rule = { type: "rule", field: "", operator: "eq", value: "" };

/** Keep manual types attached to their rules when grouping or removing a sibling. */
function moveRuleTypes(types: Record<string, PropertyType>, location: string, operation: "wrap" | "unwrap" | number) {
  const prefix = location ? `${location}.` : "";
  return Object.fromEntries(Object.entries(types).flatMap(([key, type]) => {
    if (key !== location && !key.startsWith(prefix)) return [[key, type]];
    const rest = key === location ? "" : key.slice(prefix.length);
    if (operation === "wrap") return [[`${prefix}0${rest ? `.${rest}` : ""}`, type]];
    if (operation === "unwrap") {
      if (rest !== "0" && !rest.startsWith("0.")) return [];
      const tail = rest.slice(2);
      return [[tail ? `${prefix}${tail}` : location, type]];
    }
    const [first, ...tail] = rest.split(".");
    const index = Number(first);
    if (index === operation) return [];
    return [[index > operation ? `${prefix}${index - 1}${tail.length ? `.${tail.join(".")}` : ""}` : key, type]];
  }));
}

/** One rule, or an all-of / any-of group of rules, as the core `ruleSchema` defines them. */
export function RuleEditor({ rule, onChange, disabled = false, depth = 0, fields = [], valueTypes = {}, onTypesChange, location = "" }: {
  rule: Rule; onChange: (rule: Rule) => void; disabled?: boolean; depth?: number; fields?: ContextFieldRow[];
  valueTypes?: Record<string, PropertyType>; onTypesChange?: (types: Record<string, PropertyType>) => void; location?: string;
}) {
  const mode = rule?.type === "and" || rule?.type === "or" ? rule.type : "rule";
  const rowTypes = (at: string) => ({
    manualType: valueTypes[at],
    onTypeChange: onTypesChange ? (type: PropertyType) => onTypesChange({ ...valueTypes, [at]: type }) : undefined,
  });
  const setMode = (next: string) => {
    if (next === mode) return;
    if (next === "rule") {
      onTypesChange?.(moveRuleTypes(valueTypes, location, "unwrap"));
      onChange(rule.type === "rule" ? rule : (rule.rules[0] ?? blankRule));
    } else {
      if (rule.type === "rule") onTypesChange?.(moveRuleTypes(valueTypes, location, "wrap"));
      onChange(rule.type === "rule" ? { type: next as "and" | "or", rules: [rule] } : { ...rule, type: next as "and" | "or" });
    }
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
        <RuleRow rule={rule} onChange={onChange} disabled={disabled} fields={fields} {...rowTypes(location)} />
      ) : (
        <div className="stack">
          {rule.rules.map((child, index) => (
            <div key={index} className="ruleChild">
              {child.type === "rule" ? (
                <RuleRow
                  rule={child}
                  onChange={(next) => onChange({ ...rule, rules: rule.rules.map((item, at) => (at === index ? next : item)) })}
                  disabled={disabled}
                  fields={fields}
                  {...rowTypes(`${location ? `${location}.` : ""}${index}`)}
                />
              ) : (
                <RuleEditor
                  rule={child}
                  depth={depth + 1}
                  onChange={(next) => onChange({ ...rule, rules: rule.rules.map((item, at) => (at === index ? next : item)) })}
                  disabled={disabled}
                  fields={fields}
                  valueTypes={valueTypes}
                  onTypesChange={onTypesChange}
                  location={`${location ? `${location}.` : ""}${index}`}
                />
              )}
              <button
                type="button"
                className="ghost icon small"
                aria-label="Remove rule"
                disabled={disabled || rule.rules.length <= 1}
                onClick={() => {
                  onTypesChange?.(moveRuleTypes(valueTypes, location, index));
                  onChange({ ...rule, rules: rule.rules.filter((_, at) => at !== index) });
                }}
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

function RuleRow({ rule, onChange, disabled, fields, manualType: savedType, onTypeChange }: {
  rule: Extract<Rule, { type: "rule" }>; onChange: (rule: Rule) => void; disabled: boolean; fields: ContextFieldRow[];
  manualType?: PropertyType; onTypeChange?: (type: PropertyType) => void;
}) {
  const unary = rule.operator === "exists" || rule.operator === "is_empty";
  const window = rule.operator === "within" || rule.operator === "not_within";
  const known = fields.find((field) => field.path === rule.field);
  const [localType, setLocalType] = useState<PropertyType>();
  const manualType = savedType ?? (onTypeChange ? undefined : localType) ?? (window || isIsoDate(rule.value) ? "date" : valueKind(rule.value));
  const setManualType = (type: PropertyType) => {
    setLocalType(type);
    onTypeChange?.(type);
  };
  const kind = known?.type ?? manualType;
  const convert = (type: typeof kind): unknown => {
    if (type === "boolean") return rule.value === true || rule.value === "true";
    if (type === "number") return Number.isFinite(Number(rule.value)) ? Number(rule.value) : 0;
    if (type === "date") return isIsoDate(rule.value) ? rule.value : "";
    return String(rule.value ?? "");
  };
  const changeType = (type: typeof kind, field = rule.field) => {
    const choices = operatorsForType(type);
    const operator = choices.includes(rule.operator) ? rule.operator : choices[0]!;
    const next: Rule = { ...rule, field, operator };
    if (operator === "exists" || operator === "is_empty") delete next.value;
    else next.value = operator === "within" || operator === "not_within" ? rule.value : convert(type);
    onChange(next);
  };
  const allowed = operatorsForType(kind);
  // Loaded incompatible operators are visible, never silently rewritten by opening the editor.
  const operatorOptions = allowed.includes(rule.operator) ? allowed : [rule.operator, ...allowed];
  const raw = typeof rule.value === "number" && !Number.isFinite(rule.value) ? "" : String(rule.value ?? "");
  return (
    <div className="ruleRow">
      <ContextField value={rule.field} onChange={(field) => {
        const selected = fields.find((item) => item.path === field);
        if (selected) {
          setManualType(selected.type === "set" ? "string" : selected.type);
          changeType(selected.type, field);
        } else changeType(manualType, field);
      }} fields={fields} disabled={disabled} />
      <Select
        label="Operator"
        value={rule.operator}
        onChange={(operator) => {
          const next: Rule = { ...rule, operator };
          if (operator === "exists" || operator === "is_empty") delete (next as { value?: unknown }).value;
          else if (operator === "within" || operator === "not_within") next.value = window ? rule.value : "1 day";
          else if (window || next.value === undefined) next.value = convert(kind);
          onChange(next);
        }}
        options={operatorOptions.map((value) => ({ value, label: operatorLabels[value] ?? value }))}
        disabled={disabled}
      />
      {unary ? null : (
        <>
          {!known ? <Select
            label="Type"
            value={kind}
            onChange={(next) => {
              setManualType(next as PropertyType);
              changeType(next as PropertyType);
            }}
            options={propertyTypes}
            disabled={disabled}
          /> : <Field label="Type" value={kind} onChange={() => undefined} disabled />}
          {window ? (
            <Field label="Duration" value={raw} onChange={(value) => onChange({ ...rule, value })} placeholder="7 days" hint="Inclusive, from now minus this duration through now." disabled={disabled} />
          ) : kind === "set" ? (
            <Select
              label="Value"
              value={raw}
              onChange={(value) => onChange({ ...rule, value })}
              options={raw && !known?.choices?.some((choice) => choice.value === raw) ? [{ value: raw, label: raw }, ...(known?.choices ?? [])] : known?.choices ?? []}
              placeholder="Choose a member"
              disabled={disabled}
            />
          ) : (
            <TypedValue
              key={`${rule.field}:${kind}`}
              type={kind}
              value={raw}
              onChange={(value) => {
                onChange({ ...rule, value: kind === "number" && !value.trim() ? Number.NaN : typedValue(kind, value) ?? "" });
              }}
              error={valueIssue(kind, raw)}
              disabled={disabled}
            />
          )}
        </>
      )}
    </div>
  );
}

function VariableMappings({ mapping, onChange, fields, disabled, error }: {
  mapping: Record<string, string>; onChange: (mapping: Record<string, string>) => void; fields: ContextFieldRow[]; disabled: boolean; error?: string;
}) {
  const entries = Object.entries(mapping);
  const update = (index: number, key: string, path: string) => {
    if (entries.some(([name], at) => at !== index && name === key)) return;
    onChange(Object.fromEntries(entries.map((entry, at) => at === index ? [key, path] : entry)));
  };
  return (
    <div className="wide stack" role="group" aria-label="Variable mappings">
      <strong>Variable mappings</strong>
      <span className="fieldHint">Read a variable from the event or current contact. Mappings override literal variables above; missing fields are omitted.</span>
      {entries.map(([name, path], index) => (
        <div className="variableMapping" key={index}>
          <Field label="Variable name" value={name} onChange={(key) => update(index, key, path)} placeholder="first_name" mono disabled={disabled} />
          <ContextField label="Context field" value={path} onChange={(value) => update(index, name, value)} fields={fields} disabled={disabled} />
          <button type="button" className="ghost icon small" aria-label={`Remove mapping ${name || index + 1}`} disabled={disabled} onClick={() => onChange(Object.fromEntries(entries.filter((_, at) => at !== index)))}><Trash2 size={14} /></button>
        </div>
      ))}
      {error ? <span className="fieldError" role="alert">{error}</span> : null}
      <div><button type="button" className="secondary small" disabled={disabled || entries.some(([name]) => !name)} onClick={() => onChange(Object.fromEntries([...entries, ["", ""]]))}>Add mapping</button></div>
    </div>
  );
}