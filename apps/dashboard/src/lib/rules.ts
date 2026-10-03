import type { ContactProperty, EventDefinition, PropertyType } from "../types";

// Lightweight dashboard mirror of the core typed-rule contract. No engine dependency.
export type FieldType = PropertyType | "set";
export type Choice = { value: string; label: string };
export type ContextField = {
  path: string;
  label: string;
  group: "Event" | "Contact" | "Topics" | "Segments";
  type: FieldType;
  choices?: Choice[];
};
export type RuleSources = {
  events?: Array<Pick<EventDefinition, "name" | "schema">>;
  properties?: Array<Pick<ContactProperty, "key" | "type">>;
  topics?: Choice[];
  segments?: Choice[];
};

const operators: Record<FieldType, readonly string[]> = {
  string: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "exists", "is_empty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "exists", "is_empty"],
  boolean: ["eq", "neq", "exists", "is_empty"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "within", "not_within", "exists", "is_empty"],
  set: ["contains", "not_contains", "exists", "is_empty"],
};
export const operatorsForType = (type: FieldType): readonly string[] => operators[type];
export const propertyTypes: Choice[] = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "True or false" },
  { value: "date", label: "Date" },
];

export function contextFields(sources: RuleSources = {}, event = ""): ContextField[] {
  const fields = new Map<string, ContextField>();
  const put = (field: ContextField) => fields.set(field.path, field);
  for (const [key, type] of Object.entries(sources.events?.find((row) => row.name === event)?.schema ?? {})) {
    put({ path: `event.${key}`, label: key, group: "Event", type });
  }
  // Received time is immutable and wins over a payload's declared received_at.
  put({ path: "event.received_at", label: "Received at", group: "Event", type: "date" });
  for (const [key, type] of Object.entries({
    email: "string", first_name: "string", last_name: "string", unsubscribed: "boolean", created_at: "date",
  } as const)) put({ path: `contact.${key}`, label: key, group: "Contact", type });
  put({ path: "contact.topics", label: "Receiving topics", group: "Topics", type: "set", choices: sources.topics ?? [] });
  put({ path: "contact.segments", label: "Segment membership", group: "Segments", type: "set", choices: sources.segments ?? [] });
  // A legacy property named topics/segments is not a membership set. Built-ins still win.
  for (const property of sources.properties ?? []) {
    const path = `contact.${property.key}`;
    if (fields.get(path)?.group === "Contact") continue;
    put({ path, label: property.key, group: "Contact", type: property.type });
  }
  return [...fields.values()];
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2})))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && (match[4] === undefined || (Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59
      && (match[8] === undefined || (Number(match[8]) <= 23 && Number(match[9]) <= 59))))
    && Number.isFinite(Date.parse(value));
}

export function valueKind(value: unknown): PropertyType {
  return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
}

/** Empty means no value; invalid numbers remain NaN so validation prevents JSON's null coercion. */
export function typedValue(type: PropertyType, raw: string): string | number | boolean | null {
  if (!raw.trim()) return null;
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true" ? true : raw === "false" ? false : null;
  return raw;
}

export function valueIssue(type: PropertyType, raw: string): string | null {
  if (!raw.trim()) return null;
  if (type === "number" && !Number.isFinite(Number(raw))) return "Enter a finite number.";
  if (type === "boolean" && raw !== "true" && raw !== "false") return "Choose true or false.";
  if (type === "date" && !isIsoDate(raw)) return "Use an ISO date or a timestamp with a timezone.";
  return null;
}
