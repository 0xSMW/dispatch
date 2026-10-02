// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../testing";
import { Drawer } from "./Drawer";
import { Modal } from "./Modal";

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
  afterEach(cleanup);

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
