import pc from "picocolors";
import { safe } from "./safe.js";

const ansi = /\u001b\[[0-9;]*m/g;
const width = (text: string) => text.replace(ansi, "").length;

export function renderTable(columns: string[], rows: unknown[][]) {
  const cells = rows.map((row) => row.map((cell) => safe(cell)));
  const widths = columns.map((column, index) => Math.max(width(column), ...cells.map((row) => width(row[index] ?? ""))));
  const line = (row: string[]) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell + " ".repeat(widths[index]! - width(cell))))
      .join("  ")
      .trimEnd();
  return [pc.bold(line(columns)), ...cells.map(line)].join("\n");
}
