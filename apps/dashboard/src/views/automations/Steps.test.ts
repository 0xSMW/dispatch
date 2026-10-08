import { changeControl, controlValue } from "../../testingControls";
// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { h } from "../../testing";
import { contextFields } from "../../lib/rules";
import { RuleEditor, StepForm, type StepActions, type StepOptions } from "./Steps";
import { toGraph, stepIssues, type Node, type Rule } from "./graph";

const options: StepOptions = {
  templates: [{ value: "tpl_1", label: "Welcome", kind: "transactional" }], events: ["signup", "purchase"], topics: [{ value: "topic_news", label: "News" }],
  segments: [{ value: "seg_vip", label: "VIP" }], eventName: "signup",
  eventDefinitions: [
    { id: "e1", name: "signup", schema: { plan: "string", seats: "number", paid: "boolean", expires: "date" }, created_at: "" },
    { id: "e2", name: "purchase", schema: { total: "number" }, created_at: "" },
  ],
  contactProperties: [{ object: "contact_property", id: "p1", key: "renewed", type: "date", fallback_value: null, created_at: "", updated_at: "" }],
};
const fields = contextFields({ events: options.eventDefinitions, properties: options.contactProperties, topics: options.topics, segments: options.segments }, "signup");
const blank: Rule = { type: "rule", field: "event.plan", operator: "eq", value: "pro" };

function Rules({ rule = blank, disabled = false, rows = fields }: { rule?: Rule; disabled?: boolean; rows?: typeof fields }) {
  const [current, setCurrent] = useState(rule);
  return h("div", null, h(RuleEditor, { rule: current, onChange: setCurrent, disabled, fields: rows }), h("output", { "data-testid": "rule" }, JSON.stringify(current)));
}
function Form({ initial, disabled = false }: { initial: Node; disabled?: boolean }) {
  const [node, setNode] = useState(initial);
  const [visible, setVisible] = useState(true);
  const actions: StepActions = {
    insert: () => undefined, remove: () => undefined, move: () => undefined, waitBranches: () => undefined,
    change: (_key, change) => setNode((current) => change(current)),
  };
  return h("div", null,
    h("button", { onClick: () => setVisible(!visible), disabled }, "Toggle form"),
    visible ? h(StepForm, { node, path: [], index: 0, actions, disabled, options, errors: stepIssues(node) }) : null,
    h("output", { "data-testid": "node" }, JSON.stringify(node)),
    h("output", { "data-testid": "graph" }, JSON.stringify(toGraph({ trigger: "trigger", event: "signup", steps: [node] }))),
  );
}
const ruleValue = () => JSON.parse(screen.getByTestId("rule").textContent!);
const config = () => JSON.parse(screen.getByTestId("graph").textContent!).steps[1].config;
const choose = (field: string) => changeControl(screen.getByLabelText("Choose field"), { target: { value: field } });
afterEach(cleanup);

