// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../shell/session";
import { h, signIn } from "../testing";
import { useBulkKeys } from "./useBulkKeys";
import { typing } from "./useHotkey";
import { useSelection } from "./useSelection";

function input(type: string) {
  const element = document.createElement("input");
  element.type = type;
  return element;
}

describe("typing", () => {
  it("counts text entry, and not checkboxes, radios, or buttons", () => {
    for (const type of ["text", "email", "search", "number", "password", "url"]) expect(typing(input(type)), type).toBe(true);
    for (const type of ["checkbox", "radio", "button", "submit", "range", "file", "color"]) expect(typing(input(type)), type).toBe(false);
    expect(typing(document.createElement("textarea"))).toBe(true);
    expect(typing(document.createElement("select"))).toBe(true);
    expect(typing(document.createElement("div"))).toBe(false);
    expect(typing(null)).toBe(false);
  });
});

function List({ onDelete }: { onDelete: () => void }) {
  const selection = useSelection(["a", "b"]);
  useBulkKeys(selection, 2, onDelete);
  return h(
    "div",
    null,
    h("input", { type: "checkbox", "aria-label": "Row a", checked: selection.has("a"), onChange: () => selection.toggle("a") }),
    h("input", { type: "text", "aria-label": "Search" }),
    h("output", null, selection.ids.join(",")),
  );
}

// The keys are for users who can change things, so each list renders inside a signed-in session.
function signedIn(onDelete: () => void, permissions = ["full"]) {
  signIn("sess_test", permissions);
  return render(h(SessionProvider, null, h(List, { onDelete })));
}

describe("useBulkKeys", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it("deletes and selects all right after a checkbox is clicked, which leaves focus on it", () => {
    const onDelete = vi.fn();
    signedIn(onDelete);
    const box = screen.getByLabelText("Row a");
    box.focus();
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(onDelete).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: "a", metaKey: true, ctrlKey: true });
    expect(screen.getByRole("status").textContent).toBe("a,b");
  });

  it("stands aside while the user types in a text field", () => {
    const onDelete = vi.fn();
    signedIn(onDelete);
    fireEvent.click(screen.getByLabelText("Row a"));
    const search = screen.getByLabelText("Search");
    search.focus();
    fireEvent.keyDown(search, { key: "Backspace" });
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "a", metaKey: true, ctrlKey: true });
    expect(screen.getByRole("status").textContent).toBe("a");
  });

  it("does nothing for a viewer", () => {
    const onDelete = vi.fn();
    signedIn(onDelete, ["read"]);
    const box = screen.getByLabelText("Row a");
    box.focus();
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(onDelete).not.toHaveBeenCalled();
  });
});
