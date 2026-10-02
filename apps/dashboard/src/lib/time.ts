const units: Array<[suffix: string, seconds: number]> = [
  ["y", 365 * 24 * 60 * 60],
  ["mo", 30 * 24 * 60 * 60],
  ["d", 24 * 60 * 60],
  ["h", 60 * 60],
  ["m", 60],
];

function parse(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Compact relative time: "just now", "5m ago", "3h ago", "5d ago", "in 2h". */
export function relativeTime(value: string | Date | null | undefined, now: Date = new Date()): string {
  const date = parse(value);
  if (!date) return value ? String(value) : "—";
  const delta = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(delta);
  if (abs < 45) return "just now";
  for (const [suffix, seconds] of units) {
    if (abs >= seconds) {
      const count = Math.floor(abs / seconds);
      return delta < 0 ? `${count}${suffix} ago` : `in ${count}${suffix}`;
    }
  }
  return delta < 0 ? "1m ago" : "in 1m";
}

/** Full local timestamp, used on timelines and in `title` attributes. */
export function absoluteTime(value: string | Date | null | undefined): string {
  const date = parse(value);
  if (!date) return value ? String(value) : "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function isoTime(value: string | Date | null | undefined): string | undefined {
  return parse(value)?.toISOString();
}