describe("RuleEditor", () => {
  it("groups the shared context picker and stores native boolean and number values", () => {
    render(h(Rules));
    const picker = screen.getByLabelText("Choose field");
    expect([...picker.parentElement!.querySelectorAll("optgroup")].map((group) => group.label)).toEqual(["Event", "Contact", "Topics", "Segments"]);
    choose("event.paid");
    expect(screen.getByLabelText("Type")).toHaveProperty("disabled", true);
    expect([...screen.getByLabelText("Operator").parentElement!.querySelectorAll("option")].map((option) => option.value)).toEqual(["eq", "neq", "exists", "is_empty"]);
    changeControl(screen.getByLabelText("Value"), { target: { value: "true" } });
    expect(ruleValue().value).toBe(true);
    choose("event.seats");
    changeControl(screen.getByLabelText("Value"), { target: { value: "2.5" } });
    expect(ruleValue().value).toBe(2.5);
    expect(screen.getByLabelText("Value").getAttribute("step")).toBe("any");
  });

  it("emits ISO date and zoned timestamp values and edits freshness durations", () => {
    render(h(Rules));
    choose("event.expires");
    expect(screen.getByLabelText("Value")).toHaveProperty("type", "date");
    changeControl(screen.getByLabelText("Value"), { target: { value: "2026-10-04" } });
    expect(ruleValue().value).toBe("2026-10-04");
    changeControl(screen.getByLabelText("Value format"), { target: { value: "datetime-local" } });
    changeControl(screen.getByLabelText("Value"), { target: { value: "2026-10-04T12:30:15" } });
    expect(ruleValue().value).toBe(new Date("2026-10-04T12:30:15").toISOString());
    changeControl(screen.getByLabelText("Operator"), { target: { value: "within" } });
    expect(ruleValue().value).toBe("1 day");
    changeControl(screen.getByLabelText("Duration"), { target: { value: "7 days" } });
    changeControl(screen.getByLabelText("Operator"), { target: { value: "not_within" } });
    expect(ruleValue().value).toBe("7 days");
    changeControl(screen.getByLabelText("Operator"), { target: { value: "exists" } });
    expect(ruleValue()).not.toHaveProperty("value");
  });

  it("uses topic and segment names for membership IDs, without losing missing legacy IDs", () => {
    render(h(Rules));
    choose("contact.topics");
    expect([...screen.getByLabelText("Operator").parentElement!.querySelectorAll("option")].map((option) => option.value)).toEqual(["contains", "not_contains", "exists", "is_empty"]);
    changeControl(screen.getByLabelText("Value"), { target: { value: "topic_news" } });
    expect(ruleValue()).toMatchObject({ field: "contact.topics", operator: "contains", value: "topic_news" });
    fireEvent.click(screen.getByLabelText("Value"));
    expect(screen.getByRole("option", { name: "News" })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Value"), { key: "Escape" });
    choose("contact.segments");
    expect(ruleValue().value).toBe("topic_news");
    fireEvent.click(screen.getByLabelText("Value"));
    expect(screen.getByRole("option", { name: "topic_news" })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("Value"), { key: "Escape" });
    changeControl(screen.getByLabelText("Value"), { target: { value: "seg_vip" } });
    expect(ruleValue().value).toBe("seg_vip");
  });

  it("preserves manual unknown event fields and value types", () => {
    render(h(Rules, { rule: { type: "rule", field: "event.custom", operator: "eq", value: "" } }));
    changeControl(screen.getByLabelText("Type"), { target: { value: "date" } });
    changeControl(screen.getByLabelText("Field"), { target: { value: "event.nested.custom_date" } });
    expect(controlValue(screen.getByLabelText("Type"))).toBe("date");
    changeControl(screen.getByLabelText("Value"), { target: { value: "2026-10-04" } });
    expect(ruleValue().value).toBe("2026-10-04");
    changeControl(screen.getByLabelText("Type"), { target: { value: "boolean" } });
    changeControl(screen.getByLabelText("Value"), { target: { value: "false" } });
    expect(ruleValue().value).toBe(false);
  });

  it("does not mask legacy declared membership keys with set controls", () => {
    render(h(Rules, { rows: contextFields({ properties: [{ key: "topics", type: "boolean" }, { key: "segments", type: "date" }] }) }));
    choose("contact.topics");
    expect(controlValue(screen.getByLabelText("Type"))).toBe("boolean");
    expect(screen.queryByRole("option", { name: "News" })).toBeNull();
    changeControl(screen.getByLabelText("Value"), { target: { value: "false" } });
    expect(ruleValue().value).toBe(false);
    choose("contact.segments");
    expect(screen.getByLabelText("Value")).toHaveProperty("type", "date");
  });

  it("keeps nested editors typed and all new controls disabled for viewers", () => {
    render(h(Rules, { rule: { type: "and", rules: [blank, { type: "or", rules: [{ type: "rule", field: "event.paid", operator: "eq", value: true }] }] }, disabled: true }));
    expect(screen.getAllByLabelText("Choose field")).toHaveLength(2);
    for (const control of document.querySelectorAll("input, select, button")) expect(control).toHaveProperty("disabled", true);
    expect(ruleValue().rules[1].rules[0].value).toBe(true);
  });
});

describe("StepForm", () => {
  it("defaults segment membership to this person and explicitly edits another email without wire metadata", () => {
    render(h(Form, { initial: { key: "segment", type: "add_to_segment", config: { segment_id: "seg_vip" } } }));
    expect(controlValue(screen.getByLabelText("Contact"))).toBe("person");
    expect(screen.queryByLabelText("Email")).toBeNull();
    changeControl(screen.getByLabelText("Contact"), { target: { value: "other" } });
    expect(screen.getByText("Enter the email of the contact to add.")).toBeTruthy();
    expect(screen.getByTestId("graph").textContent).not.toContain("contactTarget");
    changeControl(screen.getByLabelText("Email"), { target: { value: "friend@example.com" } });
    expect(config()).toEqual({ segment_id: "seg_vip", email: "friend@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Toggle form" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle form" }));
    expect(controlValue(screen.getByLabelText("Contact"))).toBe("other");
    expect(controlValue(screen.getByLabelText("Email"))).toBe("friend@example.com");
    changeControl(screen.getByLabelText("Contact"), { target: { value: "person" } });
    expect(config()).toEqual({ segment_id: "seg_vip" });
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("does not carry another-contact mode across step selection", () => {
    const props = { path: [], index: 0, disabled: false, errors: {}, options };
    const { rerender } = render(h(StepForm, { ...props, node: { key: "override", type: "add_to_segment", config: { segment_id: "seg_vip", email: "other@example.com" } } }));
    expect(controlValue(screen.getByLabelText("Contact"))).toBe("other");
    rerender(h(StepForm, { ...props, node: { key: "person", type: "add_to_segment", config: { segment_id: "seg_vip" } } }));
    expect(controlValue(screen.getByLabelText("Contact"))).toBe("person");
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("does not transfer a removed sibling's manual type onto an inferred number", () => {
    render(h(Form, { initial: { key: "condition", type: "condition", config: { type: "and", rules: [
      { type: "rule", field: "event.custom", operator: "eq", value: "" },
      { type: "rule", field: "event.other", operator: "gt", value: 10 },
    ] } } }));
    changeControl(screen.getAllByLabelText("Type")[0]!, { target: { value: "boolean" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove rule" })[0]!);
    expect(controlValue(screen.getByLabelText("Type"))).toBe("number");
    expect(controlValue(screen.getByLabelText("Value"))).toBe("10");
    expect(config().rules[0].value).toBe(10);
  });

  it("retains manual types across form remounts, grouping and sibling removal, but never sends them", () => {
    render(h(Form, { initial: { key: "condition", type: "condition", config: { type: "rule", field: "event.custom", operator: "eq", value: "" } } }));
    changeControl(screen.getByLabelText("Type"), { target: { value: "date" } });
    changeControl(screen.getByLabelText("Value format"), { target: { value: "text" } });
    changeControl(screen.getByLabelText("Value"), { target: { value: "tomorrow" } });
    expect(screen.getAllByText(/Use an ISO date/)).toHaveLength(2); // Inline error and save-blocking step error.
    fireEvent.click(screen.getByRole("button", { name: "Toggle form" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle form" }));
    expect(controlValue(screen.getByLabelText("Type"))).toBe("date");
    expect(controlValue(screen.getByLabelText("Value"))).toBe("tomorrow");
    changeControl(screen.getByLabelText("Condition"), { target: { value: "and" } });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    changeControl(screen.getAllByLabelText("Field")[1]!, { target: { value: "event.other" } });
    changeControl(screen.getAllByLabelText("Type")[1]!, { target: { value: "boolean" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Remove rule" })[0]!);
    expect(controlValue(screen.getByLabelText("Type"))).toBe("boolean");
    expect(JSON.parse(screen.getByTestId("node").textContent!).ruleTypes).toEqual({ "0": "boolean" });
    changeControl(screen.getByLabelText("Condition"), { target: { value: "rule" } });
    expect(JSON.parse(screen.getByTestId("node").textContent!).ruleTypes).toEqual({ "": "boolean" });
    expect(config()).toEqual({ type: "rule", field: "event.other", operator: "eq", value: false });
    expect(screen.getByTestId("graph").textContent).not.toContain("ruleTypes");
  });

  it("uses the waited event definition for filters, not the triggering event", () => {
    render(h(Form, { initial: { key: "wait", type: "wait_for_event", config: { event_name: "purchase", filter_rule: { type: "rule", field: "event.total", operator: "gt", value: 10 } } } }));
    fireEvent.click(screen.getByLabelText("Choose field"));
    expect(screen.getByRole("option", { name: "total (number)" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "seats (number)" })).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Choose field"), { key: "Escape" });
    changeControl(screen.getByLabelText("Value"), { target: { value: "25" } });
    expect(config().filter_rule.value).toBe(25);
  });

  it("saves additive mappings through the same picker without rewriting literal JSON variables", () => {
    const literals = { plan: "event.plan", flag: false, nested: { total: 2 }, received_at: "literal" };
    render(h(Form, { initial: { key: "send", type: "send_email", config: { template: { id: "tpl_1", variables: literals } } } }));
    fireEvent.click(screen.getByRole("button", { name: "Add mapping" }));
    changeControl(screen.getByLabelText("Variable name"), { target: { value: "plan" } });
    changeControl(screen.getByLabelText("Choose context field"), { target: { value: "event.plan" } });
    expect(config().variable_mapping).toEqual({ plan: "event.plan" });
    expect(config().template.variables).toEqual(literals);
    expect([...screen.getByLabelText("Choose context field").parentElement!.querySelectorAll("optgroup")].map((group) => group.label)).toEqual(["Event", "Contact", "Topics", "Segments"]);
    fireEvent.click(screen.getByRole("button", { name: "Add mapping" }));
    const group = screen.getByRole("group", { name: "Variable mappings" });
    const names = within(group).getAllByLabelText("Variable name");
    changeControl(names[1]!, { target: { value: "paid" } });
    changeControl(within(group).getAllByLabelText("Context field")[1]!, { target: { value: "contact.unsubscribed" } });
    expect(config().variable_mapping).toEqual({ plan: "event.plan", paid: "contact.unsubscribed" });
    fireEvent.click(screen.getByRole("button", { name: "Remove mapping plan" }));
    expect(config().variable_mapping).toEqual({ paid: "contact.unsubscribed" });
    expect(config().template.variables).toEqual(literals);
  });

  it("preserves a legacy string template reference when adding mappings and disables viewer controls", () => {
    render(h(Form, { initial: { key: "send", type: "send_email", config: { template: "tpl_1", variable_mapping: { paid: "event.paid" } } }, disabled: true }));
    expect(config().template).toBe("tpl_1");
    for (const control of document.querySelectorAll("input, select, textarea, button")) expect(control).toHaveProperty("disabled", true);
  });
});
