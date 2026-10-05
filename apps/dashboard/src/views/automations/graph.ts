// The automation graph as the nested list the builder edits.
//
// The API stores `steps: [{ key, type, config }]` and `connections: [{ from, to, type }]`. The
// builder shows the same thing as a tree: one ordered list after the trigger, where a condition
// (and a wait_for_event that branches) ends its list and holds one nested list per outgoing edge.
import { contextFields, isIsoDate, operatorsForType, type ContextField, type RuleSources } from "../../lib/rules";
import type { PropertyType, SendKind } from "../../types";
import { kindLabels, sendKind } from "../../lib/emailKind";

export const stepTypes = [
  "send_email",
  "delay",
  "wait_for_event",
  "condition",
  "branch",
  "filter",
  "exit",
  "add_to_segment",
  "contact_update",
  "contact_delete",
] as const;
export type StepType = (typeof stepTypes)[number];

// Ordered branch paths use their permanent key in the same ListPath as legacy branches.
export type Branch = string;
export type BranchPath = { key: string; label: string; rule: Rule };

export type Node = {
  key: string;
  /** Display identity for a repeated terminal Exit; serialization retains its stored key. */
  sharedKey?: string;
  type: StepType;
  config: Record<string, unknown>;
  branches?: Partial<Record<Branch, Node[]>>;
  paths?: Array<{ key: string; label: string; steps: Node[] }>;
  /** Raw text of JSON fields while the user types, keyed by field name. Never sent. */
  drafts?: Record<string, string>;
  /** Manual types for undeclared fields, by rule index path. Editor-only, shared by both views. */
  ruleTypes?: Record<string, PropertyType>;
};

export type TriggerConfig =
  | { type: "event"; event_name: string }
  | { type: "contact_created" }
  | { type: "contact_updated"; field?: string; from?: string | number | boolean | null; to?: string | number | boolean | null }
  | { type: "topic_subscribed"; topic_id: string }
  | { type: "segment_added"; segment_id: string };
export type TriggerType = TriggerConfig["type"];

export const triggerChoices = [
  { value: "event", label: "An event is received" },
  { value: "contact_created", label: "A contact is added" },
  { value: "contact_updated", label: "A contact changes" },
  { value: "topic_subscribed", label: "A contact subscribes to a topic" },
  { value: "segment_added", label: "A contact is added to a segment" },
] satisfies Array<{ value: TriggerType; label: string }>;

export const triggerLabels: Record<TriggerType, string> = {
  event: "Event received",
  contact_created: "Contact added",
  contact_updated: "Contact changes",
  topic_subscribed: "Subscribed to topic",
  segment_added: "Added to segment",
};

/** Accepts legacy event configs as well as the normalized API shape. */
export function readTrigger(config: Record<string, unknown> = {}): TriggerConfig {
  if (!config.type) return { type: "event", event_name: String(config.event_name ?? "") };
  return { ...config } as TriggerConfig;
}

export function defaultTrigger(type: TriggerType): TriggerConfig {
  switch (type) {
    case "event": return { type, event_name: "" };
    case "topic_subscribed": return { type, topic_id: "" };
    case "segment_added": return { type, segment_id: "" };
    default: return { type };
  }
}

// `event` remains for older trees and callers that edit only the event name.
export type Tree = { trigger: string; event: string; triggerConfig?: TriggerConfig; steps: Node[] };

export function treeTrigger(tree: Tree): TriggerConfig {
  if (!tree.triggerConfig || tree.triggerConfig.type === "event") return { type: "event", event_name: tree.event };
  return tree.triggerConfig;
}

export function setTrigger(tree: Tree, config: TriggerConfig): Tree {
  return { ...tree, triggerConfig: config, event: config.type === "event" ? config.event_name : "" };
}

export function automationTrigger(row: { trigger?: string | null; trigger_config?: TriggerConfig; steps?: GraphStep[] }): TriggerConfig {
  const config = row.trigger_config ?? row.steps?.find((step) => step.type === "trigger")?.config;
  return config ? readTrigger(config) : { type: "event", event_name: row.trigger ?? "" };
}

export function triggerSummary(config: TriggerConfig, sources: RuleSources = {}): string {
  const value = (item: unknown) => item === null ? "No value" : String(item);
  switch (config.type) {
    case "event": return config.event_name;
    case "contact_created": return "Any new contact";
    case "contact_updated": {
      if (!config.field) return "Any change";
      if (config.from === undefined && config.to === undefined) return `${config.field}: Any change`;
      return `${config.field}: ${config.from === undefined ? "Any value" : value(config.from)} → ${config.to === undefined ? "Any value" : value(config.to)}`;
    }
    case "topic_subscribed": return sources.topics?.find((row) => row.value === config.topic_id)?.label ?? config.topic_id;
    case "segment_added": return sources.segments?.find((row) => row.value === config.segment_id)?.label ?? config.segment_id;
  }
}

