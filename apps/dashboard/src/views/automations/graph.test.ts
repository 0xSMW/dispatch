import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  durationIssue,
  durationSeconds,
  emailIssue,
  insertStep,
  keys,
  mergeIssues,
  newKey,
  moveStep,
  placeIssues,
  removeStep,
  ruleIssue,
  setWaitBranches,
  setTrigger,
  stepIssues,
  toGraph,
  toTree,
  treeIssues,
  treeTrigger,
  triggerIssues,
  triggerLabels,
  triggerSummary,
  triggerWarning,
  automationTrigger,
  updateNode,
  type Graph,
  type TriggerConfig,
} from "./graph";
import { contextFields } from "../../lib/rules";

// New steps get a random key suffix. Tests count instead, so keys can be named.
beforeEach(() => {
  let next = 0;
  vi.spyOn(keys, "suffix").mockImplementation(() => String(++next));
});

const graph: Graph = {
  steps: [
    { key: "start", type: "trigger", config: { event_name: "user.created" } },
    { key: "welcome", type: "send_email", config: { from: "a@b.co", template: { id: "tpl_1", variables: {} } } },
    { key: "pro", type: "condition", config: { type: "rule", field: "event.plan", operator: "eq", value: "pro" } },
    { key: "upsell", type: "delay", config: { duration: "1 day" } },
    { key: "tag", type: "add_to_segment", config: { segment_id: "seg_1" } },
  ],
  connections: [
    { from: "start", to: "welcome", type: "default" },
    { from: "welcome", to: "pro", type: "default" },
    { from: "pro", to: "upsell", type: "condition_met" },
    { from: "pro", to: "tag", type: "condition_not_met" },
  ],
};

describe("toTree and toGraph", () => {
  it("reads branches into nested lists and writes the same graph back", () => {
    const { tree, problem } = toTree(graph.steps, graph.connections);
    expect(problem).toBeNull();
    expect(tree.trigger).toBe("start");
    expect(tree.event).toBe("user.created");
    expect(tree.steps.map((node) => node.key)).toEqual(["welcome", "pro"]);
    expect(tree.steps[1]!.branches?.condition_met?.map((node) => node.key)).toEqual(["upsell"]);
    expect(tree.steps[1]!.branches?.condition_not_met?.map((node) => node.key)).toEqual(["tag"]);
    expect(toGraph(tree)).toEqual({
      ...graph, steps: [{ ...graph.steps[0], config: { type: "event", event_name: "user.created" } }, ...graph.steps.slice(1)],
    });
  });

  it("reads a legacy default edge out of a condition as both branches and flags the join", () => {
    const { problem } = toTree(
      [graph.steps[0]!, graph.steps[2]!, graph.steps[3]!],
      [
        { from: "start", to: "pro" },
        { from: "pro", to: "upsell" },
      ],
    );
    expect(problem).toMatch(/More than one path/);
  });

  it("flags steps the trigger never reaches", () => {
    const { problem } = toTree(graph.steps, graph.connections.slice(0, 2));
    expect(problem).toBe("2 steps are not connected to the trigger.");
  });

  it("reads a wait with timeout edges as a branching wait", () => {
    const { tree } = toTree(
      [
        { key: "t", type: "trigger", config: { event_name: "a" } },
        { key: "w", type: "wait_for_event", config: { event_name: "b", timeout: "1 day" } },
        { key: "x", type: "contact_delete", config: {} },
      ],
      [
        { from: "t", to: "w" },
        { from: "w", to: "x", type: "timeout" },
      ],
    );
    expect(tree.steps[0]!.branches).toEqual({ event_received: [], timeout: [expect.objectContaining({ key: "x" })] });
    expect(toGraph(tree).connections).toEqual([
      { from: "t", to: "w", type: "default" },
      { from: "w", to: "w_event_received_exit", type: "event_received" },
      { from: "w", to: "x", type: "timeout" },
    ]);
  });
});

