import { absoluteTime, isoTime, relativeTime } from "../lib/time";

export interface TimeProps {
  value: string | Date | null | undefined;
  /** `relative` for lists ("5d ago"), `absolute` for timelines. Both show the other form on hover. */
  mode?: "relative" | "absolute";
}

export function Time({ value, mode = "relative" }: TimeProps) {
  if (!value) return <span className="dim">—</span>;
  const iso = isoTime(value);
  return (
    <time dateTime={iso} title={mode === "relative" ? (iso ?? String(value)) : relativeTime(value)}>
      {mode === "relative" ? relativeTime(value) : absoluteTime(value)}
    </time>
  );
}
