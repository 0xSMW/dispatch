import * as chrono from "chrono-node";
import { ApiError } from "@dispatchmail/core";

const maxScheduleMs = 30 * 24 * 60 * 60 * 1000;

// A date and time with no offset, such as "2026-10-03T09:00".
const bare = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

// A time with no offset, and a phrase such as "tomorrow at 9am", are read as UTC whatever
// timezone the server runs in. The same request then means the same instant on every host.
// A client that means another zone sends an offset, as the dashboard does.
export function scheduleAt(value: string | undefined | null) {
  if (!value) return null;
  const text = value.trim();
  const iso = new Date(bare.test(text) ? `${text.replace(" ", "T")}Z` : text);
  const date = Number.isNaN(iso.getTime()) ? chrono.parseDate(text, { instant: new Date(), timezone: "UTC" }, { forwardDate: true }) : iso;
  if (!date) {
    throw new ApiError("validation_error", 422, "scheduled_at must be ISO 8601 or a phrase like 'in 1 hour'");
  }
  if (date.getTime() - Date.now() > maxScheduleMs) {
    throw new ApiError("validation_error", 422, "scheduled_at must be within 30 days");
  }
  return date;
}

export function withSchedule<T>(input: T): T {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const body = input as { scheduled_at?: unknown };
  if (typeof body.scheduled_at !== "string") return input;
  const date = scheduleAt(body.scheduled_at);
  return { ...(input as object), scheduled_at: date ? date.toISOString() : undefined } as T;
}
