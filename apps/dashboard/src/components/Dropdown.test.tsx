// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../testing";
import { Dropdown } from "./Dropdown";
import { Modal } from "./Modal";

afterEach(cleanup);
const options = [
  h("option", { value: "a", key: "a" }, "Alpha"),
  h("option", { value: "b", key: "b", disabled: true }, "Beta"),
  h("option", { value: "c", key: "c" }, "Charlie"),
];
describe("Dropdown", () => {
  it("selects by keyboard, skips disabled choices and sends a native-compatible event", () => {
    const change = vi.fn();
    render(
      h(
        Dropdown,
        { "aria-label": "Topic", defaultValue: "a", onChange: change },
        options,
      ),
    );
    const button = screen.getByRole("combobox", { name: "Topic" });
    fireEvent.keyDown(button, { key: "ArrowDown" });
    fireEvent.keyDown(button, { key: "ArrowDown" });
    fireEvent.keyDown(button, { key: "Enter" });
    expect(change).toHaveBeenCalledOnce();
    expect(button.textContent).toBe("Charlie");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("supports typeahead and pointer selection, serializes values and resets", async () => {
    const { container } = render(
      h(
        "form",
        {},
        h(
          Dropdown,
          { name: "topic", "aria-label": "Topic", defaultValue: "a" },
          options,
        ),
      ),
    );
    const button = screen.getByRole("combobox");
    fireEvent.keyDown(button, { key: "c" });
    fireEvent.keyDown(button, { key: "Enter" });
    const form = container.querySelector("form")!;
    expect(new FormData(form).get("topic")).toBe("c");
    form.reset();
    await waitFor(() => expect(button.textContent).toBe("Alpha"));
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("option", { name: "Charlie" }));
    expect(new FormData(form).get("topic")).toBe("c");
  });
  it("closes only the dropdown on Escape inside a modal and leaves focus on its trigger", () => {
    const close = vi.fn();
    render(
      h(Modal, {
        isOpen: true,
        onClose: close,
        title: "Create",
        children: h(Dropdown, { "aria-label": "Topic" }, options),
      }),
    );
    const button = screen.getByRole("combobox");
    button.focus();
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
  it("keeps the listbox inside its dialog and caps long menus", () => {
    render(h(Modal, { isOpen: true, onClose: vi.fn(), title: "Create", children: h(Dropdown, { "aria-label": "Topic" }, options) }));
    const trigger = screen.getByRole("combobox");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ left: 100, right: 360, top: 100, bottom: 136, width: 260, height: 36, x: 100, y: 100, toJSON: () => ({}) });
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    expect(screen.getByRole("dialog").contains(listbox)).toBe(true);
    expect(listbox.style.left).toBe("100px");
    expect(listbox.style.top).toBe("142px");
    expect(listbox.style.maxHeight).toBe("280px");
  });

  it("positions relative to a translating drawer then returns to viewport coordinates", () => {
    render(h("aside", { role: "dialog", style: { transform: "translateX(0)" } }, h(Dropdown, { "aria-label": "Topic" }, options)));
    const dialog = screen.getByRole("dialog");
    const trigger = screen.getByRole("combobox");
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ left: 400, right: 900, top: 0, bottom: 768, width: 500, height: 768, x: 400, y: 0, toJSON: () => ({}) });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ left: 420, right: 680, top: 100, bottom: 136, width: 260, height: 36, x: 420, y: 100, toJSON: () => ({}) });
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox").style.left).toBe("20px");
    dialog.style.transform = "none";
    fireEvent.animationEnd(dialog);
    expect(screen.getByRole("listbox").style.left).toBe("420px");
    expect(dialog.contains(screen.getByRole("listbox"))).toBe(true);
  });

  it("allows the modal command-enter submit shortcut from the dropdown", () => {
    const submit = vi.fn();
    render(h(Modal, { isOpen: true, onClose: vi.fn(), onSubmit: submit, title: "Create", children: h(Dropdown, { "aria-label": "Topic" }, options) }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("exposes required state, focuses invalid controls and respects disabled", () => {
    const { container, rerender } = render(
      h(
        "form",
        {},
        h(
          Dropdown,
          { "aria-label": "Topic", required: true, defaultValue: "" },
          h("option", { value: "" }, "Choose"),
          ...options,
        ),
      ),
    );
    expect(container.querySelector("form")!.checkValidity()).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    rerender(h(Dropdown, { "aria-label": "Topic", disabled: true }, options));
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("closes on outside click without changing selection", () => {
    render(h(Dropdown, { "aria-label": "Topic" }, options));
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox").textContent).toBe("Alpha");
  });
});
