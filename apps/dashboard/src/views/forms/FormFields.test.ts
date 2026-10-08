// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormFields, type FormDraft, type FormFieldsProps } from "./FormFields";

function draft(): FormDraft {
  return {
    name: "Newsletter",
    topic_ids: ["news", "old-topic"],
    properties: ["first_name", "old-property"],
    double_opt_in: false,
    from_email: "news@example.com",
    allowed_origins: ["https://example.com", "https://other.example"],
    redirect_url: "",
  };
}

function props(overrides: Partial<FormFieldsProps> = {}): FormFieldsProps {
  return {
    value: draft(),
    topics: [{ value: "news", label: "News" }, { value: "tips", label: "Tips" }],
    properties: [{ value: "first_name", label: "First name" }, { value: "company", label: "Company" }],
    senders: [{ value: "news@example.com", label: "Verified newsletter sender" }],
    onChange: vi.fn(),
    ...overrides,
  };
}

describe("FormFields", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected request"); })));
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders supplied values and keeps caller defaults and unknown selections on rerender", () => {
    const input = props();
    const view = render(createElement(FormFields, input));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(input.value.name);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    for (const name of ["News", "First name", "old-topic", "old-property"]) {
      expect((screen.getByLabelText(name) as HTMLInputElement).checked).toBe(true);
    }
    expect((screen.getByLabelText("Sender").closest(".dropdown")!.querySelector("select")!).value).toBe(input.value.from_email);
    expect(Array.from(document.querySelectorAll("option")).map((option) => option.textContent)).toEqual(["Verified newsletter sender"]);
    view.rerender(createElement(FormFields, { ...input, value: { ...input.value, double_opt_in: true } }));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(input.onChange).not.toHaveBeenCalled();
  });

  it("emits complete fresh drafts for every field without mutating or sharing input arrays", () => {
    const input = props();
    const original = structuredClone(input.value);
    Object.freeze(input.value.topic_ids);
    Object.freeze(input.value.properties);
    Object.freeze(input.value.allowed_origins);
    Object.freeze(input.value);
    render(createElement(FormFields, input));
    const edits: Array<[() => void, Partial<FormDraft>]> = [
      [() => fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Updates" } }), { name: "Updates" }],
      [() => fireEvent.click(screen.getByLabelText("Tips")), { topic_ids: ["news", "old-topic", "tips"] }],
      [() => fireEvent.click(screen.getByLabelText("News")), { topic_ids: ["old-topic"] }],
      [() => fireEvent.click(screen.getByLabelText("Company")), { properties: ["first_name", "old-property", "company"] }],
      [() => fireEvent.click(screen.getByLabelText("old-property")), { properties: ["first_name"] }],
      [() => fireEvent.change(screen.getByLabelText("Sender").closest(".dropdown")!.querySelector("select")!, { target: { value: "news@example.com" } }), { from_email: "news@example.com" }],
      [() => fireEvent.click(screen.getByRole("switch")), { double_opt_in: true }],
      [() => fireEvent.change(screen.getByLabelText("Origin 1"), { target: { value: "https://new.example" } }), { allowed_origins: ["https://new.example", "https://other.example"] }],
      [() => fireEvent.click(screen.getByRole("button", { name: "Add origin" })), { allowed_origins: [...original.allowed_origins, ""] }],
      [() => fireEvent.click(screen.getByRole("button", { name: "Remove origin 1" })), { allowed_origins: ["https://other.example"] }],
      [() => fireEvent.change(screen.getByLabelText("Redirect URL"), { target: { value: "https://example.com/thanks" } }), { redirect_url: "https://example.com/thanks" }],
    ];
    for (const [edit, patch] of edits) {
      edit();
      const next = vi.mocked(input.onChange).mock.lastCall?.[0];
      expect(next).toEqual({ ...original, ...patch });
      expect(next).not.toBe(input.value);
      for (const key of ["topic_ids", "properties", "allowed_origins"] as const) {
        expect(next?.[key]).not.toBe(input.value[key]);
      }
    }
    expect(input.value).toEqual(original);
    // Parent owns updates: editing has not changed the rendered draft.
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(original.name);
  });

  it("uses only supplied sender choices plus a retained current selection, without choosing a default", () => {
    const input = props({ value: { ...draft(), from_email: "old@example.com" } });
    const view = render(createElement(FormFields, input));
    expect((screen.getByLabelText("Sender").closest(".dropdown")!.querySelector("select")!).value).toBe("old@example.com");
    expect(screen.getByText(/not in the supplied verified senders/)).toBeTruthy();
    view.rerender(createElement(FormFields, { ...input, value: { ...input.value, from_email: "" } }));
    expect((screen.getByLabelText("Sender").closest(".dropdown")!.querySelector("select")!).value).toBe("");
    expect(input.onChange).not.toHaveBeenCalled();
  });

  it("disables every editing, add and remove control and guards change callbacks", () => {
    const input = props({ disabled: true });
    const { container } = render(createElement(FormFields, input));
    for (const control of container.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, select, button")) {
      expect(control.disabled).toBe(true);
    }
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Blocked" } });
    fireEvent.change(screen.getByLabelText("Origin 1"), { target: { value: "Blocked" } });
    fireEvent.change(screen.getByLabelText("Redirect URL"), { target: { value: "https://blocked.example" } });
    fireEvent.change(screen.getByLabelText("Sender").closest(".dropdown")!.querySelector("select")!, { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Tips"));
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Add origin" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove origin 1" }));
    expect(input.onChange).not.toHaveBeenCalled();
  });

  it("shows all parent errors and empty option states without inventing resources", () => {
    const value = { ...draft(), topic_ids: [], properties: [], from_email: "", allowed_origins: [] };
    const errors = Object.fromEntries(Object.keys(value).map((key) => [key, `Error: ${key}`]));
    const input = props({ value, topics: [], properties: [], senders: [], errors });
    render(createElement(FormFields, input));
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual(
      ["name", "topic_ids", "properties", "from_email", "double_opt_in", "allowed_origins", "redirect_url"].map((key) => `Error: ${key}`),
    );
    expect(screen.getByText("No topics available.")).toBeTruthy();
    expect(screen.getByText("No properties available.")).toBeTruthy();
    expect(screen.getByText("No verified senders yet.")).toBeTruthy();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(input.onChange).not.toHaveBeenCalled();
  });
});
