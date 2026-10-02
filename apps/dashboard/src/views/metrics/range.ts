// Date ranges and buckets for the metrics page. All math is in the browser's time
// zone, which the page also sends to the API, so bucket keys match the API's `period` values.

export type Granularity = "hourly" | "daily" | "weekly" | "monthly";
export type RangeKey = "1d" | "7d" | "15d" | "30d" | "custom";

export const ranges: Array<{ id: RangeKey; label: string; days: number }> = [
  { id: "1d", label: "1D", days: 1 },
  { id: "7d", label: "7D", days: 7 },
  { id: "15d", label: "15D", days: 15 },
  { id: "30d", label: "30D", days: 30 },
];

export const granularities: Granularity[] = ["hourly", "daily", "weekly", "monthly"];
export const maxDays = 30;

const day = 86_400_000;

export type Window = { start: Date; end: Date; granularity: Granularity; error: string | null };

const pad = (value: number) => String(value).padStart(2, "0");

export function dateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours());
}

/** Parses `YYYY-MM-DD` as local midnight. */
export function parseDay(value: string | undefined): Date | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The window a range covers. 1D is the last 24 hours, hourly. The other presets run from local
 * midnight N-1 days ago to now, daily. Custom runs from the start day's midnight to the end of the
 * end day, at most 30 days. `granularity` overrides the automatic one.
 */
export function windowFor(
  input: { range?: string; start?: string; end?: string; granularity?: string },
  now = new Date(),
): Window {
  const chosen = granularities.includes(input.granularity as Granularity) ? (input.granularity as Granularity) : null;
  if (input.range === "custom") {
    const start = parseDay(input.start);
    const last = parseDay(input.end);
    const fallback = { start: startOfDay(addDays(now, -6)), end: now, granularity: chosen ?? "daily" } as const;
    if (!start || !last) return { ...fallback, error: "Pick a start and an end date." };
    if (last < start) return { ...fallback, error: "The end date is before the start date." };
    const end = addDays(last, 1);
    const days = Math.round((end.getTime() - start.getTime()) / day);
    if (days > maxDays) return { ...fallback, error: `Pick ${maxDays} days or fewer.` };
    return { start, end: end > now ? now : end, granularity: chosen ?? (days <= 1 ? "hourly" : "daily"), error: null };
  }
  const preset = ranges.find((item) => item.id === input.range) ?? ranges[1]!;
  if (preset.days === 1) return { start: new Date(now.getTime() - day), end: now, granularity: chosen ?? "hourly", error: null };
  return { start: startOfDay(addDays(now, -(preset.days - 1))), end: now, granularity: chosen ?? "daily", error: null };
}

/** Every bucket key between start and end, formatted as the API formats `period`. */
export function buckets(start: Date, end: Date, granularity: Granularity): string[] {
  const keys: string[] = [];
  if (granularity === "hourly") {
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours());
    while (cursor < end && keys.length < 24 * 62) {
      keys.push(`${dateKey(cursor)}T${pad(cursor.getHours())}:00:00`);
      cursor.setHours(cursor.getHours() + 1);
    }
    return keys;
  }
  if (granularity === "monthly") {
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor < end) {
      keys.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return keys;
  }
  let cursor = startOfDay(start);
  // Postgres weeks start on Monday.
  if (granularity === "weekly") cursor = addDays(cursor, -((cursor.getDay() + 6) % 7));
  const step = granularity === "weekly" ? 7 : 1;
  while (cursor < end) {
    keys.push(dateKey(cursor));
    cursor = addDays(cursor, step);
  }
  return keys;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Axis and tooltip label for a bucket key: "14:00", "Oct 1", or "Oct 2026". */
export function bucketLabel(key: string, granularity: Granularity) {
  const [date, time] = key.split("T");
  const [year, month, dayOfMonth] = (date ?? "").split("-").map(Number);
  const name = months[(month ?? 1) - 1] ?? "";
  if (granularity === "monthly") return `${name} ${year}`;
  if (granularity === "hourly") return `${name} ${dayOfMonth}, ${time?.slice(0, 5) ?? ""}`;
  return `${name} ${dayOfMonth}`;
}

export function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Percent of `part` in `whole`, unrounded. Same denominators as the API. */
export function rate(part: number, whole: number) {
  return whole > 0 ? (part / whole) * 100 : 0;
}

export function percent(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`;
}
