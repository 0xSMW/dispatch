import { ApiError } from "./client";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type EachOptions = {
  /** Treat a 404 as done. For deletes, so a second try after a partial failure can finish. */
  gone?: boolean;
  /** Milliseconds to wait after a 429 before trying the same item again. */
  pause?: number;
};

/**
 * Runs one request per item, one after another. These actions have no batch route, and sending
 * every request at once runs into the rate limit. A 429 waits and tries the same item again, up to
 * three times. Returns the errors of the items that still failed.
 */
export async function each<T>(items: T[], run: (item: T) => Promise<unknown>, options: EachOptions = {}): Promise<unknown[]> {
  const failed: unknown[] = [];
  for (const item of items) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await run(item);
        break;
      } catch (error) {
        const status = error instanceof ApiError ? error.statusCode : 0;
        if (status === 429 && attempt < 3) {
          await wait(options.pause ?? 1000);
          continue;
        }
        if (!(options.gone && status === 404)) failed.push(error);
        break;
      }
    }
  }
  return failed;
}
