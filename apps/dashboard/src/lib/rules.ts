import type { ContactProperty, EventDefinition, PropertyType } from "../types";
import { isIsoDate, operatorsForType as coreOperatorsForType } from "../../../../packages/core/src/rules";
export { isIsoDate } from "../../../../packages/core/src/rules";

// Dashboard field choices and input handling for the shared typed-rule contract.
export type FieldType = PropertyType | "set";
export const operatorsForType = (type: FieldType): readonly string[] => coreOperatorsForType(type);
export type Choice = { value: string; label: string };
export type ContextField = {
  path: string;
  label: string;
  group: "Event" | "Contact" | "Topics" | "Segments" | "Email engagement";
  type: FieldType;
  choices?: Choice[];
};
export const engagementFields: ContextField[] = ["sent", "delivered", "opened", "clicked", "bounced"].map((fact) => ({
  path: `email.${fact}`, label: fact[0]!.toUpperCase() + fact.slice(1), group: "Email engagement", type: "boolean",
}));
export type RuleSources = {
  events?: Array<Pick<EventDefinition, "name" | "schema">>;
  properties?: Array<Pick<ContactProperty, "key" | "type">>;
  topics?: Choice[];
  segments?: Choice[];
};

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
