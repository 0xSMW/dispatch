import { setTimeout as sleep } from "node:timers/promises";

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
  message?: string;
}

export async function poll<T>(
  predicate: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  options: PollOptions = {}
): Promise<T> {
  const { timeoutMs = 8_000, intervalMs = 300, message = "polling timed out" } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result as T;
    await sleep(intervalMs);
  }
  throw new Error(message);
}
