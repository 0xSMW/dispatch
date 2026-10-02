import { describe, expect, it } from "vitest";
import { ApiError } from "@dispatchmail/core";
import { scheduleAt, withSchedule } from "./schedule.js";

describe("scheduleAt", () => {
  it("parses an ISO timestamp and a phrase inside 30 days", () => {
    const iso = "2026-10-02T00:00:00.000Z";
    expect(scheduleAt(iso)?.toISOString()).toBe(iso);
    const soon = scheduleAt("in 1 hour");
    expect(soon).toBeInstanceOf(Date);
    const delta = (soon?.getTime() ?? 0) - Date.now();
    expect(delta).toBeGreaterThan(50 * 60 * 1000);
    expect(delta).toBeLessThan(70 * 60 * 1000);
  });

  it("reads a time with no offset, and a phrase, as UTC on every host", () => {
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const day = soon.toISOString().slice(0, 10);
    expect(scheduleAt(`${day}T09:00`)?.toISOString()).toBe(`${day}T09:00:00.000Z`);
    expect(scheduleAt(`${day} 09:00:30`)?.toISOString()).toBe(`${day}T09:00:30.000Z`);
    // An offset is taken as given.
    expect(scheduleAt(`${day}T09:00:00-04:00`)?.toISOString()).toBe(`${day}T13:00:00.000Z`);
    const phrase = scheduleAt("tomorrow at 9am")!;
    expect(phrase.getUTCHours()).toBe(9);
    expect(phrase.getUTCMinutes()).toBe(0);
  });

  it("rejects a date more than 30 days out and an unknown phrase", () => {
    expect(() => scheduleAt("in 40 days")).toThrow(ApiError);
    expect(() => scheduleAt("in 40 days")).toThrow(/30 days/);
    expect(() => scheduleAt("not a date at all !!!")).toThrow(/ISO 8601/);
  });

  it("rewrites a phrase to an ISO string on the request body", () => {
    const body = withSchedule({ from: "a@example.com", scheduled_at: "in 2 hours" });
    expect(body.from).toBe("a@example.com");
    expect(new Date(body.scheduled_at ?? "").getTime()).toBeGreaterThan(Date.now());
  });
});
