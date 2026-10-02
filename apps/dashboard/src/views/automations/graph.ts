// The automation graph as the nested list the builder edits.
//
// The API stores `steps: [{ key, type, config }]` and `connections: [{ from, to, type }]`. The
// builder shows the same thing as a tree: one ordered list after the trigger, where a condition
// (and a wait_for_event that branches) ends its list and holds one nested list per outgoing edge.

export const stepTypes = [
  "send_email",
  "delay",
  "wait_for_event",
  "condition",
  "add_to_segment",
  "contact_update",
  "contact_delete",
] as const;
export type StepType = (typeof stepTypes)[number];

export type Branch = "condition_met" | "condition_not_met" | "event_received" | "timeout";

export type Node = {
  key: string;
  type: StepType;
  config: Record<string, unknown>;
  branches?: Partial<Record<Branch, Node[]>>;
  /** Raw text of JSON fields while the user types, keyed by field name. Never sent. */
  drafts?: Record<string, string>;
};

export type Tree = { trigger: string; event: string; steps: Node[] };

export type GraphStep = { key?: string; type: string; config?: Record<string, unknown> };
export type Connection = { from: string; to: string; type?: string };
export type Graph = { steps: Array<{ key: string; type: string; config: Record<string, unknown> }>; connections: Connection[] };

/** Where a list sits: each hop names a branching step and which of its branches. Empty is the main list. */
export type ListPath = Array<{ key: string; branch: Branch }>;

export const stepLabels: Record<StepType | "trigger", string> = {
  trigger: "Trigger",
  send_email: "Send email",
  delay: "Time delay",
  wait_for_event: "Wait for event",
  condition: "True/false branch",
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

export function branchesOf(node: Pick<Node, "type" | "branches">): Branch[] {
  if (node.type === "condition") return ["condition_met", "condition_not_met"];
  if (node.type === "wait_for_event" && node.branches) return ["event_received", "timeout"];
  return [];
}

export function branching(node: Pick<Node, "type" | "branches">) {
  return branchesOf(node).length > 0;
}

export function defaultConfig(type: StepType): Record<string, unknown> {
  switch (type) {
    case "send_email":
      return { from: "", template: { id: "", variables: {} } };
    case "delay":
      return { duration: "1 hour" };
    case "wait_for_event":
      return { event_name: "" };
    case "condition":
      return { type: "rule", field: "", operator: "eq", value: "" };
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
  const out = (from: string, type: string) =>
    connections.find((connection) => connection.from === from && (connection.type ?? "default") === type)?.to ?? null;
  const seen = new Set<string>();
  let problem: string | null = null;

  const chain = (start: string | null): Node[] => {
    const list: Node[] = [];
    for (let key = start; key; ) {
      if (seen.has(key)) {
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
      key = out(key, "default");
    }
    return list;
  };

  const tree: Tree = {
    trigger: trigger?.key ?? "trigger",
    event: String(trigger?.config?.event_name ?? ""),
    steps: trigger ? chain(out(trigger.key ?? "", "default")) : [],
  };
  if (!trigger) problem ??= "This automation has no trigger step.";
  const unreached = steps.filter((step) => step.type !== "trigger" && !seen.has(step.key ?? ""));
  if (!problem && unreached.length) problem = `${unreached.length === 1 ? "One step is" : `${unreached.length} steps are`} not connected to the trigger.`;
  return { tree, problem };
}

/** Writes the tree back as the API's steps and connections. */
export function toGraph(tree: Tree): Graph {
  const steps: Graph["steps"] = [{ key: tree.trigger, type: "trigger", config: { event_name: tree.event.trim() } }];
  const connections: Connection[] = [];
  const walk = (list: Node[], from: { key: string; type: string } | null) => {
    let previous = from;
    for (const node of list) {
      steps.push({ key: node.key, type: node.type, config: cleanConfig(node) });
      if (previous) connections.push({ from: previous.key, to: node.key, type: previous.type });
      const branches = branchesOf(node);
      for (const branch of branches) walk(node.branches?.[branch] ?? [], { key: node.key, type: branch });
      previous = branches.length ? null : { key: node.key, type: "default" };
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
  const config = { ...node.config };
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
      for (const branch of Object.values(node.branches ?? {})) walk(branch ?? []);
    }
  };
  walk(tree.steps);
  return keys;
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
  return list.map((node) =>
    node.key === head!.key
      ? { ...node, branches: { ...node.branches, [head!.branch]: editList(node.branches?.[head!.branch] ?? [], rest, edit) } }
      : node,
  );
}

export function listAt(tree: Tree, path: ListPath): Node[] {
  let list = tree.steps;
  for (const hop of path) list = list.find((node) => node.key === hop.key)?.branches?.[hop.branch] ?? [];
  return list;
}

/** Inserts a new step before `index`. A new branch takes the steps after it into its first branch. */
/** `key` lets the caller pick the new step's key up front, to open it once it exists. */
export function insertStep(tree: Tree, path: ListPath, index: number, type: StepType, key = newKey(tree, type)): Tree {
  const node: Node = { key, type, config: defaultConfig(type) };
  return {
    ...tree,
    steps: editList(tree.steps, path, (list) => {
      const rest = list.slice(index);
      if (type === "condition") {
        return [...list.slice(0, index), { ...node, branches: { condition_met: rest, condition_not_met: [] } }];
      }
      return [...list.slice(0, index), node, ...rest];
    }),
  };
}

export function removeStep(tree: Tree, path: ListPath, index: number): Tree {
  return { ...tree, steps: editList(tree.steps, path, (list) => list.filter((_, at) => at !== index)) };
}

/** Swaps a step with its neighbour. Branching steps stay last in their list, so they never move. */
export function canMove(list: Node[], index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= list.length) return false;
  return !branching(list[index]!) && !branching(list[target]!);
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
      if (on) return [...list.slice(0, index), { ...node, branches: { event_received: list.slice(index + 1), timeout: [] } }];
      if (node.branches?.timeout?.length) return list;
      return [...list.slice(0, index), { ...node, branches: undefined }, ...(node.branches?.event_received ?? [])];
    }),
  };
}

