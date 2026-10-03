import { describe, expect, it, vi } from "vitest";
import { columnMap, countRows, guessMapping, parseCsv, propertyKey, readHead, toCsv } from "./csv";

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, commas and line breaks inside quotes, and CRLF", () => {
    const text = 'email,note\r\nada@example.com,"Hello, ""world"""\r\nbob@example.com,"two\nlines"\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ["email", "note"],
      ["ada@example.com", 'Hello, "world"'],
      ["bob@example.com", "two\nlines"],
    ]);
  });

  it("stops after maxRows", () => {
    expect(parseCsv("a\nb\nc\nd", 2)).toEqual([["a"], ["b"]]);
  });
});

describe("readHead", () => {
  it("reads the header and sample rows, dropping a byte order mark", async () => {
    const file = new Blob(["﻿Email, First Name\nada@example.com,Ada\nbob@example.com,Bob\n"]);
    expect(await readHead(file, 1)).toEqual({ headers: ["Email", "First Name"], rows: [["ada@example.com", "Ada"]] });
  });
});

describe("countRows", () => {
  it.each([1, 2, 7, 64 * 1024])("counts records, not quoted line breaks, across %i-byte chunks", async (chunkSize) => {
    const text = '\uFEFFemail,note\r\nada@example.com,"Hello, ""world""\r\nagain"\r\n\r\n,\r\n""," "\r\nbob@example.com,"two\nlines"\r\ncarol@example.com,終';
    expect(await countRows(new Blob([text]), undefined, chunkSize)).toBe(5);
  });

  it.each(["", "email\n", " \r\nemail\r\n", "email\n  \n"])("has no data records for %j", async (text) => {
    expect(await countRows(new Blob([text]))).toBe(0);
  });

  it("counts empty quoted and delimited records and respects the worker's trimmed quoted fields", async () => {
    expect(await countRows(new Blob(['email,note\n"",""\n,\n \t \nada@example.com,  "two\nlines"\n']))).toBe(3);
  });

  it("reads only bounded slices even for a large field and counts the final unterminated line", async () => {
    const file = new Blob([`email,note\nada@example.com,"${"x\n".repeat(100000)}"\nbob@example.com,last`]);
    const slice = vi.spyOn(file, "slice");
    expect(await countRows(file)).toBe(2);
    expect(slice.mock.calls.length).toBeGreaterThan(1);
    for (const [start, end] of slice.mock.calls) expect(end! - start!).toBeLessThanOrEqual(64 * 1024);
  });

  it("aborts when a new file replaces the current one", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(countRows(new Blob(["email\nada@example.com"]), controller.signal)).rejects.toHaveProperty("name", "AbortError");
  });
});

describe("guessMapping and columnMap", () => {
  it("retains boolean/date declarations, including legacy reserved keys, and explicit type choices", () => {
    const known = [{ key: "active", type: "boolean" as const }, { key: "renewed", type: "date" as const }, { key: "topics", type: "number" as const }];
    const mapping = guessMapping(["Email", "Active", "Renewed", "Topics", "Score"], known);
    expect(mapping.properties.map((property) => property.type)).toEqual(["boolean", "date", "number", "string"]);
    mapping.properties[0]!.type = "string"; // A definition loaded later still wins at serialization.
    mapping.properties[3] = { ...mapping.properties[3]!, type: "number", include: true };
    expect(columnMap(mapping, known)).toMatchObject({ properties: {
      active: { column: "Active", type: "boolean" }, renewed: { column: "Renewed", type: "date" },
      topics: { column: "Topics", type: "number" }, score: { column: "Score", type: "number" },
    } });
  });

  it("maps standard columns by header name and offers the rest as properties", () => {
    const mapping = guessMapping(["E-mail Address", "First Name", "surname", "Opted Out", "Company", "Plan Tier"], [
      { key: "plan_tier", type: "number" },
    ]);
    expect(mapping.email).toBe("E-mail Address");
    expect(mapping.first_name).toBe("First Name");
    expect(mapping.last_name).toBe("surname");
    expect(mapping.unsubscribed).toBe("Opted Out");
    expect(mapping.properties).toEqual([
      { column: "Company", key: "company", type: "string", include: false },
      { column: "Plan Tier", key: "plan_tier", type: "number", include: true },
    ]);
    expect(columnMap(mapping)).toEqual({
      email: { column: "E-mail Address" },
      first_name: { column: "First Name" },
      last_name: { column: "surname" },
      unsubscribed: { column: "Opted Out", type: "boolean" },
      properties: { plan_tier: { column: "Plan Tier", type: "number" } },
    });
  });

  it("leaves unmatched fields empty", () => {
    const mapping = guessMapping(["address"]);
    expect(mapping.email).toBe("");
    // Null is an explicit "do not import", so the worker does not pick the column up by its name.
    expect(columnMap({ ...mapping, properties: [] })).toEqual({ first_name: null, last_name: null, unsubscribed: null });
  });

  it("makes property keys the API accepts", () => {
    expect(propertyKey(" Lifetime Value ($) ")).toBe("lifetime_value");
    expect(propertyKey("x".repeat(60))).toHaveLength(50);
  });
});

describe("toCsv", () => {
  it("quotes only when needed and writes empty cells for null", () => {
    expect(toCsv([["a", 'say "hi"', null, 3, true], ["x,y", "line\nbreak", undefined, { k: 1 }, false]])).toBe(
      'a,"say ""hi""",,3,true\n"x,y","line\nbreak",,"{""k"":1}",false',
    );
  });
});
