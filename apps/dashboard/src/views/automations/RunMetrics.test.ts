import { describe, expect, it } from "vitest";
import { everyDay, percent, runSeries } from "./RunMetrics";

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