describe("contact triggers", () => {
  const configs: TriggerConfig[] = [
    { type: "event", event_name: "signup" },
    { type: "contact_created" },
    { type: "contact_updated" },
    { type: "contact_updated", field: "plan", from: "free", to: "pro" },
    { type: "contact_updated", field: "unsubscribed", from: false, to: true },
    { type: "contact_updated", field: "seats", from: 0, to: 12 },
    { type: "contact_updated", field: "renewed", from: null, to: "2026-10-03" },
    { type: "topic_subscribed", topic_id: "topic_1" },
    { type: "segment_added", segment_id: "seg_1" },
  ];
  const sources = {
    properties: [{ key: "plan", type: "string" as const }, { key: "seats", type: "number" as const }, { key: "renewed", type: "date" as const }],
    topics: [{ value: "topic_1", label: "News" }],
    segments: [{ value: "seg_1", label: "Trials" }],
  };

  it.each(configs)("preserves $type config and step edits across a graph round trip", (config) => {
    const input = { ...graph, steps: [{ ...graph.steps[0]!, config }, ...graph.steps.slice(1)] };
    const { tree, problem } = toTree(input.steps, input.connections);
    expect(problem).toBeNull();
    expect(treeTrigger(tree)).toEqual(config);
    expect(toGraph(tree)).toEqual(input);
    const edited = insertStep(tree, [], 0, "delay");
    expect(toGraph(edited).steps[0]!.config).toEqual(config);
    expect(treeIssues(edited, sources)[tree.trigger]).toBeUndefined();
  });

  it("uses shared labels and summaries, preserving native false, zero and null values", () => {
    expect(Object.values(triggerLabels)).toEqual(["Event received", "Contact added", "Contact changes", "Subscribed to topic", "Added to segment"]);
    expect(triggerSummary({ type: "contact_created" })).toBe("Any new contact");
    expect(triggerSummary({ type: "contact_updated" })).toBe("Any change");
    expect(triggerSummary({ type: "contact_updated", field: "plan", from: "free", to: "pro" })).toBe("plan: free → pro");
    expect(triggerSummary({ type: "contact_updated", field: "unsubscribed", from: false, to: true })).toBe("unsubscribed: false → true");
    expect(triggerSummary({ type: "contact_updated", field: "seats", from: null, to: 0 })).toBe("seats: No value → 0");
    expect(triggerSummary({ type: "topic_subscribed", topic_id: "topic_1" }, sources)).toBe("News");
    expect(triggerSummary({ type: "segment_added", segment_id: "seg_1" }, sources)).toBe("Trials");
  });

  it("reads new list responses and legacy event rows, and resets event context when the trigger changes", () => {
    expect(automationTrigger({ trigger: "signup" })).toEqual({ type: "event", event_name: "signup" });
    expect(automationTrigger({ trigger: null, trigger_config: configs[1] })).toEqual(configs[1]);
    const tree = toTree(graph.steps, graph.connections).tree;
    const contact = setTrigger(tree, { type: "contact_created" });
    expect(contact.event).toBe("");
    expect(setTrigger(contact, { type: "event", event_name: "paid" }).event).toBe("paid");
  });

  it("validates typed bounds and does not mistake an unloaded resource list for deletion", () => {
    expect(triggerIssues({ type: "event", event_name: "@contact.created" }).event_name).toMatch(/cannot start/);
    expect(triggerIssues({ type: "contact_updated", to: true }).field).toMatch(/Choose a field/);
    expect(triggerIssues({ type: "contact_updated", field: "seats", to: "2" }, sources).to).toMatch(/number/);
    expect(triggerIssues({ type: "contact_updated", field: "seats", to: NaN }, sources).to).toMatch(/finite/);
    expect(triggerIssues({ type: "contact_updated", field: "unsubscribed", to: "false" }, sources).to).toMatch(/true or false/);
    expect(triggerIssues({ type: "contact_updated", field: "renewed", to: "2025-02-29" }, sources).to).toMatch(/ISO/);
    expect(triggerIssues({ type: "contact_updated", field: "missing" }, sources).field).toMatch(/declared/);
    expect(triggerWarning(configs[7]!)).toBeNull();
    expect(triggerWarning(configs[7]!, { topics: [] })).toBe("Its topic was deleted");
    expect(triggerWarning(configs[8]!, { segments: [] })).toBe("Its segment was deleted");
  });

  it("puts each trigger API validation issue on its actual picker", () => {
    const { cards } = placeIssues([{ key: "start", type: "trigger", config: {} }],
      ["type", "field", "from", "to", "topic_id", "segment_id"].map((field) => ({ path: `steps.0.config.${field}`, message: `Invalid ${field}` })));
    expect(cards.start).toEqual({
      type: "Invalid type", field: "Invalid field", from: "Invalid from", to: "Invalid to", topic_id: "Invalid topic_id", segment_id: "Invalid segment_id",
    });
  });
});

