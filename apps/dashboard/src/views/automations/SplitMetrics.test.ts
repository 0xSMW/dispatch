// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import type { SplitReport } from "../../types";
import { SplitMetrics } from "./SplitMetrics";

const zero = {
  runs: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, unique_opened: 0, unique_clicked: 0,
  bounced: 0, complained: 0, unsubscribed: 0,
  delivery_rate: 0, open_rate: 0, click_rate: 0, bounce_rate: 0, complaint_rate: 0, unsubscribe_rate: 0,
};
const report: SplitReport = {
  object: "automation_split_metrics", automation_id: "automation_1", step_key: "experiment",
  start_date: "2026-10-01T00:00:00Z", end_date: "2026-10-05T00:00:00Z",
  data: [
    { ...zero, key: "a", label: "Original", weight: 100, runs: 18, sent: 12, delivered: 10, unique_opened: 4, unique_clicked: 2, open_rate: 40, click_rate: 20 },
    { ...zero, key: "b", label: "Candidate", weight: 0, runs: 11 },
    { ...zero, key: "retired", label: "Retired", weight: null, runs: 9, sent: 7 },
  ],
};
afterEach(cleanup);

describe("SplitMetrics", () => {
  it("shows stored counts despite current zero weights and historical nullable weights", () => {
    render(h(SplitMetrics, { report, onWinner: vi.fn() }));
    const original = screen.getByText("Original").closest("tr")!;
    expect(within(original).getByText("18")).toBeTruthy();
    expect(within(original).getByText("12")).toBeTruthy();
    expect(within(original).getByText("40%")).toBeTruthy();
    expect(within(original).getByText("20%")).toBeTruthy();
    const candidate = screen.getByText("Candidate").closest("tr")!;
    expect(within(candidate).getAllByRole("cell")[1]!.textContent).toBe("0%");
    expect(within(candidate).getByText("11")).toBeTruthy();
    expect(within(candidate).getByRole("button", { name: "Use Candidate as winner" })).toBeTruthy();
    const historical = screen.getByText("Retired").closest("tr")!;
    expect(within(historical).getByText("—")).toBeTruthy();
    expect(within(historical).getByText("9")).toBeTruthy();
    expect(within(historical).getByText("7")).toBeTruthy();
    expect(within(historical).queryByRole("button")).toBeNull();
    expect(screen.getByText("Historical · removed path")).toBeTruthy();
    expect(screen.getByText(/end exclusive/)).toBeTruthy();
  });

  it("passes the selected stable key and protects an in-flight async callback", async () => {
    let resolve!: () => void;
    const onWinner = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    render(h(SplitMetrics, { report, onWinner }));
    fireEvent.click(screen.getByRole("button", { name: "Use Candidate as winner" }));
    expect(onWinner).toHaveBeenCalledExactlyOnceWith("b");
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", true);
      fireEvent.click(button);
    }
    expect(onWinner).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Use Original as winner" })).toHaveProperty("disabled", false));
    expect(report.data[1]!.weight).toBe(0);
    expect(report.data[1]!.runs).toBe(11);
  });

  it.each([{ disabled: true }, { busy: true }, { loading: true }])("protects winner actions with %j", (props) => {
    const onWinner = vi.fn();
    render(h(SplitMetrics, { report, onWinner, ...props }));
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveProperty("disabled", true);
      fireEvent.click(button);
    }
    expect(onWinner).not.toHaveBeenCalled();
  });

  it("presents callback rejection without mutating a report or resuming anything", async () => {
    const onWinner = vi.fn().mockRejectedValueOnce(new Error("Version edit failed; automation remains paused.")).mockResolvedValueOnce(undefined);
    render(h(SplitMetrics, { report, onWinner }));
    fireEvent.click(screen.getByRole("button", { name: "Use Original as winner" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Version edit failed; automation remains paused.");
    expect(report.data.map((row) => row.weight)).toEqual([100, 0, null]);
    fireEvent.click(screen.getByRole("button", { name: "Use Candidate as winner" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onWinner.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("shows errors and read-only retries, and blocks retries while busy", () => {
    const onRetry = vi.fn();
    const onWinner = vi.fn();
    const view = render(h(SplitMetrics, { report, error: "Metrics failed", onRetry, onWinner, disabled: true }));
    expect(screen.getByRole("alert").textContent).toContain("Metrics failed");
    expect(screen.queryByRole("button", { name: /as winner/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    view.rerender(h(SplitMetrics, { report, error: "Metrics failed", onRetry, busy: true }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders actual loading/empty states and no winner controls without a callback", () => {
    const view = render(h(SplitMetrics, { report: null, loading: true }));
    expect(screen.getByLabelText("Split comparison").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("No split results in this window.")).toBeNull();
    view.rerender(h(SplitMetrics, { report: null }));
    expect(screen.getByText("No split results in this window.")).toBeTruthy();
    view.rerender(h(SplitMetrics, { report }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Retired")).toBeTruthy();
  });
});
