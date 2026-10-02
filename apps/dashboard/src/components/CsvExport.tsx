import { Download } from "lucide-react";

export type CsvColumn<T> = { header: string; value: (row: T) => string | number | boolean | null | undefined };

/**
 * One CSV cell. Text that a spreadsheet would read as a formula (it starts with =, +, -, @, a tab,
 * or a carriage return) gets a leading apostrophe, so a subject such as `=HYPERLINK(...)` in a
 * received email cannot run when the export is opened. Numbers are written as they are.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const cell = csvCell;

/** RFC 4180 CSV with a header row. */
export function toCsv<T>(rows: T[], columns: Array<CsvColumn<T>>): string {
  const lines = [columns.map((column) => cell(column.header)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => cell(column.value(row))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Saves `text` as a file through a temporary link. */
export function saveFile(filename: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface CsvExportProps<T> {
  rows: T[];
  columns: Array<CsvColumn<T>>;
  /** File name without the extension, such as "emails". */
  name: string;
}

/** The CSV export icon at the end of a filter row. Exports the rows on screen. */
export function CsvExport<T>({ rows, columns, name }: CsvExportProps<T>) {
  return (
    <button
      type="button"
      className="secondary icon"
      aria-label="Export CSV"
      title="Export this page as CSV"
      disabled={rows.length === 0}
      onClick={() => saveFile(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, columns))}
    >
      <Download size={15} />
    </button>
  );
}