/** An absent source means it has not loaded, not that the resource was deleted. */
export function triggerWarning(config: TriggerConfig, sources: RuleSources = {}): string | null {
  if (config.type === "topic_subscribed" && config.topic_id && sources.topics && !sources.topics.some((row) => row.value === config.topic_id)) {
    return "Its topic was deleted";
  }
  if (config.type === "segment_added" && config.segment_id && sources.segments && !sources.segments.some((row) => row.value === config.segment_id)) {
    return "Its segment was deleted";
  }
  return null;
}

export function triggerFields(properties: RuleSources["properties"] = []) {
  return contextFields({ properties }).filter((field) => field.group === "Contact")
    .map((field) => ({ key: field.path.slice("contact.".length), type: field.type as PropertyType }));
}

export function triggerIssues(config: TriggerConfig, sources: RuleSources = {}): Record<string, string> {
  const issues: Record<string, string> = {};
  switch (config.type) {
    case "event":
      if (!config.event_name.trim()) issues.event_name = "Enter the event that starts this automation.";
      else if (config.event_name.trim().startsWith("@")) issues.event_name = "Event names cannot start with @.";
      break;
    case "contact_updated": {
      if (!config.field) {
        if (config.from !== undefined || config.to !== undefined) issues.field = "Choose a field to match From or To.";
        break;
      }
      const field = triggerFields(sources.properties).find((item) => item.key === config.field);
      if (!field) {
        if (sources.properties) issues.field = "Choose a built-in field or a declared contact property.";
        break;
      }
      for (const key of ["from", "to"] as const) {
        const value = config[key];
        if (value === undefined || value === null) continue;
        if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) issues[key] = "Enter a finite number.";
        if (field.type === "boolean" && typeof value !== "boolean") issues[key] = "Choose true or false.";
        if (field.type === "string" && typeof value !== "string") issues[key] = "Enter a string.";
        if (field.type === "date" && !isIsoDate(value)) issues[key] = "Use an ISO date or a timestamp with a timezone.";
      }
      break;
    }
    case "topic_subscribed":
      if (!config.topic_id) issues.topic_id = "Choose a topic.";
      else if (triggerWarning(config, sources)) issues.topic_id = "Its topic was deleted";
      break;
    case "segment_added":
      if (!config.segment_id) issues.segment_id = "Choose a segment.";
      else if (triggerWarning(config, sources)) issues.segment_id = "Its segment was deleted";
      break;
  }
  return issues;
}

export type GraphStep = { key?: string; type: string; config?: Record<string, unknown> };
export type Connection = { from: string; to: string; type?: string; path?: string };
export type Graph = { steps: Array<{ key: string; type: string; config: Record<string, unknown> }>; connections: Connection[] };

/** Where a list sits: each hop names a branching step and which of its branches. Empty is the main list. */
export type ListPath = Array<{ key: string; branch: Branch }>;

export const stepLabels: Record<StepType | "trigger", string> = {
  trigger: "Trigger",
  send_email: "Send email",
  delay: "Delay",
  wait_for_event: "Wait for event",
  condition: "Condition",
  branch: "Branch",
  filter: "Filter",
  exit: "Exit",
  add_to_segment: "Add to segment",
  contact_update: "Update contact",
  contact_delete: "Delete contact",
};

export const branchLabels: Record<Branch, string> = {
  condition_met: "True",
  condition_not_met: "False",
  event_received: "Event received",
  timeout: "Timed out",
};

export function configuredPaths(node: Pick<Node, "config">): BranchPath[] {
  return Array.isArray(node.config.paths) ? node.config.paths as BranchPath[] : [];
}

export function branchesOf(node: Pick<Node, "type" | "branches" | "config">): Branch[] {
  if (node.type === "branch") return [...configuredPaths(node).map((path) => path.key), "otherwise"];
  if (node.type === "condition") return ["condition_met", "condition_not_met"];
  if (node.type === "wait_for_event" && node.branches) return ["event_received", "timeout"];
  return [];
}

export function branching(node: Pick<Node, "type" | "branches" | "config">) {
  return branchesOf(node).length > 0;
}

export function branchSteps(node: Node, branch: Branch): Node[] {
  return node.type === "branch" ? node.paths?.find((path) => path.key === branch)?.steps ?? [] : node.branches?.[branch] ?? [];
}

export function branchLabel(node: Node, branch: Branch): string {
  if (node.type === "branch") return branch === "otherwise" ? "Otherwise" : configuredPaths(node).find((path) => path.key === branch)?.label || branch;
  return branchLabels[branch] ?? branch;
}

export function terminal(node: Node) {
  return node.type === "exit" || branching(node);
}

export const blankRule = (): Rule => ({ type: "rule", field: "", operator: "eq", value: "" });

