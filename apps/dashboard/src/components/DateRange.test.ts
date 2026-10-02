// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { h } from "../testing";
import { DateRange, dateRange } from "./DateRange";

const now = new Date(2026, 9, 1, 15, 30);
const day = (month: number, date: number) => new Date(2026, month, date).toISOString();

describe("dateRange", () => {
  afterEach(cleanup);

  it("snaps presets to local midnight", () => {
    expect(dateRange({}, now)).toEqual({});
    expect(dateRange({ range: "today" }, now)).toEqual({ start: day(9, 1) });
    expect(dateRange({ range: "yesterday" }, now)).toEqual({ start: day(8, 30), end: new Date(new Date(2026, 9, 1).getTime() - 1).toISOString() });
    expect(dateRange({ range: "7d" }, now)).toEqual({ start: day(8, 25) });
    expect(dateRange({ range: "30d" }, now)).toEqual({ start: day(8, 2) });
  });

  it("makes a custom end date inclusive and ignores bad dates", () => {
    expect(dateRange({ range: "custom", start: "2026-09-01", end: "2026-09-02" }, now)).toEqual({
      start: day(8, 1),
      end: new Date(new Date(2026, 8, 3).getTime() - 1).toISOString(),
    });
    expect(dateRange({ range: "custom", start: "nope" }, now)).toEqual({ start: undefined, end: undefined });
  });

  it("shows date inputs only for a custom range", () => {
    render(h(MemoryRouter, { initialEntries: ["/emails"] }, h(DateRange)));
    expect(screen.queryByLabelText("From date")).toBeNull();
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "custom" } });
    expect(screen.getByLabelText("From date")).toBeTruthy();
    expect(screen.getByLabelText("To date")).toBeTruthy();
  });
});
