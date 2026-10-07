// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, mockFetch, signIn, wrapper } from "../../testing";
import { conversionRate, GoalConversions, goalMetricsPath, goalScopeIssue } from "./GoalConversions";

const start = "2026-09-01T00:00:00.000Z";
const end = "2026-10-01T00:00:00.000Z";
const goal = { id: "goal_1", name: "Paid", target: { event: "paid" }, window_days: 30 };
const report = { contacts_reached: 8, converted: 1, rate: 0.125, data: [{ date: "2026-09-01", contacts_reached: 8, converted: 1, rate: 0.125 }], history: { available_from: null, limitation: "Earlier unrecorded transitions cannot be inferred." } };

describe("Goal metric requests", () => {
  it("uses exclusive scopes, automation-only steps, and ISO bounds", () => {
    const query = new URL(goalMetricsPath("goal_1", { automationId: "automation_1", stepKey: "welcome", start, end })!, "http://test").searchParams;
    expect(Object.fromEntries(query)).toEqual({ automation_id: "automation_1", step_key: "welcome", start_date: start, end_date: end });
    expect(goalMetricsPath("goal_1", { broadcastId: "broadcast_1" })).toBe("/goals/goal_1/metrics?broadcast_id=broadcast_1");
    expect(goalMetricsPath("goal_1")).toBe("/goals/goal_1/metrics");
    expect(goalMetricsPath("goal_1", { automationId: "a", broadcastId: "b" })).toBeNull();
    expect(goalMetricsPath("goal_1", { broadcastId: "b", stepKey: "welcome" })).toBeNull();
    expect(goalScopeIssue({ start: "2026-01-01" })).toMatch(/ISO/);
    expect(goalScopeIssue({ start: end, end: start })).toMatch(/precede/);
    expect(goalScopeIssue({ start, end: start })).toMatch(/precede/);
  });
  it("converts fractional rates to displayed percentages", () => {
    expect(conversionRate(0.125)).toBe("12.5%");
    expect(conversionRate(0)).toBe("0%");
    expect(conversionRate(1)).toBe("100%");
  });
});

describe("GoalConversions", () => {
  beforeEach(() => signIn());
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

  it("reads every goal page, changes the picker, and displays cohorts and history limitations", async () => {
    const fetch = mockFetch((raw) => {
      const url = new URL(raw);
      if (url.pathname === "/goals") return { body: { object: "list", has_more: !url.searchParams.has("after"), data: [url.searchParams.has("after") ? { ...goal, id: "goal_2", name: "Trial" } : goal] } };
      return { body: report };
    });
    render(h(GoalConversions, { automationId: "automation_1", stepKey: "welcome", start, end }), { wrapper });
    await screen.findAllByText("12.5%");
    expect(screen.getByText("First-send day (UTC)")).toBeTruthy();
    expect(screen.getByText("Earlier unrecorded transitions cannot be inferred.")).toBeTruthy();
    expect(screen.getByText(/No recorded contact history yet/)).toBeTruthy();
    expect(screen.getByText(/even after the range ends/)).toBeTruthy();
    expect(fetch.mock.calls.some(([raw]) => new URL(String(raw)).searchParams.get("after") === "goal_1")).toBe(true);
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "goal_2" } });
    await waitFor(() => expect(fetch.mock.calls.some(([raw]) => new URL(String(raw)).pathname === "/goals/goal_2/metrics")).toBe(true));
    const query = new URL(String(fetch.mock.calls.at(-1)![0])).searchParams;
    expect(query.get("automation_id")).toBe("automation_1");
    expect(query.get("broadcast_id")).toBeNull();
    expect(query.get("step_key")).toBe("welcome");
    expect(query.get("start_date")).toBe(start);
    expect(query.get("end_date")).toBe(end);
  });

  it("rejects invalid scopes without requesting metrics", async () => {
    const fetch = mockFetch(() => ({ body: { object: "list", has_more: false, data: [goal] } }));
    render(h(GoalConversions, { automationId: "a", broadcastId: "b" }), { wrapper });
    await screen.findByText(/not both/);
    expect(fetch.mock.calls.every(([raw]) => new URL(String(raw)).pathname === "/goals")).toBe(true);
  });

  it("retries metric failures and handles empty cohorts", async () => {
    let failed = true;
    mockFetch((raw) => {
      if (new URL(raw).pathname === "/goals") return { body: { object: "list", data: [goal], has_more: false } };
      if (failed) return { status: 500, body: { message: "Metrics unavailable" } };
      return { body: { ...report, contacts_reached: 0, converted: 0, rate: 0, data: [] } };
    });
    render(h(GoalConversions), { wrapper });
    await screen.findByText("Metrics unavailable");
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No eligible contacts reached in this cohort range.");
    expect(screen.getByText("0%")).toBeTruthy();
  });
});