export function defaultConfig(type: StepType): Record<string, unknown> {
  switch (type) {
    case "send_email":
      return { kind: "transactional", from: "", template: { id: "", variables: {} } };
    case "delay":
      return { duration: "1 hour" };
    case "wait_for_event":
      return { event_name: "" };
    case "condition":
      return blankRule();
    case "filter":
      return { rule: blankRule(), scope: "next" };
    case "branch":
      return { paths: [
        { key: "path_1", label: "Path 1", rule: blankRule() },
        { key: "path_2", label: "Path 2", rule: blankRule() },
      ] };
    case "add_to_segment":
      return { segment_id: "" };
    default:
      return {};
  }
}

/**
 * Reads the API graph into a tree. `problem` is set when the graph has a shape the list cannot
 * show without losing something: two edges into one step, or steps the trigger never reaches.
 */
export function toTree(steps: GraphStep[], connections: Connection[] = []): { tree: Tree; problem: string | null } {
  const trigger = steps.find((step) => step.type === "trigger");
  const byKey = new Map(steps.map((step) => [step.key ?? "", step]));
  const out = (from: string, type: string, path?: string) =>
    connections.find((connection) => connection.from === from && (connection.type ?? "default") === type && connection.path === path)?.to ?? null;
  const seen = new Set<string>();
  const displayKeys = new Set(byKey.keys());
  let problem: string | null = null;

  const chain = (start: string | null): Node[] => {
    const list: Node[] = [];
    for (let key = start; key; ) {
      if (seen.has(key)) {
        const shared = byKey.get(key);
        if (shared?.type === "exit" && !connections.some((edge) => edge.from === key)) {
          let displayKey = `${key}_lane`;
          for (let index = 2; displayKeys.has(displayKey); index++) displayKey = `${key}_lane_${index}`;
          displayKeys.add(displayKey);
          list.push({ key: displayKey, sharedKey: key, type: "exit", config: { ...(shared.config ?? {}) } });
          break;
        }
        problem ??= `More than one path leads to step ${key}.`;
        break;
      }
      const step = byKey.get(key);
      if (!step || step.type === "trigger" || !(stepTypes as readonly string[]).includes(step.type)) {
        problem ??= `Step ${key} cannot be shown.`;
        break;
      }
      seen.add(key);
      const node: Node = { key, type: step.type as StepType, config: { ...(step.config ?? {}) } };
      if (node.type === "send_email" && node.config.kind === undefined) node.config.kind = sendKind(node.config);
      if (node.type === "branch") {
        const paths = branchesOf(node);
        const edges = connections.filter((edge) => edge.from === node.key);
        if (edges.some((edge) => edge.type !== "branch" || !edge.path || !paths.includes(edge.path)) ||
          paths.some((path) => edges.filter((edge) => edge.type === "branch" && edge.path === path).length !== 1)) {
          problem ??= `Branch ${node.key} needs exactly one connection per path, including Otherwise.`;
        }
        node.paths = branchesOf(node).map((path) => ({
          key: path, label: branchLabel(node, path), steps: chain(out(node.key, "branch", path)),
        }));
        list.push(node);
        break;
      }
      if (node.type === "condition") {
        const met = out(key, "condition_met") ?? out(key, "default");
        const unmet = out(key, "condition_not_met") ?? out(key, "default");
        node.branches = { condition_met: chain(met), condition_not_met: chain(unmet) };
        list.push(node);
        break;
      }
      if (node.type === "wait_for_event" && (out(key, "event_received") || out(key, "timeout"))) {
        const received = out(key, "event_received") ?? out(key, "default");
        const timeout = out(key, "timeout") ?? out(key, "default");
        node.branches = { event_received: chain(received), timeout: chain(timeout) };
        list.push(node);
        break;
      }
      list.push(node);
      if (node.type === "exit") {
        if (connections.some((edge) => edge.from === node.key)) problem ??= `Exit ${node.key} cannot have following steps.`;
        break;
      }
      key = out(key, "default");
    }
    return list;
  };

  const tree: Tree = {
    trigger: trigger?.key ?? "trigger",
    event: String(trigger?.config?.event_name ?? ""),
    triggerConfig: readTrigger(trigger?.config),
    steps: trigger ? chain(out(trigger.key ?? "", "default")) : [],
  };
  if (!trigger) problem ??= "This automation has no trigger step.";
  const unreached = steps.filter((step) => step.type !== "trigger" && !seen.has(step.key ?? ""));
  if (!problem && unreached.length) problem = `${unreached.length === 1 ? "One step is" : `${unreached.length} steps are`} not connected to the trigger.`;
  return { tree, problem };
}

