// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { h, wrapper } from "../testing";
import { PageHeader } from "./PageHeader";

describe("PageHeader Learn chips", () => {
  afterEach(cleanup);

  it("renders accessible documentation chips below the title", () => {
    render(h(wrapper, null, h(PageHeader, {
      title: "Templates",
      description: "Reusable emails",
      learn: [{ label: "Variables", href: "https://docs.acme.test/v1/templates.md#variables" }],
    })));
    const nav = screen.getByRole("navigation", { name: "Learn more" });
    const link = within(nav).getByRole("link", { name: "Variables" });
    expect(link.getAttribute("href")).toBe("https://docs.acme.test/v1/templates.md#variables");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("heading", { name: "Templates" })).toBeTruthy();
    expect(screen.getByText("Reusable emails")).toBeTruthy();
  });

  it("does not leave an empty Learn row on pages without targets", () => {
    const { rerender } = render(h(PageHeader, { title: "Emails" }));
    expect(screen.queryByRole("navigation", { name: "Learn more" })).toBeNull();
    rerender(h(PageHeader, { title: "Emails", learn: [] }));
    expect(screen.queryByText("Learn")).toBeNull();
  });
});
