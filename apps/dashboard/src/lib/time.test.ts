import { describe, expect, it } from "vitest";
import { absoluteTime, isoTime, relativeTime } from "./time";

const now = new Date("2026-10-01T12:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

describe("relativeTime", () => {
  it("formats the past compactly", () => {
    expect(relativeTime(ago(10), now)).toBe("just now");
    expect(relativeTime(ago(50), now)).toBe("1m ago");
    expect(relativeTime(ago(5 * 60), now)).toBe("5m ago");
    expect(relativeTime(ago(3 * 3600), now)).toBe("3h ago");
    expect(relativeTime(ago(5 * 86400), now)).toBe("5d ago");
    expect(relativeTime(ago(65 * 86400), now)).toBe("2mo ago");
    expect(relativeTime(ago(800 * 86400), now)).toBe("2y ago");
  });

  it("formats the future", () => {
    expect(relativeTime(new Date(now.getTime() + 2 * 3600 * 1000), now)).toBe("in 2h");
  });

  it("accepts ISO strings and passes bad input through", () => {
    expect(relativeTime("2026-10-01T11:00:00Z", now)).toBe("1h ago");
    expect(relativeTime("not a date", now)).toBe("not a date");
    expect(relativeTime(null, now)).toBe("—");
  });
});

describe("absoluteTime and isoTime", () => {
  it("returns a readable timestamp and an ISO string", () => {
    expect(absoluteTime("2026-10-01T12:00:00Z")).toContain("2026");
    expect(absoluteTime(undefined)).toBe("—");
    expect(isoTime("2026-10-01T12:00:00Z")).toBe("2026-10-01T12:00:00.000Z");
    expect(isoTime("nope")).toBeUndefined();
  });
});
