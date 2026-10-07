// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn } from "../../testing";
import { everyDay, percent, RunMetrics, runSeries } from "./RunMetrics";

const zero = { running: 0, completed: 0, failed: 0, cancelled: 0 };

describe("RunMetrics helpers", () => {
  it("formats shares with up to one decimal", () => {
    expect(percent(1, 8)).toBe("12.5%");
    expect(percent(2, 3)).toBe("66.7%");
    expect(percent(0, 0)).toBe("0%");
  });

  it("fills quiet days with zeros between the first and last day", () => {
    const days = everyDay([
      { date: "2026-09-01", ...zero, completed: 2 },
      { date: "2026-09-03", ...zero, failed: 1 },
    ]);
    expect(days.map((item) => item.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(days[1]).toEqual({ date: "2026-09-02", ...zero });
    expect(everyDay([])).toEqual([]);
  });

  it("stretches to the range bounds", () => {
    const start = new Date(2026, 8, 1).toISOString();
    const end = new Date(2026, 8, 4, 23, 59).toISOString();
    expect(everyDay([{ date: "2026-09-02", ...zero }], { start, end }).map((item) => item.date)).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
  });

  it("stacks completed, failed, running, then cancelled", () => {
    const series = runSeries([{ date: "2026-09-01", running: 1, completed: 2, failed: 3, cancelled: 4 }]);
    expect(series.map((item) => [item.name, item.tone, item.points[0]!.y])).toEqual([
      ["Completed", "success", 2],
      ["Failed", "danger", 3],
      ["Running", "info", 1],
      ["Cancelled", "neutral", 4],
    ]);
  });
});

describe("RunMetrics goal card", () => {
  beforeEach(() => signIn());
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
  it("shares the automation range and can narrow goals to an attributed email step", async () => {
    const fetch = mockFetch((raw) => {
      const path = new URL(raw).pathname;
      if (path === "/goals") return { body: { object: "list", has_more: false, data: [{ id: "goal_1", name: "Paid", target: { event: "paid" }, window_days: 30 }] } };
      if (path === "/goals/goal_1/metrics") return { body: { contacts_reached: 8, converted: 1, rate: 0.125, data: [], history: { available_from: null, limitation: "Recorded changes only." } } };
      return { body: { total: 0, totals: zero, data: [] } };
    });
    const emails = {
      data: { data: [{ automation_id: "automation_1", automation_step: "welcome", sent: 2, delivered: 2, opened: 0, clicked: 0, open_rate: 0, click_rate: 0, bounce_rate: 0, unsubscribed: 0 }] },
      loading: false, error: null, reload: async () => {}, setData: () => {},
    };
    render(h(MemoryRouter, { initialEntries: ["/automations/automation_1?range=custom&start=2026-09-01&end=2026-09-03"] },
      h(SessionProvider, null, h(RunMetrics, { automationId: "automation_1", emails }))));
    await screen.findByText("12.5%");
    const goalCalls = () => fetch.mock.calls.map(([raw]) => new URL(String(raw))).filter((url) => url.pathname === "/goals/goal_1/metrics");
    const runQuery = new URL(String(fetch.mock.calls.find(([raw]) => new URL(String(raw)).pathname.endsWith("/runs/metrics"))![0])).searchParams;
    expect(goalCalls()[0]!.searchParams.get("start_date")).toBe(runQuery.get("start_date"));
    expect(goalCalls()[0]!.searchParams.get("end_date")).toBe(runQuery.get("end_date"));
    expect(goalCalls()[0]!.searchParams.get("step_key")).toBeNull();
    fireEvent.change(screen.getByLabelText("Goal email step"), { target: { value: "welcome" } });
    await waitFor(() => expect(goalCalls().at(-1)!.searchParams.get("step_key")).toBe("welcome"));
    expect(goalCalls().at(-1)!.searchParams.get("automation_id")).toBe("automation_1");
    expect(goalCalls().at(-1)!.searchParams.get("broadcast_id")).toBeNull();
    expect(screen.getByLabelText("Runs by status")).toBeTruthy();
  });
});