describe("editing", () => {
  const base = toTree(graph.steps, graph.connections).tree;

  it("inserts a step with a unique key and default config", () => {
    const tree = insertStep(base, [], 1, "delay");
    expect(tree.steps.map((node) => node.key)).toEqual(["welcome", "delay_1", "pro"]);
    expect(tree.steps[1]!.config).toEqual({ duration: "1 hour" });
    expect(toGraph(tree).connections.slice(0, 2)).toEqual([
      { from: "start", to: "welcome", type: "default" },
      { from: "welcome", to: "delay_1", type: "default" },
    ]);
  });

  it("moves the steps after a new condition into its True branch", () => {
    const tree = insertStep(base, [], 0, "condition");
    expect(tree.steps.map((node) => node.key)).toEqual(["condition_1"]);
    expect(tree.steps[0]!.branches?.condition_met?.map((node) => node.key)).toEqual(["welcome", "pro"]);
  });

  it("inserts into a branch by path", () => {
    const tree = insertStep(base, [{ key: "pro", branch: "condition_not_met" }], 1, "contact_delete");
    expect(tree.steps[1]!.branches?.condition_not_met?.map((node) => node.key)).toEqual(["tag", "contact_delete_1"]);
    expect(toGraph(tree).connections).toContainEqual({ from: "tag", to: "contact_delete_1", type: "default" });
  });

  it("moves plain steps but never a branching one", () => {
    const tree = insertStep(base, [], 0, "delay");
    expect(moveStep(tree, [], 0, 1).steps.map((node) => node.key)).toEqual(["welcome", "delay_1", "pro"]);
    expect(moveStep(tree, [], 1, 1).steps.map((node) => node.key)).toEqual(["delay_1", "welcome", "pro"]);
  });

  it("removes a step and reconnects its neighbours", () => {
    const tree = removeStep(base, [], 0);
    expect(toGraph(tree).connections[0]).toEqual({ from: "start", to: "pro", type: "default" });
  });

  it("turns a wait's timeout branch on and off", () => {
    let tree = insertStep(base, [], 0, "wait_for_event");
    tree = setWaitBranches(tree, [], 0, true);
    expect(tree.steps).toHaveLength(1);
    expect(tree.steps[0]!.branches?.event_received?.map((node) => node.key)).toEqual(["welcome", "pro"]);
    tree = setWaitBranches(tree, [], 0, false);
    expect(tree.steps.map((node) => node.key)).toEqual(["wait_for_event_1", "welcome", "pro"]);
  });

  it("updates a nested step by key", () => {
    const tree = updateNode(base, "tag", (node) => ({ ...node, config: { segment_id: "seg_2" } }));
    expect(tree.steps[1]!.branches?.condition_not_met?.[0]!.config).toEqual({ segment_id: "seg_2" });
  });

  it("never gives a new step the key of one that was removed", () => {
    // Runs remember steps by key. With real suffixes, two keys of one type do not repeat.
    vi.restoreAllMocks();
    const made = new Set(Array.from({ length: 200 }, () => newKey(base, "delay")));
    expect(made.size).toBe(200);
    for (const key of made) expect(key).toMatch(/^delay_[a-z0-9]{1,6}$/);
    // The caller can name the key up front, which is how the canvas opens the step it just added.
    expect(insertStep(base, [], 0, "delay", "delay_mine").steps[0]!.key).toBe("delay_mine");
  });

  it("drops blank optional fields when writing", () => {
    const tree = updateNode(base, "welcome", (node) => ({ ...node, config: { ...node.config, to: "", subject: " " } }));
    expect(toGraph(tree).steps[1]!.config).toEqual({ from: "a@b.co", template: { id: "tpl_1", variables: {} } });
  });

  it("lets a send step leave out its sender and name a topic", () => {
    // A blank sender means the template's own. A blank topic means the email always sends.
    const blank = updateNode(base, "welcome", (node) => ({ ...node, config: { ...node.config, from: "", topic_id: "" } }));
    expect(toGraph(blank).steps[1]!.config).toEqual({ template: { id: "tpl_1", variables: {} } });
    expect(stepIssues({ key: "s", type: "send_email", config: { template: { id: "tpl_1" } } })).toEqual({});
    const topic = updateNode(base, "welcome", (node) => ({ ...node, config: { ...node.config, topic_id: "topic_news" } }));
    expect(toGraph(topic).steps[1]!.config).toMatchObject({ topic_id: "topic_news" });
  });
});

