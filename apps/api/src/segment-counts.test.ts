import { describe, expect, it, vi } from "vitest";
import { SegmentCounts } from "./segment-counts.js";
import { permitted } from "./platform.js";

describe("segment detail count cache", () => {
  it("keys tenant, segment and revision, expires at thirty seconds and invalidates", async () => {
    const counts = new SegmentCounts();
    let calls = 0;
    const load = vi.fn(async () => ++calls);
    expect(await counts.get("t", "s", "v1", load, 100)).toBe(1);
    expect(await counts.get("t", "s", "v1", load, 30_099)).toBe(1);
    expect(await counts.get("t", "s", "v1", load, 30_100)).toBe(2);
    expect(await counts.get("t", "s", "v2", load, 30_101)).toBe(3);
    expect(await counts.get("other", "s", "v2", load, 30_101)).toBe(4);
    counts.invalidate("t", "s");
    expect(await counts.get("t", "s", "v2", load, 30_102)).toBe(5);
    expect(await counts.get("other", "s", "v2", load, 30_102)).toBe(4);
  });
  it("permits viewer preview only, never segment mutations", () => {
    expect(permitted(["read"], "POST", "/segments/preview")).toBe(true);
    expect(permitted(["read"], "POST", "/segments")).toBe(false);
    expect(permitted(["read"], "PATCH", "/segments/:id")).toBe(false);
    expect(permitted([], "POST", "/segments/preview")).toBe(false);
  });
});
