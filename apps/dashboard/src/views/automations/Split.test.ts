// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import type { SplitVariant } from "../../types";
import { Split } from "./Split";

const initial: SplitVariant[] = [
  { key: "original", label: "Original", weight: 50 },
  { key: "candidate", label: "Candidate", weight: 50 },
];
function Harness() {
  const [variants, setVariants] = useState(initial);
  return h("div", null, h(Split, { variants, onChange: setVariants }),
    h("output", { "data-testid": "variants" }, JSON.stringify(variants)));
}
const stored = (): SplitVariant[] => JSON.parse(screen.getByTestId("variants").textContent!);
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
afterEach(cleanup);

describe("Split", () => {
  it("edits labels and weights without changing stable keys, and allows zero", () => {
    render(h(Harness));
    change("Variant 1 label", "Winner");
    change("Variant 1 weight (%)", "100");
    expect(screen.getByText("Variant weights must total 100%.")).toBeTruthy();
    change("Variant 2 weight (%)", "0");
    expect(stored()).toEqual([
      { key: "original", label: "Winner", weight: 100 },
      { key: "candidate", label: "Candidate", weight: 0 },
    ]);
    expect(screen.getByText("Total weight: 100%").getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Path: candidate")).toBeTruthy();
  });

  it("enforces 2–4 controls, adds zero-weight paths and never recycles removed keys", () => {
    render(h(Harness));
    expect(screen.getByRole("button", { name: "Remove variant 1" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    const added = stored()[2]!;
    expect(added.weight).toBe(0);
    expect(new Set(stored().map((row) => row.key)).size).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "Remove variant 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    expect(stored()[2]!.key).not.toBe(added.key);
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    expect(stored()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Add variant" })).toHaveProperty("disabled", true);
  });

  it.each([-1, 101, 12.5])("shows feedback for invalid weight %s without rewriting keys", (weight) => {
    render(h(Harness));
    change("Variant 1 weight (%)", String(weight));
    expect(screen.getByText("Use a whole percentage from 0 to 100.")).toBeTruthy();
    expect(screen.getByLabelText("Variant 1 weight (%)").getAttribute("aria-invalid")).toBe("true");
    expect(stored()[0]!.key).toBe("original");
  });

  it("shows required labels, invalid and duplicate keys, counts and supplied field errors", () => {
    const onChange = vi.fn();
    const view = render(h(Split, { variants: [{ key: "bad key", label: "", weight: 100 }], onChange }));
    expect(screen.getByText("Use 2–4 variants.")).toBeTruthy();
    expect(screen.getByText("Use a label of 1–120 characters.")).toBeTruthy();
    expect(screen.getByText("Use a valid variant key.")).toBeTruthy();
    view.rerender(h(Split, {
      variants: [{ key: "same", label: "Same", weight: 50 }, { key: "same", label: " Same ", weight: 50 }],
      onChange, issues: { "variants.0.weight": "Server rejected this weight.", variants: "Reconnect every path." },
    }));
    expect(screen.getAllByText("Variant keys must be unique.")).toHaveLength(2);
    expect(screen.queryByText("Variant labels must be unique.")).toBeNull();
    expect(screen.getByText("Server rejected this weight.")).toBeTruthy();
    expect(screen.getByText("Reconnect every path.")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("protects all edits and structural controls when disabled (viewer or busy)", () => {
    const onChange = vi.fn();
    render(h(Split, { variants: [...initial, { key: "third", label: "Third", weight: 0 }], onChange, disabled: true }));
    for (const input of [...screen.getAllByRole("textbox"), ...screen.getAllByRole("spinbutton")]) {
      expect(input).toHaveProperty("disabled", true);
    }
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", true);
      fireEvent.click(button);
    }
    // Synthetic change events must not bypass the prop guard either.
    change("Variant 1 label", "Changed");
    change("Variant 1 weight (%)", "100");
    expect(onChange).not.toHaveBeenCalled();
  });
});
