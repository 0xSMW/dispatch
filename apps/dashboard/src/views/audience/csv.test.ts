import { describe, expect, it } from "vitest";
import { columnMap, guessMapping, parseCsv, propertyKey, readHead, toCsv } from "./csv";

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

describe("guessMapping and columnMap", () => {
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
