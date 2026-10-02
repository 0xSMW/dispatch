import type { Client } from "./client";
import type { List } from "../types";

/**
 * Every row of a list endpoint, read 100 at a time with ID cursors. For pickers and lookups that
 * need the whole set: with only the first page, the 101st segment could not be chosen, and a
 * draft that already used it looked as if it had none. Stops at `max` rows and says so in
 * `has_more`.
 */
export async function listAll<T extends { id: string }>(client: Client, path: string, max = 2000): Promise<List<T>> {
  const rows: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await client.get<List<T>>(path, { limit: 100, after });
    const data = page.data ?? [];
    rows.push(...data);
    const more = Boolean(page.has_more) && data.length > 0;
    if (!more || rows.length >= max) return { ...page, has_more: more, data: rows };
    after = data[data.length - 1]!.id;
  }
}
