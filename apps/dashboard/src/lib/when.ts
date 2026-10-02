import { useEffect, useState } from "react";

/** A schedule time as the browser read it. `far` is past the API's 30-day limit. */
export type When = { date: Date; past: boolean; far: boolean };

const limit = 30 * 24 * 60 * 60 * 1000;

function at(date: Date, now: number): When {
  return { date, past: date.getTime() <= now, far: date.getTime() - now > limit };
}

/** Reads a typed date such as `2026-10-05 09:00` or an ISO time. A date with no time is local midnight. */
export function parseExact(text: string, now = Date.now()): When | null {
  const value = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : at(date, now);
}

/**
 * Reads a schedule the way the API does, with the same parser, but in the browser. The API would
 * read "tomorrow at 9am" in its own timezone, which is usually UTC and not where the user is. So
 * the dashboard resolves the phrase here and sends the exact instant.
 */
export async function parseWhen(text: string, now = new Date()): Promise<When | null> {
  const value = text.trim();
  if (!value) return null;
  const exact = parseExact(value, now.getTime());
  if (exact) return exact;
  const chrono = await import("chrono-node");
  const date = chrono.parseDate(value, now, { forwardDate: true });
  return date ? at(date, now.getTime()) : null;
}

/** Resolves `text` as the user types. `pending` is true until the answer for the current text is in. */
export function useWhen(text: string): { when: When | null; pending: boolean } {
  const [state, setState] = useState<{ text: string; when: When | null }>({ text: "", when: null });
  useEffect(() => {
    let live = true;
    void parseWhen(text)
      .catch(() => null)
      .then((when) => {
        if (live) setState({ text, when });
      });
    return () => {
      live = false;
    };
  }, [text]);
  const current = state.text === text;
  return { when: current ? state.when : null, pending: !current && text.trim() !== "" };
}

export function zone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The line under a schedule field: the resolved local time and zone, or why it cannot be used. */
export function whenHint(text: string, state: { when: When | null; pending: boolean }, verb = "Sends") {
  if (!text.trim()) return `A date and time in ${zone()}, or a phrase such as tomorrow at 9am.`;
  if (state.pending) return "Reading the time…";
  if (!state.when) return "Could not read that as a time. Try 2026-10-05 09:00 or tomorrow at 9am.";
  if (state.when.past) return "That time has passed.";
  if (state.when.far) return "Schedule within the next 30 days.";
  return `${verb} ${state.when.date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })} (${zone()}).`;
}

/** True when the schedule can be sent to the API. */
export function usable(state: { when: When | null; pending: boolean }): state is { when: When; pending: boolean } {
  return Boolean(state.when && !state.when.past && !state.when.far);
}
