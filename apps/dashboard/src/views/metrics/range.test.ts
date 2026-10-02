import { describe, expect, it } from "vitest";
import { bucketLabel, buckets, windowFor } from "./range";

const now = new Date(2026, 9, 1, 15, 30);

describe("windowFor", () => {
  it("defaults to 7 days from local midnight, daily", () => {
    const span = windowFor({}, now);
    expect(span.start).toEqual(new Date(2026, 8, 25));
    expect(span.end).toEqual(now);
    expect(span.granularity).toBe("daily");
    expect(span.error).toBeNull();
  });

  it("makes 1D the last 24 hours, hourly, and honours a chosen grouping", () => {
    expect(windowFor({ range: "1d" }, now)).toMatchObject({ start: new Date(2026, 8, 30, 15, 30), granularity: "hourly" });
    expect(windowFor({ range: "30d", granularity: "weekly" }, now)).toMatchObject({ start: new Date(2026, 8, 2), granularity: "weekly" });
  });

  it("covers whole custom days and refuses more than 30", () => {
    expect(windowFor({ range: "custom", start: "2026-09-01", end: "2026-09-10" }, now)).toMatchObject({
      start: new Date(2026, 8, 1),
      end: new Date(2026, 8, 11),
      error: null,
    });
    expect(windowFor({ range: "custom", start: "2026-08-01", end: "2026-09-10" }, now).error).toBe("Pick 30 days or fewer.");
    expect(windowFor({ range: "custom", start: "2026-09-10", end: "2026-09-01" }, now).error).toMatch(/before the start/);
    expect(windowFor({ range: "custom" }, now).error).toMatch(/Pick a start/);
  });
});

describe("buckets", () => {
  it("lists every period in the API's format so gaps chart as zero", () => {
    expect(buckets(new Date(2026, 8, 29), now, "daily")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(buckets(new Date(2026, 9, 1, 13, 10), now, "hourly")).toEqual(["2026-10-01T13:00:00", "2026-10-01T14:00:00", "2026-10-01T15:00:00"]);
    // 2026-09-30 is a Wednesday; weeks start on Monday like Postgres.
    expect(buckets(new Date(2026, 8, 30), now, "weekly")).toEqual(["2026-09-28"]);
    expect(buckets(new Date(2026, 7, 20), now, "monthly")).toEqual(["2026-08", "2026-09", "2026-10"]);
  });

  it("labels buckets for the axis", () => {
    expect(bucketLabel("2026-10-01", "daily")).toBe("Oct 1");
    expect(bucketLabel("2026-10-01T14:00:00", "hourly")).toBe("Oct 1, 14:00");
    expect(bucketLabel("2026-10", "monthly")).toBe("Oct 2026");
  });
});
