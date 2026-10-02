import { describe, expect, it } from "vitest";
import { parseExact, parseWhen, usable, whenHint } from "./when";

describe("schedule times", () => {
  const now = new Date(2026, 9, 1, 12, 0, 0);

  it("reads typed dates in the browser's zone, and a bare date as local midnight", () => {
    expect(parseExact("2026-10-05 09:00", now.getTime())?.date).toEqual(new Date(2026, 9, 5, 9, 0));
    expect(parseExact("2026-10-05", now.getTime())?.date).toEqual(new Date(2026, 9, 5, 0, 0));
    expect(parseExact("2026-10-05T09:00:00Z", now.getTime())).toEqual({ date: new Date("2026-10-05T09:00:00Z"), past: false, far: false });
    expect(parseExact("2026-09-05T09:00:00Z", now.getTime())?.past).toBe(true);
    expect(parseExact("2027-01-05T09:00:00Z", now.getTime())?.far).toBe(true);
    // Not a date. `new Date("5")` would have read this as a day in 2001.
    expect(parseExact("5", now.getTime())).toBeNull();
    expect(parseExact("tomorrow at 9am", now.getTime())).toBeNull();
  });

  it("reads phrases in the browser's zone with the parser the API uses", async () => {
    expect((await parseWhen("tomorrow at 9am", now))?.date).toEqual(new Date(2026, 9, 2, 9, 0));
    expect((await parseWhen("in 1 hour", now))?.date).toEqual(new Date(2026, 9, 1, 13, 0));
    expect(await parseWhen("soonish maybe", now)).toBeNull();
    expect(await parseWhen("  ", now)).toBeNull();
  });

  it("says what it resolved, and blocks a time that cannot be used", async () => {
    const when = await parseWhen("in 1 hour");
    expect(usable({ when, pending: false })).toBe(true);
    expect(whenHint("in 1 hour", { when, pending: false })).toMatch(/^Sends .+ \(.+\)\.$/);
    expect(whenHint("x", { when: null, pending: true })).toBe("Reading the time…");
    expect(whenHint("x", { when: null, pending: false })).toContain("Could not read that as a time");
    const past = await parseWhen("2020-01-01 09:00");
    expect(usable({ when: past, pending: false })).toBe(false);
    expect(whenHint("2020-01-01 09:00", { when: past, pending: false })).toBe("That time has passed.");
    expect(usable({ when: null, pending: false })).toBe(false);
  });
});
