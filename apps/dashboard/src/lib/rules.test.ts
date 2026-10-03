import { describe, expect, it } from "vitest";
import { contextFields, isIsoDate, operatorsForType, typedValue, valueIssue } from "./rules";

describe("typed rule fields", () => {
  it("uses the selected event, typed built-ins, definitions, and membership names", () => {
    const fields = contextFields({
      events: [
        { name: "signup", schema: { plan: "string", paid: "boolean", seats: "number", expires: "date", received_at: "string" } },
        { name: "purchase", schema: { total: "number" } },
      ],
      properties: [{ key: "renewed", type: "date" }, { key: "unsubscribed", type: "string" }],
      topics: [{ value: "topic_news", label: "News" }],
      segments: [{ value: "seg_vip", label: "VIP" }],
    }, "signup");
    const byPath = Object.fromEntries(fields.map((field) => [field.path, field]));
    expect(byPath["event.seats"]?.type).toBe("number");
    expect(byPath["event.paid"]?.type).toBe("boolean");
    expect(byPath["event.expires"]?.type).toBe("date");
    expect(byPath["event.received_at"]?.type).toBe("date");
    expect(byPath["event.total"]).toBeUndefined();
    expect(byPath["contact.unsubscribed"]?.type).toBe("boolean");
    expect(byPath["contact.renewed"]?.group).toBe("Contact");
    expect(byPath["contact.topics"]?.choices).toEqual([{ value: "topic_news", label: "News" }]);
    expect(byPath["contact.segments"]?.choices).toEqual([{ value: "seg_vip", label: "VIP" }]);
  });

  it("keeps legacy topics and segments declarations instead of masking their types", () => {
    const fields = contextFields({ properties: [{ key: "topics", type: "boolean" }, { key: "segments", type: "number" }] });
    expect(fields.find((field) => field.path === "contact.topics")).toEqual({ path: "contact.topics", label: "topics", group: "Contact", type: "boolean" });
    expect(fields.find((field) => field.path === "contact.segments")).toEqual({ path: "contact.segments", label: "segments", group: "Contact", type: "number" });
    expect(fields.filter((field) => field.type === "set")).toHaveLength(0);
  });

  it("offers exactly the operators in the shared contract", () => {
    expect(operatorsForType("string")).toEqual(["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "exists", "is_empty"]);
    expect(operatorsForType("number")).toEqual(["eq", "neq", "gt", "gte", "lt", "lte", "exists", "is_empty"]);
    expect(operatorsForType("boolean")).toEqual(["eq", "neq", "exists", "is_empty"]);
    expect(operatorsForType("date")).toEqual(["eq", "neq", "gt", "gte", "lt", "lte", "within", "not_within", "exists", "is_empty"]);
    expect(operatorsForType("set")).toEqual(["contains", "not_contains", "exists", "is_empty"]);
  });
});

describe("typed values", () => {
  it.each(["2024-02-29", "2026-10-04", "2026-10-04T12:34:56Z", "2026-10-04T12:34:56.123456+05:30"])("accepts ISO date %s", (value) => {
    expect(isIsoDate(value)).toBe(true);
    expect(typedValue("date", value)).toBe(value);
  });
  it.each(["2025-02-29", "2026-04-31", "2026-13-01", "2026-10-04T12:34:56", "2026-10-04T12:34Z", "2026-10-04T24:00:00Z", "2026-10-04T12:34:56+24:00", "yesterday", "", null, 123, Number.NaN])("rejects invalid date %s", (value) => {
    expect(isIsoDate(value)).toBe(false);
  });
  it("converts JSON types, preserves false/zero and literals, and rejects invalid values", () => {
    expect(typedValue("boolean", "false")).toBe(false);
    expect(typedValue("boolean", "true")).toBe(true);
    expect(typedValue("number", "0")).toBe(0);
    expect(typedValue("number", "2.5")).toBe(2.5);
    expect(typedValue("string", " true ")).toBe(" true ");
    expect(typedValue("date", "")).toBeNull();
    expect(valueIssue("number", "Infinity")).toBeTruthy();
    expect(valueIssue("boolean", "yes")).toBeTruthy();
    expect(valueIssue("date", "2026-02-30")).toBeTruthy();
  });
});
