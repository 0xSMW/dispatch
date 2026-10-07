// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../testing";
import { Checks, type CheckRow } from "./Checks";

afterEach(cleanup);

describe("Checks", () => {
  it("shows every supplied result and detail with its original severity, escaping text", () => {
    const rows: CheckRow[] = [
      { id: "content", tone: "fail", text: "Add content.", detail: "<script>alert(1)</script>" },
      { id: "link:https://acme.test", tone: "warn", text: "Link 404 not found.", detail: "https://acme.test" },
      { id: "unsubscribe", tone: "ok", text: "Includes an unsubscribe link." },
    ];
    render(h(Checks, { rows }));

    expect(screen.getByRole("heading", { name: "Checks" })).toBeTruthy();
    const list = screen.getByRole("list", { name: "Checks" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-check-id"))).toEqual(rows.map((row) => row.id));
    expect(items.map((item) => item.className)).toEqual(["fail", "warn", "ok"]);
    for (const row of rows) {
      expect(within(list).getByText(row.text)).toBeTruthy();
      if (row.detail) expect(within(list).getByText(row.detail)).toBeTruthy();
    }
    expect(list.querySelector("script")).toBeNull();
    expect(list.querySelector("a")).toBeNull();
    expect([...list.querySelectorAll("svg")].every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("keeps source identity when text, severity, and row positions change", () => {
    const { rerender } = render(h(Checks, { rows: [
      { id: "audience", tone: "ok", text: "Counting contacts…" },
      { id: "topic", tone: "warn", text: "No topic selected." },
    ] }));
    const audience = screen.getByText("Counting contacts…").closest("li");
    const topic = screen.getByText("No topic selected.").closest("li");

    rerender(h(Checks, { rows: [
      { id: "save", tone: "fail", text: "Not saved: unavailable" },
      { id: "topic", tone: "ok", text: "Topic: News." },
      { id: "audience", tone: "warn", text: "Sending to 0 contacts." },
    ] }));

    expect(screen.getByText("Sending to 0 contacts.").closest("li")).toBe(audience);
    expect(screen.getByText("Topic: News.").closest("li")).toBe(topic);
    expect(audience?.className).toBe("warn");
  });

  it("preserves existing categories, counts, and empty text in a single list", () => {
    render(h(Checks, {
      rows: [
        { id: "dmarc", group: "attention", tone: "fail", text: "DMARC missing.", detail: "No record found." },
        { id: "text", group: "great", tone: "ok", text: "Plain text included." },
        { id: "other", group: "unknown", tone: "warn", text: "An existing ungrouped warning." },
      ],
      groups: [
        { id: "attention", title: "Needs attention", tone: "fail" },
        { id: "improvements", title: "Possible improvements", tone: "warn" },
        { id: "great", title: "Doing great", tone: "ok" },
      ],
    }));

    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(screen.getByText("Needs attention").querySelector(".badge")?.className).toContain("danger");
    expect(screen.getByText("Possible improvements").querySelector(".badge")?.textContent).toBe("0");
    expect(screen.getByText("Possible improvements").querySelector(".badge")?.className).toContain("neutral");
    expect(screen.getByText("Nothing here.")).toBeTruthy();
    expect(screen.getByText("Doing great").querySelector(".badge")?.className).toContain("success");
    expect(screen.getByText("An existing ungrouped warning.")).toBeTruthy();
    expect(document.querySelectorAll("[data-check-id]")).toHaveLength(3);
  });

  it("uses the existing loading and retryable error states without claiming success", () => {
    const onRetry = vi.fn();
    const { container, rerender } = render(h(Checks, { rows: [], loading: true }));
    expect(container.querySelectorAll(".skeleton")).toHaveLength(4);
    expect(screen.queryByRole("list")).toBeNull();

    rerender(h(Checks, { rows: [], loading: true, error: "Insights unavailable.", onRetry }));
    expect(within(screen.getByRole("alert")).getByText("Insights unavailable.")).toBeTruthy();
    expect(container.querySelector(".skeleton")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(h(Checks, { rows: [] }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(screen.getByRole("list", { name: "Checks" })).queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByText(/pass|success|fine/i)).toBeNull();
  });
});