/** Writes the tree back as the API's steps and connections. */
export function toGraph(tree: Tree): Graph {
  const trigger = treeTrigger(tree);
  const config = trigger.type === "event" ? { ...trigger, event_name: trigger.event_name.trim() } : { ...trigger };
  const steps: Graph["steps"] = [{ key: tree.trigger, type: "trigger", config }];
  const connections: Connection[] = [];
  const taken = allKeys(tree);
  const walk = (list: Node[], from: { key: string; type: string; path?: string } | null) => {
    // Legacy trees may have an empty lane. Its deterministic key keeps snapshots stable;
    // edits create a real, permanently keyed Exit in the tree instead.
    if (!list.length && from) {
      const name = `${from.key}_${from.path ?? from.type}_exit`.replace(/[^A-Za-z0-9_-]/g, "_");
      const base = name.length > 54 ? `${name.slice(0, 49)}_exit` : name;
      let key = base;
      for (let index = 2; taken.has(key); index++) key = `${base}_${index}`;
      taken.add(key);
      steps.push({ key, type: "exit", config: {} });
      connections.push({ from: from.key, to: key, type: from.type, ...(from.path ? { path: from.path } : {}) });
      return;
    }
    let previous = from;
    for (const node of list) {
      const key = node.type === "exit" ? node.sharedKey ?? node.key : node.key;
      if (!steps.some((step) => step.key === key)) steps.push({ key, type: node.type, config: cleanConfig(node) });
      if (previous) connections.push({ from: previous.key, to: key, type: previous.type, ...(previous.path ? { path: previous.path } : {}) });
      const branches = branchesOf(node);
      for (const branch of branches) walk(branchSteps(node, branch), { key: node.key, type: node.type === "branch" ? "branch" : branch, ...(node.type === "branch" ? { path: branch } : {}) });
      if (terminal(node)) break;
      previous = { key: node.key, type: "default" };
    }
  };
  walk(tree.steps, { key: tree.trigger, type: "default" });
  return { steps, connections };
}

const optional: Partial<Record<StepType, string[]>> = {
  send_email: ["from", "to", "topic_id", "subject", "reply_to"],
  wait_for_event: ["timeout"],
  add_to_segment: ["email"],
  contact_update: ["first_name", "last_name", "email"],
  contact_delete: ["email"],
};

/** Drops blank optional fields so the API's defaults apply. */
export function cleanConfig(node: Node): Record<string, unknown> {
  if (node.type === "exit") return {};
  if (node.type === "branch") return { paths: configuredPaths(node).map(({ key, label, rule }) => ({ key, label, rule })) };
  const config = { ...node.config };
  if (node.type === "send_email" && config.kind === undefined) config.kind = sendKind(config);
  for (const field of optional[node.type] ?? []) {
    const value = config[field];
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) delete config[field];
    if (Array.isArray(value) && value.length === 0) delete config[field];
  }
  return config;
}

export function allKeys(tree: Tree): Set<string> {
  const keys = new Set([tree.trigger]);
  const walk = (list: Node[]) => {
    for (const node of list) {
      keys.add(node.key);
      for (const branch of branchesOf(node)) walk(branchSteps(node, branch));
    }
  };
  walk(tree.steps);
  return keys;
}

/** Projects stored shared Exit results onto the one successfully completed display route. */
export function projectRun<T extends { status?: string; output?: unknown; error?: string | null }>(tree: Tree, results: ReadonlyMap<string, T>): Map<string, T> {
  const shared = new Set<string>();
  const collect = (list: Node[]) => {
    for (const node of list) {
      if (node.type === "exit" && node.sharedKey) shared.add(node.sharedKey);
      for (const branch of branchesOf(node)) collect(branchSteps(node, branch));
    }
  };
  collect(tree.steps);
  const projected = new Map(results);
  const candidates = new Map<string, string[]>();
  const succeeded = (node: Node) => {
    const result = results.get(node.key);
    return result?.status === "completed" && !result.error;
  };
  const selected = (node: Node): Branch | null => {
    const output = results.get(node.key)?.output;
    if (!output || typeof output !== "object") return null;
    const decision = output as Record<string, unknown>;
    if (node.type === "condition") {
      return decision.result === true ? "condition_met" : decision.result === false ? "condition_not_met" : null;
    }
    if (node.type === "branch") {
      return typeof decision.path === "string" && branchesOf(node).includes(decision.path) ? decision.path : null;
    }
    if (node.type === "wait_for_event") {
      if (decision.timed_out === true) return "timeout";
      if (decision.timed_out === false) return "event_received";
      // Resumed event waits store the firing ID, without a timed_out flag.
      if (decision.timed_out === undefined && typeof decision.event_id === "string" && decision.event_id) return "event_received";
    }
    return null;
  };
  const walk = (list: Node[], reached: boolean) => {
    for (const node of list) {
      const original = node.sharedKey ?? node.key;
      if (node.type === "exit" && shared.has(original)) {
        projected.delete(node.key);
        if (reached) candidates.set(original, [...(candidates.get(original) ?? []), node.key]);
      }
      const finished = reached && succeeded(node);
      for (const branch of branchesOf(node)) walk(branchSteps(node, branch), finished && selected(node) === branch);
      reached = finished;
    }
  };
  walk(tree.steps, true);
  for (const [original, displays] of candidates) {
    const result = results.get(original);
    if (result && displays.length === 1) projected.set(displays[0]!, result);
  }
  return projected;
}

