import { useSearchParams } from "react-router-dom";

/** Preset ranges: Today, Yesterday, Last 3, 7, 15, 30 days, and custom. */
export const datePresets = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "3d", label: "Last 3 days" },
  { value: "7d", label: "Last 7 days" },
  { value: "15d", label: "Last 15 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom" },
] as const;

function startOfDay(date: Date, offsetDays = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays);
}

function parseDay(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Turns the `range`, `start`, and `end` URL params into ISO bounds in local time.
 * Presets snap to midnight so the values stay stable through the day and do not refetch.
 * Custom days are inclusive: `end` covers the whole last day.
 */
export function dateRange(
  params: { range?: string | null; start?: string | null; end?: string | null },
  now: Date = new Date(),
): { start?: string; end?: string } {
  const today = startOfDay(now);
  switch (params.range) {
    case "today":
      return { start: today.toISOString() };
    case "yesterday":
      return { start: startOfDay(now, -1).toISOString(), end: new Date(today.getTime() - 1).toISOString() };
    case "3d":
    case "7d":
    case "15d":
    case "30d":
      return { start: startOfDay(now, 1 - Number.parseInt(params.range, 10)).toISOString() };
    case "custom": {
      const start = parseDay(params.start);
      const end = parseDay(params.end);
      return {
        start: start?.toISOString(),
        end: end ? new Date(startOfDay(end, 1).getTime() - 1).toISOString() : undefined,
      };
    }
    default:
      return {};
  }
}

/** Reads the date range from the URL. Pass the result's `start` and `end` to the list's own filter names. */
export function useDateRange(): { start?: string; end?: string } {
  const [params] = useSearchParams();
  return dateRange({ range: params.get("range"), start: params.get("start"), end: params.get("end") });
}

/** Date range select for a filter row, with two date inputs for a custom range. Writes `range`, `start`, `end`. */
export function DateRange() {
  const [params, setParams] = useSearchParams();
  const range = params.get("range") ?? "";

  function set(values: Record<string, string>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  }

  return (
    <span className="inline">
      <select
        aria-label="Date range"
        className="filterSelect"
        value={range}
        onChange={(event) => set({ range: event.target.value, ...(event.target.value === "custom" ? {} : { start: "", end: "" }) })}
      >
        <option value="">All time</option>
        {datePresets.map((preset) => (
          <option key={preset.value} value={preset.value}>
            {preset.label}
          </option>
        ))}
      </select>
      {range === "custom" ? (
        <>
          <input type="date" aria-label="From date" className="filterSelect" value={params.get("start") ?? ""} onChange={(event) => set({ start: event.target.value })} />
          <input type="date" aria-label="To date" className="filterSelect" value={params.get("end") ?? ""} onChange={(event) => set({ end: event.target.value })} />
        </>
      ) : null}
    </span>
  );
}