describe("validation", () => {
  it("checks typed values and positive finite windows without the delay's 30-day cap", () => {
    const fields = contextFields({ properties: [{ key: "renewed", type: "date" }, { key: "paid", type: "boolean" }, { key: "seats", type: "number" }] });
    const rule = (field: string, operator: string, value?: unknown) => ({ type: "rule", field, operator, value });
    expect(ruleIssue(rule("contact.renewed", "within", "60 days"), fields)).toBeNull();
    expect(ruleIssue(rule("contact.renewed", "not_within", "0 days"), fields)).toMatch(/positive duration/);
    expect(ruleIssue(rule("contact.renewed", "within", `${"9".repeat(310)} weeks`), fields)).toMatch(/positive duration/);
    expect(ruleIssue(rule("contact.renewed", "gte", "2024-02-29"), fields)).toBeNull();
    expect(ruleIssue(rule("contact.renewed", "gte", "2025-02-29"), fields)).toMatch(/ISO date/);
    expect(ruleIssue(rule("contact.paid", "eq", "false"), fields)).toMatch(/true or false/);
    expect(ruleIssue(rule("contact.paid", "eq", false), fields)).toBeNull();
    expect(ruleIssue(rule("contact.seats", "eq", "2"), fields)).toMatch(/number/);
    expect(ruleIssue(rule("contact.seats", "contains", 2), fields)).toMatch(/operator/);
    expect(ruleIssue(rule("contact.topics", "contains", ""), fields)).toMatch(/topic or segment/);
    expect(ruleIssue({ type: "and", rules: [rule("contact.renewed", "within", "tomorrow")] }, fields)).toMatch(/positive duration/);
  });

  it("validates wait filters with the waited event and mappings without touching literals", () => {
    const literal = { plan: "event.plan", paid: false };
    const tree = toTree([
      { key: "trigger", type: "trigger", config: { event_name: "signup" } },
      { key: "wait", type: "wait_for_event", config: { event_name: "purchase", filter_rule: { type: "rule", field: "event.total", operator: "gt", value: "2" } } },
      { key: "send", type: "send_email", config: { template: { id: "tpl_1", variables: literal }, variable_mapping: { plan: "event.plan" } } },
    ], [{ from: "trigger", to: "wait" }, { from: "wait", to: "send" }]).tree;
    expect(treeIssues(tree, { events: [{ name: "signup", schema: { total: "string" } }, { name: "purchase", schema: { total: "number" } }] })).toEqual({ wait: { filter_rule: "Enter a number to compare with." } });
    expect(toGraph(tree).steps[2]!.config).toEqual({ template: { id: "tpl_1", variables: literal }, variable_mapping: { plan: "event.plan" } });
    expect(stepIssues({ key: "s", type: "send_email", config: { template: "tpl_1", variable_mapping: { "": "event." } } }).variable_mapping).toMatch(/variable name/);
    expect(placeIssues(toGraph(tree).steps, [{ path: "steps.2.config.variable_mapping.plan", message: "Invalid path" }]).cards).toEqual({ send: { variable_mapping: "Invalid path" } });
  });

  it("checks durations like core does", () => {
    expect(durationIssue("2 hours", true)).toBeNull();
    expect(durationIssue("30 days", true)).toBeNull();
    expect(durationIssue("31 days", true)).toMatch(/30 days/);
    expect(durationIssue("soon", true)).toMatch(/number and a unit/);
    expect(durationIssue("", false)).toBeNull();
  });

  it("reads the same units as core and no others", () => {
    expect(durationSeconds("2 hrs")).toBe(7200);
    expect(durationSeconds("90 secs")).toBe(90);
    expect(durationSeconds("1 week")).toBe(604_800);
    // Core refuses these. The old pattern read "10ms" as ten minutes.
    expect(durationSeconds("10ms")).toBeNull();
    expect(durationSeconds("5 mo")).toBeNull();
  });

  it("wants a plain address where the API does, and a number where a rule compares one", () => {
    expect(emailIssue("ada@example.com")).toBeNull();
    expect(emailIssue("")).toBeNull();
    expect(emailIssue("Ada <ada@example.com>")).toMatch(/plain address/);
    expect(stepIssues({ key: "s", type: "send_email", config: { from: "Acme <a@acme.com>", to: "Ada <ada@example.com>", template: { id: "t" } } })).toEqual({
      to: "Use a plain address, such as ada@example.com.",
    });
    expect(stepIssues({ key: "c", type: "condition", config: { type: "rule", field: "event.seats", operator: "gt", value: Number.NaN } })).toEqual({
      rule: "Enter a number to compare with.",
    });
  });

  it("lets a wait with only an event-received branch save unchanged", () => {
    const wait = { key: "w", type: "wait_for_event" as const, config: { event_name: "user.paid" } };
    expect(stepIssues({ ...wait, branches: { event_received: [{ key: "d", type: "delay", config: { duration: "1 hour" } }], timeout: [] } })).toEqual({});
    expect(stepIssues({ ...wait, branches: { event_received: [], timeout: [{ key: "d", type: "delay", config: { duration: "1 hour" } }] } })).toEqual({
      timeout: "A timeout branch needs a timeout.",
    });
  });

  it("reports field errors per step", () => {
    expect(stepIssues({ key: "s", type: "send_email", config: { from: "nope", template: { id: "" } } })).toEqual({
      from: "Use email@domain or Name <email@domain>.",
      template: "Choose a template.",
    });
    expect(stepIssues({ key: "c", type: "condition", config: { type: "and", rules: [] } })).toEqual({ rule: "A group needs at least one rule." });
    expect(stepIssues({ key: "u", type: "contact_update", config: {}, drafts: { properties: "{oops" } })).toEqual({ properties: "Not valid JSON." });
  });

  it("collects issues across the tree, including the trigger", () => {
    const tree = toTree(graph.steps, graph.connections).tree;
    expect(treeIssues(tree)).toEqual({});
    expect(treeIssues({ ...tree, event: "" })).toEqual({ start: { event_name: "Enter the event that starts this automation." } });
  });
});

describe("placeIssues", () => {
  it("maps steps.<n>.config.<field> to the n-th sent step and its field", () => {
    const { cards, rest } = placeIssues(graph.steps, [
      { path: "steps.0.config.event_name", message: "Required" },
      { path: "steps.1.config.template.variables.plan", message: "Must be a string" },
      { path: "steps.2.config.value", message: "Required" },
      { path: "steps.1.type", message: "Unknown type" },
      { path: "steps.99.config.duration", message: "Lost" },
      { path: "name", message: "Too long" },
      { path: "", message: "Bad body" },
    ]);
    expect(cards).toEqual({
      start: { event_name: "Required" },
      welcome: { variables: "Must be a string", _step: "Unknown type" },
      pro: { rule: "Required" },
    });
    expect(rest).toEqual(["steps.99.config.duration: Lost", "name: Too long", "Bad body"]);
  });

  it("merges error maps per step", () => {
    expect(mergeIssues({ a: { x: "1" } }, { a: { y: "2" }, b: { z: "3" } })).toEqual({ a: { x: "1", y: "2" }, b: { z: "3" } });
  });
});
