import { changeControl, controlValue } from "../../testingControls";
// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { ReentryContext, TriggerForm, type Reentry } from "./Trigger";
import { triggerChoices, type TriggerConfig } from "./graph";
import type { StepOptions } from "./Steps";

const options: StepOptions = {
  templates: [], events: ["signup"], topics: [{ value: "topic_1", label: "News" }], segments: [{ value: "seg_1", label: "Trials" }],
  contactProperties: [
    { object: "contact_property", id: "p1", key: "plan", type: "string", fallback_value: null, created_at: "", updated_at: "" },
    { object: "contact_property", id: "p2", key: "seats", type: "number", fallback_value: null, created_at: "", updated_at: "" },
    { object: "contact_property", id: "p3", key: "renewed", type: "date", fallback_value: null, created_at: "", updated_at: "" },
    { object: "contact_property", id: "p4", key: "activated", type: "boolean", fallback_value: null, created_at: "", updated_at: "" },
  ],
};

function Harness({ initial = { type: "event", event_name: "signup" } as TriggerConfig, disabled = false }: { initial?: TriggerConfig; disabled?: boolean }) {
  const [config, setConfig] = useState(initial);
  const [reentry, setReentry] = useState<Reentry>("once");
  return h(ReentryContext.Provider, { value: { value: reentry, onChange: setReentry } },
    h("div", null, h(TriggerForm, { config, onChange: setConfig, options, disabled }),
      h("output", { "data-testid": "config" }, JSON.stringify(config)), h("output", { "data-testid": "reentry" }, reentry)));
}
const stored = () => JSON.parse(screen.getByTestId("config").textContent!);
const change = (label: string, value: string) => changeControl(screen.getByLabelText(label), { target: { value } });

afterEach(cleanup);

describe("TriggerForm", () => {
  it("edits re-entry separately from the trigger configuration and keeps the choice on trigger changes", () => {
    render(h(Harness));
    const selector = screen.getByLabelText<HTMLSelectElement>("Run for each contact");
    expect([...selector.parentElement!.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Once", "Every time"]);
    expect(controlValue(selector)).toBe("once");
    change("Run for each contact", "every_time");
    expect(screen.getByTestId("reentry").textContent).toBe("every_time");
    expect(stored()).toEqual({ type: "event", event_name: "signup" });
    change("Trigger", "contact_created");
    expect(controlValue(selector)).toBe("every_time");
    expect(stored()).toEqual({ type: "contact_created" });
  });

  it("offers all five shared choices and removes fields from the previous trigger kind", () => {
    render(h(Harness));
    expect([...screen.getByLabelText("Trigger").parentElement!.querySelectorAll("option")].map((option) => option.textContent)).toEqual(triggerChoices.map((choice) => choice.label));
    expect(controlValue(screen.getByLabelText("Event"))).toBe("signup");
    change("Trigger", "contact_created");
    expect(screen.queryByLabelText("Event")).toBeNull();
    expect(stored()).toEqual({ type: "contact_created" });
    change("Trigger", "topic_subscribed");
    change("Topic", "topic_1");
    expect(stored()).toEqual({ type: "topic_subscribed", topic_id: "topic_1" });
    change("Trigger", "segment_added");
    change("Segment", "seg_1");
    expect(stored()).toEqual({ type: "segment_added", segment_id: "seg_1" });
    change("Trigger", "contact_updated");
    expect(stored()).toEqual({ type: "contact_updated" });
  });

  it("uses built-ins and properties with typed optional bounds, including empty strings, zero, false and null", () => {
    render(h(Harness, { initial: { type: "contact_updated" } }));
    fireEvent.click(screen.getByRole("combobox", { name: "Contact field" }));
    for (const name of ["email (string)", "first_name (string)", "last_name (string)", "created_at (date)", "unsubscribed (boolean)", "plan (string)", "seats (number)", "activated (boolean)", "renewed (date)"]) {
      expect(screen.getByRole("option", { name })).toBeTruthy();
    }
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Contact field" }), { key: "Escape" });
    change("Contact field", "plan");
    change("From match", "value");
    change("From", "free");
    change("To match", "value");
    change("To", "pro");
    expect(stored()).toEqual({ type: "contact_updated", field: "plan", from: "free", to: "pro" });
    change("To", "");
    expect(stored().to).toBe("");
    change("To match", "");
    expect(stored()).not.toHaveProperty("to");
    change("Contact field", "seats");
    expect(stored()).toEqual({ type: "contact_updated", field: "seats" });
    change("From match", "value");
    expect(stored().from).toBe(0);
    change("To match", "value");
    change("To", "25");
    expect(stored().to).toBe(25);
    change("Contact field", "unsubscribed");
    change("From match", "value");
    change("To match", "value");
    change("To", "true");
    expect(stored()).toEqual({ type: "contact_updated", field: "unsubscribed", from: false, to: true });
    change("From match", "empty");
    expect(stored().from).toBeNull();
    change("Contact field", "");
    expect(stored()).toEqual({ type: "contact_updated" });
  });

  it("uses typed date bounds without putting the contact prefix on wire fields", () => {
    render(h(Harness, { initial: { type: "contact_updated", field: "renewed" } }));
    change("To match", "value");
    change("To", "2026-10-03");
    expect(stored()).toEqual({ type: "contact_updated", field: "renewed", to: "2026-10-03" });
    change("To format", "text");
    change("To", "2026-10-03T12:00:00Z");
    expect(stored().to).toBe("2026-10-03T12:00:00Z");
  });

  it.each([
    { type: "topic_subscribed", topic_id: "gone" },
    { type: "segment_added", segment_id: "gone" },
  ] as TriggerConfig[])("warns about a deleted $type resource without silently replacing it", (config) => {
    const change = vi.fn();
    render(h(TriggerForm, { config, onChange: change, options }));
    expect(screen.getByRole("status").textContent).toMatch(/was deleted/);
    fireEvent.click(screen.getByRole("combobox", { name: config.type === "topic_subscribed" ? "Topic" : "Segment" }));
    expect(screen.getByRole("option", { name: "Deleted: gone" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox", { name: config.type === "topic_subscribed" ? "Topic" : "Segment" }), { key: "Escape" });
    expect(change).not.toHaveBeenCalled();
  });

  it("does not report deletion while a resource source is loading or failed", () => {
    const view = render(h(TriggerForm, { config: { type: "topic_subscribed", topic_id: "gone" }, onChange: vi.fn(), options: { ...options, topics: [], topicsReady: false } }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(controlValue(screen.getByLabelText("Topic"))).toBe("gone");
    view.rerender(h(TriggerForm, { config: { type: "topic_subscribed", topic_id: "gone" }, onChange: vi.fn(), options: { ...options, topics: [], topicsReady: false, topicsError: "Unavailable" } }));
    expect(screen.getByRole("alert").textContent).toMatch(/Unavailable/);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps every trigger and bound control disabled for a viewer", () => {
    render(h(Harness, { initial: { type: "contact_updated", field: "renewed", from: null, to: "2026-10-03" }, disabled: true }));
    for (const control of screen.getAllByRole("combobox")) expect(control).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("To")).toHaveProperty("disabled", true);
  });
});
