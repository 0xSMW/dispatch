// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, wrapper } from "../testing";
import { PageHeader } from "./PageHeader";
import { shortcuts } from "../lib/shortcuts";

describe("PageHeader Learn chips", () => {
  afterEach(cleanup);

  it("renders accessible documentation chips below the title", () => {
    render(h(wrapper, null, h(PageHeader, {
      title: "Templates",
      learn: [{ label: "Variables", href: "https://docs.acme.test/v1/templates.md#variables" }],
    })));
    const nav = screen.getByRole("navigation", { name: "Learn more" });
    const link = within(nav).getByRole("link", { name: "Variables" });
    expect(link.getAttribute("href")).toBe("https://docs.acme.test/v1/templates.md#variables");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("heading", { name: "Templates" })).toBeTruthy();
  });

  it("preserves functional scope context below the title", () => {
    render(h(PageHeader, { title: "Logs", context: h("a", { href: "/emails/em_1" }, "Email em_1") }));
    expect(screen.getByRole("link", { name: "Email em_1" }).getAttribute("href")).toBe("/emails/em_1");
  });

  it("does not leave an empty Learn row on pages without targets", () => {
    const { rerender } = render(h(PageHeader, { title: "Emails" }));
    expect(screen.queryByRole("navigation", { name: "Learn more" })).toBeNull();
    rerender(h(PageHeader, { title: "Emails", learn: [] }));
    expect(screen.queryByText("Learn")).toBeNull();
  });

  it("always shows API beside existing actions and uses the shell shortcut event", () => {
    const listener = vi.fn();
    document.addEventListener("keydown", listener);
    try {
      render(h(PageHeader, { title: "Emails", actions: h("button", null, "Send email") }));
      expect(screen.getByRole("button", { name: "Send email" })).toBeTruthy();
      const api = screen.getByRole("button", { name: "API" });
      expect(api.getAttribute("title")).toContain(shortcuts.api.keys[0]);
      fireEvent.click(api);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0]![0].key).toBe(shortcuts.api.combo);
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });

  it("does not dispatch a page shortcut while another dialog is open", () => {
    const listener = vi.fn();
    document.addEventListener("keydown", listener);
    try {
      render(h("div", null, h(PageHeader, { title: "Emails" }), h("div", { role: "dialog" }, "Existing dialog")));
      fireEvent.click(screen.getByRole("button", { name: "API" }));
      expect(listener).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });
});
