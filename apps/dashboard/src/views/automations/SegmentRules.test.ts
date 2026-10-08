import { changeControl, controlValue } from "../../testingControls";
// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RuleEditor } from "./Steps";
import type { Rule } from "./graph";

afterEach(cleanup);
it("keeps boolean facts and replaces exclusive resource scopes in the shared editor", () => {
  const changed = vi.fn();
  function Editor() {
    const [rule, setRule] = useState<Rule>({ type: "rule", field: "email.opened", operator: "eq", value: true });
    return createElement(RuleEditor, {
      rule, context: "segment",
      engagementScopes: { automations: [{ value: "a", label: "Automation A" }], broadcasts: [{ value: "b", label: "Broadcast B" }] },
      onChange: (next) => { setRule(next); changed(next); },
    });
  }
  render(createElement(Editor));
  expect(screen.queryByPlaceholderText("event.plan")).toBeNull();
  changeControl(screen.getByLabelText("Email scope"), { target: { value: "automation" } });
  changeControl(screen.getByLabelText("Automation"), { target: { value: "a" } });
  expect(changed.mock.calls.at(-1)![0]).toMatchObject({ value: true, scope: { automation_id: "a" } });
  changeControl(screen.getByLabelText("Email scope"), { target: { value: "broadcast" } });
  changeControl(screen.getByLabelText("Broadcast"), { target: { value: "b" } });
  expect(changed.mock.calls.at(-1)![0].scope).toEqual({ broadcast_id: "b" });
  changeControl(screen.getByLabelText("Email scope"), { target: { value: "any" } });
  expect(changed.mock.calls.at(-1)![0]).not.toHaveProperty("scope");
});

it("preserves unknown event controls and exposes unsupported automation engagement", () => {
  const onChange = vi.fn();
  const editor = render(createElement(RuleEditor, {
    rule: { type: "rule", field: "event.custom", operator: "eq", value: "pro" }, onChange,
  }));
  expect(controlValue(screen.getByPlaceholderText("event.plan"))).toBe("event.custom");
  editor.rerender(createElement(RuleEditor, {
    rule: { type: "rule", field: "email.clicked", operator: "eq", value: false }, onChange, disabled: true,
  }));
  expect(screen.getByRole("alert").textContent).toContain("not supported in automation");
  expect(onChange).not.toHaveBeenCalled();
});
