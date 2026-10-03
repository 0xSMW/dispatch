// CSV helpers for the contact import and export. Preview and row counting use bounded chunks;
// the API streams the whole file to storage and the worker parses it.
import { csvCell } from "../../components/CsvExport";
import type { PropertyType } from "../../types";
export type { PropertyType } from "../../types";

/** Parses CSV text into rows. Handles quoted fields, doubled quotes, and line breaks inside quotes. */
export function parseCsv(text: string, maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length && rows.length < maxRows; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if ((field !== "" || row.length) && rows.length < maxRows) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/** The header row and up to `sample` data rows from the start of a file. */
export async function readHead(file: Blob, sample = 3): Promise<{ headers: string[]; rows: string[][] }> {
  const text = await blobText(file.slice(0, 64 * 1024));
  const rows = parseCsv(text.replace(/^﻿/, ""), sample + 1);
  const [headers = [], ...rest] = rows;
  return { headers: headers.map((header) => header.trim()), rows: rest };
}

function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** Counts CSV data records, skipping blank lines and the header, without keeping rows or fields. */
export async function countRows(file: Blob, signal?: AbortSignal, chunkSize = 64 * 1024): Promise<number> {
  const decoder = new TextDecoder();
  let records = 0;
  let quoted = false;
  let afterQuote = false;
  let fieldStart = true;
  let nonempty = false;
  let first = true;

  function scan(text: string) {
    for (const char of text) {
      if (first) {
        first = false;
        if (char === "\uFEFF") continue;
      }
      if (quoted) {
        if (char === '"') {
          quoted = false;
          afterQuote = true;
        } else if (char.trim()) nonempty = true;
      } else if (afterQuote && char === '"') {
        // A doubled quote may straddle a chunk boundary.
        quoted = true;
        afterQuote = false;
        nonempty = true;
      } else {
        afterQuote = false;
        if (char === '"' && fieldStart) {
          quoted = true;
          fieldStart = false;
          nonempty = true;
        } else if (char === ",") {
          fieldStart = true;
          nonempty = true;
        } else if (char === "\n" || char === "\r") {
          if (nonempty) records++;
          nonempty = false;
          fieldStart = true;
        } else {
          // The worker trims unquoted fields, including whitespace before an opening quote.
          if (char.trim()) {
            fieldStart = false;
            nonempty = true;
          }
        }
      }
    }
  }

  for (let offset = 0; offset < file.size; offset += chunkSize) {
    signal?.throwIfAborted();
    const part = file.slice(offset, offset + chunkSize);
    const bytes = typeof part.arrayBuffer === "function" ? await part.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(part);
    });
    signal?.throwIfAborted();
    scan(decoder.decode(bytes, { stream: true }));
  }
  scan(decoder.decode());
  if (nonempty) records++;
  return Math.max(0, records - 1);
}

export type FieldName = "email" | "first_name" | "last_name" | "unsubscribed";
export type PropertyColumn = { column: string; key: string; type: PropertyType; include: boolean };
export type Mapping = Record<FieldName, string> & { properties: PropertyColumn[] };

const aliases: Record<FieldName, string[]> = {
  email: ["email", "emailaddress", "mail", "e_mail"],
  first_name: ["firstname", "first", "givenname", "fname"],
  last_name: ["lastname", "last", "surname", "familyname", "lname"],
  unsubscribed: ["unsubscribed", "unsubscribe", "optedout", "optout"],
};

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A property key the API accepts: letters, digits, and underscores, 50 at most. */
export function propertyKey(header: string): string {
  return header
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50)
    .toLowerCase();
}

/** Maps columns by header name. Every other column becomes a candidate property, off by default. */
export function guessMapping(headers: string[], known: Array<{ key: string; type: string }> = []): Mapping {
  const mapping: Mapping = { email: "", first_name: "", last_name: "", unsubscribed: "", properties: [] };
  const used = new Set<string>();
  for (const field of Object.keys(aliases) as FieldName[]) {
    const match = headers.find((header) => !used.has(header) && aliases[field].includes(squash(header)));
    if (match) {
      mapping[field] = match;
      used.add(match);
    }
  }
  const types = new Map(known.map((item) => [item.key, item.type]));
  mapping.properties = headers
    .filter((header) => header && !used.has(header))
    .map((header) => {
      const key = propertyKey(header);
      const type = types.get(key);
      return { column: header, key, type: (["number", "boolean", "date"].includes(type ?? "") ? type : "string") as PropertyType, include: types.has(key) };
    });
  return mapping;
}

/** The `column_map` field for `POST /contacts/imports`. */
export function columnMap(mapping: Mapping, known: Array<{ key: string; type: PropertyType }> = []) {
  const map: Record<string, unknown> = {};
  if (mapping.email) map.email = { column: mapping.email };
  // Null tells the worker not to import the field. Leaving it out would let the worker pick up a
  // column with the usual header name, which is what "Do not import" is meant to stop.
  for (const field of ["first_name", "last_name"] as const) {
    map[field] = mapping[field] ? { column: mapping[field] } : null;
  }
  map.unsubscribed = mapping.unsubscribed ? { column: mapping.unsubscribed, type: "boolean" } : null;
  const types = new Map(known.map((property) => [property.key, property.type]));
  const properties = Object.fromEntries(
    mapping.properties.filter((item) => item.include && item.key).map((item) => [item.key, { column: item.column, type: types.get(item.key) ?? item.type }]),
  );
  if (Object.keys(properties).length) map.properties = properties;
  return map;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

/** Saves `text` as a file through a temporary link. */
export function download(name: string, text: string, type = "text/csv") {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
