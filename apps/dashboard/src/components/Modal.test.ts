// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../testing";
import { Drawer } from "./Drawer";
import { Modal } from "./Modal";
import { shortcuts } from "../lib/shortcuts";

function Page({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return h(
    "div",
    null,
    h("button", { type: "button", onClick: () => setOpen(true) }, "Open dialog"),
    h(Modal, {
        isOpen: open,
        title: "Rename",
        onClose: () => {
          onClose();
          setOpen(false);
        },
        onSubmit: () => undefined,
        submitLabel: "Save",
        children: h("input", { "aria-label": "Name" }),
      }),
  );
}

describe("dialog focus", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("keeps a closing drawer mounted until the exit finishes and closes once", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    const close = vi.fn();
    render(h(Drawer, { isOpen: true, title: "Details", onClose: close, children: h("p", null, "Content") }));
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Details" })).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(220); });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes drawers immediately when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const close = vi.fn();
    render(h(Drawer, { isOpen: true, title: "Details", onClose: close, children: h("p", null, "Content") }));
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("moves focus in, keeps Tab inside, and gives focus back on close", () => {
    const onClose = vi.fn();
    render(h(Page, { onClose }));
    const opener = screen.getByRole("button", { name: "Open dialog" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog");
    const name = screen.getByLabelText("Name");
    expect(document.activeElement).toBe(name);

    const items = [...dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled])")];
    const first = items[0]!;
    const last = items[items.length - 1]!;
    // Tab from the last control wraps to the first, and Shift+Tab from the first wraps to the last.
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("shows separate platform shortcut caps and keeps modified Enter submission", () => {
    const submit = vi.fn();
    render(h(Modal, { isOpen: true, title: "Save changes", onClose: vi.fn(), onSubmit: submit, children: h("input", { "aria-label": "Name" }) }));
    const save = screen.getByRole("button", { name: /^Save / });
    const cancel = screen.getByRole("button", { name: /^Cancel / });
    expect([...save.querySelectorAll("kbd")].map((cap) => cap.textContent)).toEqual(shortcuts.submit.keys);
    expect([...cancel.querySelectorAll("kbd")].map((cap) => cap.textContent)).toEqual(shortcuts.dismiss.keys);
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter", ctrlKey: true });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("closes only the topmost of two open dialogs on Esc", () => {
    const closeDrawer = vi.fn();
    const closeModal = vi.fn();
    render(
      h(
        "div",
        null,
        h(Drawer, { isOpen: true, title: "Run", onClose: closeDrawer, children: h("p", null, "Steps") }),
        h(Modal, { isOpen: true, title: "Confirm", onClose: closeModal, children: h("p", null, "Sure?") }),
      ),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(closeDrawer).not.toHaveBeenCalled();
  });
});
