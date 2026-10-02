import { CliError } from "./errors.js";

export function jsonFlag<T = unknown>(value: string | undefined, flag: string): T | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new CliError("invalid_json", `${flag} must be valid JSON`);
  }
}

// Commander reducer for repeatable flags.
export function collect(value: string, previous: string[] = []) {
  return [...previous, value];
}

// Repeatable key=value flags into an object.
export function pairs(values: string[] | undefined, flag: string, separator = "="): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, string> = {};
  for (const item of values) {
    const at = item.indexOf(separator);
    if (at <= 0) throw new CliError("invalid_flag", `${flag} expects key${separator}value, got "${item}"`);
    out[item.slice(0, at).trim()] = item.slice(at + 1);
  }
  return out;
}

export function csv(value: string | undefined) {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Repeatable, comma-separated flags such as --to a@x.com,b@x.com --to c@x.com.
export function many(values: string[] | undefined) {
  const out = (values ?? []).flatMap((value) => csv(value) ?? []);
  return out.length ? out : undefined;
}

// Drop undefined fields so PATCH bodies only carry what the user set.
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
