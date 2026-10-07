// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmCard, type ConfirmCardProps } from "./Confirm";

const brand = { product_name: "<Acme>", logo_url: null, color: "#ff0055", text_color: "#ffffff" };
const formName = "<script>alert('newsletter')</script>";

describe("ConfirmCard", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected request"); })));
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders escaped names and shared brand styles without callbacks on mount or updates", () => {
    const onConfirm = vi.fn();
    const nextCallback = vi.fn();
    const { container, rerender } = render(createElement(ConfirmCard, { brand, formName, onConfirm }));
    expect(screen.getByRole("heading", { name: formName }).tagName).toBe("H1");
    expect(screen.getByText("<Acme>")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("form")?.style.getPropertyValue("--brand")).toBe("#ff0055");
    expect(container.querySelector("form")?.style.getPropertyValue("--brand-text")).toBe("#ffffff");
    rerender(createElement(ConfirmCard, { brand, formName: "Updated", onConfirm: nextCallback, error: "Try again" }));
    expect(screen.getByRole("alert").textContent).toBe("Try again");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(nextCallback).not.toHaveBeenCalled();
  });

  it("invokes exactly once for deliberate button activation and prevents submission navigation", () => {
    const onConfirm = vi.fn();
    const { container } = render(createElement(ConfirmCard, { brand, formName, onConfirm }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const event = new Event("submit", { bubbles: true, cancelable: true });
    container.querySelector("form")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it.each(["busy", "preview", "done", "missing callback"] as const)(
    "cannot act when %s, even through direct form submission",
    (state) => {
      const onConfirm = vi.fn();
      const props: ConfirmCardProps = { brand, formName, onConfirm };
      if (state === "missing callback") delete props.onConfirm;
      else props[state] = true;
      const { container } = render(createElement(ConfirmCard, props));
      const button = screen.queryByRole("button", { name: "Confirm" }) as HTMLButtonElement | null;
      if (button) {
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
      }
      const event = new Event("submit", { bubbles: true, cancelable: true });
      container.querySelector("form")!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );

  it("shows accessible busy, error, preview heading and thank-you states using the existing logo convention", () => {
    const input = { brand: { ...brand, logo_url: "https://example.com/logo.png" }, formName, onConfirm: vi.fn() };
    const { rerender } = render(createElement(ConfirmCard, { ...input, busy: true, error: "Please retry" }));
    const logo = screen.getByRole("img", { name: "<Acme>" });
    expect(logo.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByRole("status").textContent).toBe("Confirming…");
    expect(screen.getByRole("alert").textContent).toBe("Please retry");
    rerender(createElement(ConfirmCard, { ...input, preview: true }));
    expect(screen.getByRole("heading").tagName).toBe("H2");
    rerender(createElement(ConfirmCard, { ...input, done: true }));
    expect(screen.getByRole("status").textContent).toBe("Thank you! Your subscription is confirmed.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(input.onConfirm).not.toHaveBeenCalled();
  });
});