export function updateNode(tree: Tree, key: string, change: (node: Node) => Node): Tree {
  const walk = (list: Node[]): Node[] =>
    list.map((node) => {
      if (node.key === key) return change(node);
      if (!node.branches) return node;
      const branches: Node["branches"] = {};
      for (const [branch, children] of Object.entries(node.branches)) branches[branch as Branch] = walk(children ?? []);
      return { ...node, branches };
    });
  return { ...tree, steps: walk(tree.steps) };
}

/** How many steps sit under a branching step. */
export function descendants(node: Node): number {
  return Object.values(node.branches ?? {}).reduce(
    (sum, list) => sum + (list ?? []).reduce((inner, child) => inner + 1 + descendants(child), 0),
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

export type Rule = { type: "rule"; field: string; operator: string; value?: unknown } | { type: "and" | "or"; rules: Rule[] };

export function ruleIssue(rule: unknown): string | null {
  const value = rule as Partial<Rule> | undefined;
  if (!value || typeof value !== "object") return "Add a rule.";
  if (value.type === "and" || value.type === "or") {
    const rules = (value as { rules?: unknown[] }).rules ?? [];
    if (!rules.length) return "A group needs at least one rule.";
    for (const child of rules) {
      const issue = ruleIssue(child);
      if (issue) return issue;
    }
    return null;
  }
  if (!String((value as { field?: string }).field ?? "").trim()) return "Every rule needs a field, such as event.plan.";
  const compared = (value as { value?: unknown }).value;
  // An emptied or half-typed number. Saved as it is, JSON would turn it into null.
  if (typeof compared === "number" && !Number.isFinite(compared)) return "Enter a number to compare with.";
  return null;
}

/** Field errors for one step, keyed by field name. */
export function stepIssues(node: Node): Record<string, string> {
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
      break;
    }
    case "delay":
      issues.duration = durationIssue(config.duration, true);
      break;
    case "wait_for_event":
      if (!String(config.event_name ?? "").trim()) issues.event_name = "Enter the event to wait for.";
      issues.timeout = durationIssue(config.timeout, false);
      // Only a timeout branch with steps in it needs a timeout. A wait that came from the API
      // with just an "event received" edge has none, and has to save unchanged.
      if (node.branches?.timeout?.length && !config.timeout) issues.timeout = "A timeout branch needs a timeout.";
      if (config.filter_rule) issues.filter_rule = ruleIssue(config.filter_rule);
      break;
    case "condition":
      issues.rule = ruleIssue(config);
      break;
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
export function treeIssues(tree: Tree): Record<string, Record<string, string>> {
  const all: Record<string, Record<string, string>> = {};
  if (!tree.event.trim()) all[tree.trigger] = { event_name: "Enter the event that starts this automation." };
  const walk = (list: Node[]) => {
    for (const node of list) {
      const issues = stepIssues(node);
      if (Object.keys(issues).length) all[node.key] = issues;
      for (const branch of Object.values(node.branches ?? {})) walk(branch ?? []);
    }
  };
  walk(tree.steps);
  return all;
}

/** The config fields each card shows an error under. Anything else goes on the card as a whole. */
const cardFields: Record<string, string[]> = {
  trigger: ["event_name"],
  send_email: ["template", "from", "to", "variables"],
  delay: ["duration"],
  wait_for_event: ["event_name", "timeout", "filter_rule"],
  condition: ["rule"],
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
      return `Template ${id || "not set"}${config.to ? ` to ${String(config.to)}` : ""}`;
    }
    case "delay":
      return `Wait ${String(config.duration ?? "")}`;
    case "wait_for_event":
      return `Wait for ${String(config.event_name ?? "")}${config.timeout ? `, up to ${String(config.timeout)}` : ""}`;
    case "condition":
      return ruleText(config as Rule);
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
  if (rule.type !== "rule") return rule.rules.map((child) => `(${ruleText(child)})`).join(` ${rule.type} `);
  const value = rule.operator === "exists" || rule.operator === "is_empty" ? "" : ` ${JSON.stringify(rule.value ?? "")}`;
  return `${rule.field} ${rule.operator.replaceAll("_", " ")}${value}`;
}