// A run remembers its steps by key. A new step that took the key of a removed one would show
// that step's old results as its own, so a key is never reused: each gets a random suffix.
// Tests replace `suffix` to get keys they can name.
export const keys = { suffix: () => Math.random().toString(36).slice(2, 8) };

export function newKey(tree: Tree, type: StepType) {
  const taken = allKeys(tree);
  for (;;) {
    const key = `${type}_${keys.suffix()}`;
    if (!taken.has(key)) return key;
  }
}

function editList(list: Node[], path: ListPath, edit: (list: Node[]) => Node[]): Node[] {
  if (!path.length) return edit(list);
  const [head, ...rest] = path;
  return list.map((node) => {
    if (node.key !== head!.key) return node;
    const children = editList(branchSteps(node, head!.branch), rest, edit);
    if (node.type === "branch") return { ...node, paths: branchesOf(node).map((branch) => ({
      key: branch, label: branchLabel(node, branch), steps: branch === head!.branch ? children : branchSteps(node, branch),
    })) };
    return { ...node, branches: { ...node.branches, [head!.branch]: children } };
  });
}

export function listAt(tree: Tree, path: ListPath): Node[] {
  let list = tree.steps;
  for (const hop of path) {
    const node = list.find((node) => node.key === hop.key);
    list = node ? branchSteps(node, hop.branch) : [];
  }
  return list;
}

/** Inserts a new step before `index`. A new branch takes the steps after it into its first branch. */
/** `key` lets the caller pick the new step's key up front, to open it once it exists. */
export function insertStep(tree: Tree, path: ListPath, index: number, type: StepType, key = newKey(tree, type)): Tree {
  const node: Node = { key, type, config: defaultConfig(type) };
  const taken = allKeys(tree);
  taken.add(key);
  const exit = () => [exitNode(taken)];
  return {
    ...tree,
    steps: editList(tree.steps, path, (list) => {
      const rest = list.slice(index);
      if (list.slice(0, index).some(terminal)) return list;
      // Never silently discard following work when inserting a terminal Exit.
      if (type === "exit") return rest.some((step) => step.type !== "exit") ? list : [...list.slice(0, index), node];
      if (type === "condition") {
        return [...list.slice(0, index), { ...node, branches: { condition_met: rest.length ? rest : exit(), condition_not_met: exit() } }];
      }
      if (type === "branch") {
        return [...list.slice(0, index), { ...node, paths: branchesOf(node).map((branch, at) => ({
          key: branch, label: branchLabel(node, branch), steps: at === 0 && rest.length ? rest : exit(),
        })) }];
      }
      return [...list.slice(0, index), node, ...rest];
    }),
  };
}

export function removeStep(tree: Tree, path: ListPath, index: number): Tree {
  return { ...tree, steps: editList(tree.steps, path, (list) => {
    const next = list.filter((_, at) => at !== index);
    return next.length ? next : [exitNode(allKeys(tree))];
  }) };
}

function exitNode(taken: Set<string>): Node {
  let key: string;
  do { key = `exit_${keys.suffix()}`; } while (taken.has(key));
  taken.add(key);
  return { key, type: "exit", config: {} };
}

/** Changes the ordered rules without changing surviving lane or step keys. */
export function setBranchPaths(node: Node, paths: BranchPath[]): Node {
  const taken = new Set<string>();
  const collect = (step: Node) => {
    taken.add(step.key);
    for (const branch of branchesOf(step)) for (const child of branchSteps(step, branch)) collect(child);
  };
  collect(node);
  const next = { ...node, config: { paths } };
  return { ...next, paths: branchesOf(next).map((branch) => ({
    key: branch, label: branchLabel(next, branch),
    steps: branchSteps(node, branch).length ? branchSteps(node, branch) : [exitNode(taken)],
  })) };
}

/** Swaps a step with its neighbour. Branching steps stay last in their list, so they never move. */
export function canMove(list: Node[], index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= list.length) return false;
  return !terminal(list[index]!) && !terminal(list[target]!);
}

