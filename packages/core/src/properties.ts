export const propertyTypes = ["string", "number", "boolean", "date"] as const;
export type PropertyType = (typeof propertyTypes)[number];

// Dates are calendar dates or zoned ISO timestamps, never locale-dependent text.
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]!) return false;
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) return false;
  if (zone && zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function propertyValueMatches(type: PropertyType, value: unknown) {
  if (value === null || value === undefined) return true;
  if (type === "date") return isIsoDate(value);
  return typeof value === type && (type !== "number" || Number.isFinite(value));
}
