import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClient } from "../shell/session";
import { errorMessage } from "../lib/client";
import { listAll } from "../lib/pages";
import type { List } from "../types";

export type Filters = Record<string, string | undefined>;

export type ListState<T> = {
  rows: T[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  page: number;
  reload: () => Promise<void>;
  next: () => void;
  previous: () => void;
};

/**
 * One page of a list endpoint, walked with ID cursors.
 * `next` pushes the last row's id as `after`; `previous` pops it. A filter or path change returns to page one.
 */
export function useList<T extends { id: string }>(
  path: string,
  filters: Filters = {},
  /** `all` reads every page into one list, for pickers. */
  options: { limit?: number; all?: boolean } = {},
): ListState<T> {
  const client = useClient();
  const limit = String(options.limit ?? 40);
  const key = `${path}?${JSON.stringify(Object.entries(filters).filter(([, value]) => Boolean(value)))}`;
  const [cursors, setCursors] = useState<{ key: string; trail: string[] }>({ key, trail: [] });
  const trail = cursors.key === key ? cursors.trail : [];
  const after = trail.at(-1);
  const [state, setState] = useState<{ rows: T[]; hasMore: boolean; loading: boolean; error: string | null }>({
    rows: [],
    hasMore: false,
    loading: true,
    error: null,
  });
  const latest = useRef(0);
  const all = Boolean(options.all);
  const filterQuery = useMemo(
    () => new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString(),
    // `key` stands in for `filters`, which is a new object on every render
    [key],
  );

  const query = useMemo(
    () =>
      new URLSearchParams(
        Object.entries({ ...filters, limit, after }).filter((entry): entry is [string, string] => Boolean(entry[1])),
      ).toString(),
    // `key` stands in for `filters`, which is a new object on every render
    [key, limit, after],
  );

  const load = useCallback(async () => {
    const call = ++latest.current;
    setState((current) => ({ ...current, loading: true }));
    try {
      const result = all ? await listAll<T>(client, filterQuery ? `${path}?${filterQuery}` : path) : await client.get<List<T>>(`${path}?${query}`);
      if (call !== latest.current) return;
      setState({ rows: result.data ?? [], hasMore: Boolean(result.has_more), loading: false, error: null });
    } catch (error) {
      if (call !== latest.current) return;
      setState({ rows: [], hasMore: false, loading: false, error: errorMessage(error) });
    }
  }, [client, path, query, all, filterQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const last = state.rows.at(-1)?.id;
  const next = useCallback(() => {
    if (!state.hasMore || !last) return;
    setCursors({ key, trail: [...trail, last] });
  }, [state.hasMore, last, key, trail]);

  const previous = useCallback(() => {
    setCursors({ key, trail: trail.slice(0, -1) });
  }, [key, trail]);

  return { ...state, reload: load, page: trail.length + 1, next, previous };
}