export function moveStep(tree: Tree, path: ListPath, index: number, delta: -1 | 1): Tree {
  return {
    ...tree,
    steps: editList(tree.steps, path, (list) => {
      if (!canMove(list, index, delta)) return list;
      const next = [...list];
      [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
      return next;
    }),
  };
}

/** Turns a wait's timeout branch on (the steps after it move under "Event received") or off. */
export function setWaitBranches(tree: Tree, path: ListPath, index: number, on: boolean): Tree {
  return {
    ...tree,
    steps: editList(tree.steps, path, (list) => {
      const node = list[index];
      if (!node || node.type !== "wait_for_event") return list;
      if (on) {
        const taken = allKeys(tree);
        const rest = list.slice(index + 1);
        return [...list.slice(0, index), { ...node, branches: { event_received: rest.length ? rest : [exitNode(taken)], timeout: [exitNode(taken)] } }];
      }
      if (node.branches?.timeout?.some((step) => step.type !== "exit")) return list;
      return [...list.slice(0, index), { ...node, branches: undefined }, ...(node.branches?.event_received ?? [])];
    }),
  };
}

export function updateNode(tree: Tree, key: string, change: (node: Node) => Node): Tree {
  const walk = (list: Node[]): Node[] =>
    list.map((node) => {
      if (node.key === key) return change(node);
      if (node.paths) return { ...node, paths: node.paths.map((path) => ({ ...path, steps: walk(path.steps) })) };
      if (!node.branches) return node;
      const branches: Node["branches"] = {};
      for (const [branch, children] of Object.entries(node.branches)) branches[branch as Branch] = walk(children ?? []);
      return { ...node, branches };
    });
  return { ...tree, steps: walk(tree.steps) };
}

/** How many steps sit under a branching step. */
export function descendants(node: Node): number {
  return branchesOf(node).reduce(
    (sum, branch) => sum + branchSteps(node, branch).reduce((inner, child) => inner + 1 + descendants(child), 0),
    0,
  );
}

// Validation. The API checks everything again; these catch the common mistakes on the card
// where they happen, since the API's validation message does not say which step it is about.

const units: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 };
export const maxDelaySeconds = 30 * 86_400;

/** Mirrors `durationSeconds()` in core. Returns null when the text is not a duration. */
export function durationSeconds(value: string): number | null {
  const match = value.trim().toLowerCase().match(/^(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)$/);
  if (!match) return null;
  return Number(match[1]) * units[match[2]![0]!]!;
}

export function durationIssue(value: unknown, required: boolean): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return required ? "Enter a duration, such as 1 hour." : null;
  const seconds = durationSeconds(text);
  if (seconds === null) return "Use a number and a unit, such as 30 minutes, 2 hours, or 1 day.";
  if (seconds < 1 || seconds > maxDelaySeconds) return "Must be between 1 second and 30 days.";
  return null;
}

const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function addressIssue(value: unknown, required: boolean): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return required ? "Required." : null;
  const inner = text.match(/<([^>]+)>\s*$/)?.[1] ?? text;
  return emailPattern.test(inner.trim()) ? null : "Use email@domain or Name <email@domain>.";
}

/** For fields the API reads as a bare address. `Name <email>` is refused there. */
export function emailIssue(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  return emailPattern.test(text) ? null : "Use a plain address, such as ada@example.com.";
}

export type Rule = { type: "rule"; field: string; operator: string; value?: unknown; scope?: { automation_id: string; broadcast_id?: never } | { broadcast_id: string; automation_id?: never }; window?: string } | { type: "and" | "or"; rules: Rule[] };

export function ruleIssue(rule: unknown, fields: ContextField[] = [], manualTypes: Record<string, PropertyType> = {}, location = ""): string | null {
  const value = rule as Partial<Rule> | undefined;
  if (!value || typeof value !== "object") return "Add a rule.";
  if (value.type === "and" || value.type === "or") {
    const rules = (value as { rules?: unknown[] }).rules ?? [];
    if (!rules.length) return "A group needs at least one rule.";
    for (const [index, child] of rules.entries()) {
      const issue = ruleIssue(child, fields, manualTypes, location ? `${location}.${index}` : String(index));
      if (issue) return issue;
    }
    return null;
  }
  if (!String((value as { field?: string }).field ?? "").trim()) return "Every rule needs a field, such as event.plan.";
  const compared = (value as { value?: unknown }).value;
  // An emptied or half-typed number. Saved as it is, JSON would turn it into null.
  if (typeof compared === "number" && !Number.isFinite(compared)) return "Enter a number to compare with.";
  const leaf = value as { field: string; operator: string; value?: unknown };
  const type = fields.find((field) => field.path === leaf.field)?.type ?? manualTypes[location];
  if (type && !operatorsForType(type).includes(leaf.operator)) return `Choose an operator for a ${type} field.`;
  if (leaf.operator === "exists" || leaf.operator === "is_empty") return null;
  if (leaf.operator === "within" || leaf.operator === "not_within") {
    const seconds = typeof compared === "string" ? durationSeconds(compared) : null;
    return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? null : "Enter a positive duration, such as 7 days.";
  }
  if (type === "date" && !isIsoDate(compared)) return "Use an ISO date or a timestamp with a timezone.";
  if (type === "number" && typeof compared !== "number") return "Enter a number to compare with.";
  if (type === "boolean" && typeof compared !== "boolean") return "Choose true or false.";
  if (type === "set" && (typeof compared !== "string" || !compared)) return "Choose a topic or segment.";
  return null;
}

