// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../testing";
import { PageHeader } from "./PageHeader";
import { shortcuts } from "../lib/shortcuts";

describe("PageHeader", () => {
  afterEach(cleanup);

  it("preserves functional scope context below the title", () => {
    render(h(PageHeader, { title: "Logs", context: h("a", { href: "/emails/em_1" }, "Email em_1") }));
    expect(screen.getByRole("link", { name: "Email em_1" }).getAttribute("href")).toBe("/emails/em_1");
  });

  it("places API before the primary action and uses the shell shortcut event", () => {
    const listener = vi.fn();
    document.addEventListener("keydown", listener);
    try {
      render(h(PageHeader, { title: "Emails", actions: h("button", null, "Send email") }));
      expect(screen.getByRole("button", { name: "Send email" })).toBeTruthy();
      const api = screen.getByRole("button", { name: "API" });
      expect([...api.parentElement!.children].map((child) => child.textContent)).toEqual(["API", "Send email"]);
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