/** Field errors for one step, keyed by field name. */
export type SendValidation = { enabled?: boolean; templateKinds?: Record<string, SendKind> };

export function stepIssues(node: Node, fields: ContextField[] = [], sending: SendValidation = {}): Record<string, string> {
  const issues: Record<string, string | null> = {};
  const config = node.config;
  for (const [field, text] of Object.entries(node.drafts ?? {})) {
    if (!text.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) issues[field] = "Must be a JSON object.";
    } catch {
      issues[field] = "Not valid JSON.";
    }
  }
  switch (node.type) {
    case "send_email": {
      // Optional: a blank sender means the template's own.
      issues.from = addressIssue(config.from, false);
      issues.to ??= emailIssue(config.to);
      const template = config.template as { id?: string } | string | undefined;
      const id = typeof template === "string" ? template : template?.id;
      if (!id) issues.template = "Choose a template.";
      if (config.kind !== undefined && config.kind !== "transactional" && config.kind !== "marketing") issues.kind = "Choose Transactional or Marketing.";
      if (sendKind(config) === "transactional") {
        if (config.topic_id) issues.topic_id = "Transactional emails cannot have a topic. Choose Marketing or remove the topic.";
        if (id && sending.templateKinds?.[id] === "marketing") issues.kind = "Marketing templates cannot send as Transactional.";
      } else if (sending.enabled && !String(config.topic_id ?? "").trim()) {
        issues.topic_id = "Choose a topic before starting a Marketing email.";
      }
      if (config.variable_mapping !== undefined) {
        const mapping = config.variable_mapping;
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) issues.variable_mapping = "Mappings must be an object.";
        else if (Object.entries(mapping).some(([name, path]) => !name.trim() || typeof path !== "string" || !/^(event|contact)\.[^\s.]+(?:\.[^\s.]+)*$/.test(path))) {
          issues.variable_mapping = "Each mapping needs a variable name and a dotted event or contact field.";
        }
      }
      break;
    }
    case "delay":
      issues.duration = durationIssue(config.duration, true);
      break;
    case "wait_for_event":
      if (!String(config.event_name ?? "").trim()) issues.event_name = "Enter the event to wait for.";
      else if (String(config.event_name).trim().startsWith("@")) issues.event_name = "Event names cannot start with @.";
      issues.timeout = durationIssue(config.timeout, false);
      // Only a timeout branch with steps in it needs a timeout. A wait that came from the API
      // with just an "event received" edge has none, and has to save unchanged.
      if (node.branches?.timeout?.some((step) => step.type !== "exit") && !config.timeout) issues.timeout = "A timeout branch needs a timeout.";
      if (config.filter_rule) issues.filter_rule = ruleIssue(config.filter_rule, fields, node.ruleTypes);
      break;
    case "condition":
      issues.rule = ruleIssue(config, fields, node.ruleTypes);
      break;
    case "filter":
      issues.rule = ruleIssue(config.rule, fields, node.ruleTypes);
      if (config.scope !== "next" && config.scope !== "following") issues.scope = "Choose when to check the filter.";
      break;
    case "branch": {
      const paths = configuredPaths(node);
      if (paths.length < 2 || paths.length > 10) issues.paths = "A branch needs 2 to 10 paths.";
      const seen = new Set<string>();
      for (const path of paths) {
        if (!path.key || path.key === "otherwise" || seen.has(path.key)) issues.paths = "Every path needs a unique key. Otherwise is reserved.";
        seen.add(path.key);
        if (!String(path.label ?? "").trim()) issues[`path.${path.key}.label`] = "Enter a path label.";
        issues[`path.${path.key}.rule`] = ruleIssue(path.rule, fields, node.ruleTypes, `paths.${path.key}`);
      }
      break;
    }
    case "add_to_segment":
      if (!config.segment_id) issues.segment_id = "Choose a segment.";
      issues.email = emailIssue(config.email);
      break;
    case "contact_update":
    case "contact_delete":
      issues.email = emailIssue(config.email);
      break;
  }
  return Object.fromEntries(Object.entries(issues).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

/** Every step's field errors, keyed by step key, plus a trigger error under `trigger`. */
export function treeIssues(tree: Tree, sources?: RuleSources, sending: SendValidation = {}): Record<string, Record<string, string>> {
  const all: Record<string, Record<string, string>> = {};
  const trigger = triggerIssues(treeTrigger(tree), sources);
  if (Object.keys(trigger).length) all[tree.trigger] = trigger;
  const walk = (list: Node[]) => {
    for (const node of list) {
      const fields = sources ? contextFields(sources, node.type === "wait_for_event" ? String(node.config.event_name ?? "") : tree.event) : [];
      const issues = stepIssues(node, fields, sending);
      if (Object.keys(issues).length) all[node.key] = issues;
      for (const branch of branchesOf(node)) walk(branchSteps(node, branch));
    }
  };
  walk(tree.steps);
  return all;
}

/** The config fields each card shows an error under. Anything else goes on the card as a whole. */
const cardFields: Record<string, string[]> = {
  trigger: ["type", "event_name", "field", "from", "to", "topic_id", "segment_id"],
  send_email: ["template", "kind", "topic_id", "from", "to", "variables", "variable_mapping"],
  delay: ["duration"],
  wait_for_event: ["event_name", "timeout", "filter_rule"],
  condition: ["rule"],
  filter: ["rule", "scope"],
  branch: ["paths"],
  add_to_segment: ["segment_id", "email"],
  contact_update: ["email", "properties"],
  contact_delete: ["email"],
};

/** The key a card uses for an error about the step as a whole. */
export const stepError = "_step";

/**
 * Puts API validation issues on the step cards their paths name. `steps` is the list that was sent,
 * so `steps.<n>` is its n-th entry. Issues that name no step come back in `rest` for the banner.
 */
export function placeIssues(steps: Graph["steps"], issues: Array<{ path: string; message: string }>) {
  const cards: Record<string, Record<string, string>> = {};
  const rest: string[] = [];
  const add = (key: string, field: string, message: string) => {
    const card = (cards[key] ??= {});
    card[field] = card[field] ? `${card[field]} ${message}` : message;
  };
  for (const issue of issues) {
    const parts = issue.path.split(".");
    const step = parts[0] === "steps" && /^\d+$/.test(parts[1] ?? "") ? steps[Number(parts[1])] : undefined;
    if (!step) {
      rest.push(issue.path ? `${issue.path}: ${issue.message}` : issue.message);
      continue;
    }
    let field = parts[2] === "config" ? (parts[3] ?? "") : "";
    if (step.type === "condition" && field) field = "rule";
    if (step.type === "branch" && field === "paths" && /^\d+$/.test(parts[4] ?? "") && (parts[5] === "label" || parts[5] === "rule")) {
      const path = (step.config.paths as BranchPath[] | undefined)?.[Number(parts[4])];
      if (path) {
        add(step.key, `path.${path.key}.${parts[5]}`, issue.message);
        continue;
      }
    }
    if (step.type === "send_email" && field === "template" && parts[4] === "variables") field = "variables";
    if (field && (cardFields[step.type] ?? []).includes(field)) add(step.key, field, issue.message);
    else add(step.key, stepError, field ? `${field}: ${issue.message}` : issue.message);
  }
  return { cards, rest };
}

/** Joins two error maps keyed by step, the second winning per field. */
export function mergeIssues(...maps: Array<Record<string, Record<string, string>>>) {
  const out: Record<string, Record<string, string>> = {};
  for (const map of maps) for (const [key, fields] of Object.entries(map)) out[key] = { ...out[key], ...fields };
  return out;
}

/** A one-line summary of a step, for the run view. */
export function describe(node: Node): string {
  const config = node.config;
  switch (node.type) {
    case "send_email": {
      const template = config.template as { id?: string } | string | undefined;
      const id = typeof template === "string" ? template : template?.id;
      return `${kindLabels[sendKind(config)]} · Template ${id || "not set"}${config.to ? ` to ${String(config.to)}` : ""}`;
    }
    case "delay":
      return String(config.duration ?? "");
    case "wait_for_event":
      return `${String(config.event_name ?? "")}${config.timeout ? `, up to ${String(config.timeout)}` : ""}`;
    case "condition":
      return ruleText(config as Rule);
    case "filter":
      return `${ruleText(config.rule as Rule)} · ${config.scope === "following" ? "all following steps" : "next step"}`;
    case "branch":
      return `${configuredPaths(node).length} paths`;
    case "exit":
      return "The run ends here";
    case "add_to_segment":
      return `Segment ${String(config.segment_id ?? "")}`;
    case "contact_update":
      return "Update the contact";
    case "contact_delete":
      return "Delete the contact";
  }
}

export function ruleText(rule: Rule | undefined): string {
  if (!rule) return "";
  if (rule.type !== "rule") return (rule.rules ?? []).map((child) => `(${ruleText(child)})`).join(` ${rule.type} `);
  const words: Record<string, string> = { eq: "is", neq: "is not", gt: "is greater than", gte: "is at least", lt: "is less than", lte: "is at most" };
  const value = rule.operator === "exists" || rule.operator === "is_empty" ? "" : ` ${JSON.stringify(rule.value ?? "")}`;
  return `${rule.field} ${words[rule.operator] ?? rule.operator.replaceAll("_", " ")}${value}`;
}
