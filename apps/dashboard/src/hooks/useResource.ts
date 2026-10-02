import { useCallback, useEffect, useRef, useState } from "react";
import { useClient } from "../shell/session";
import { errorMessage, type Client } from "../lib/client";
import { listAll } from "../lib/pages";
import type { List } from "../types";

export type ResourceState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Replace the cached value after a write that returns the new object. */
  setData: (data: T | null) => void;
};

const getOne = <T,>(client: Client, path: string) => client.get<T>(path);

/** Every row of a list endpoint, as one list. For pickers, which must offer the whole set. */
export function useAll<T extends { id: string }>(path: string | null): ResourceState<List<T>> {
  return useResource<List<T>>(path, listAll);
}

/** Loads one object. Pass `null` to skip, for example while an id is unknown. */
export function useResource<T>(path: string | null, fetcher: (client: Client, path: string) => Promise<T> = getOne): ResourceState<T> {
  const client = useClient();
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: Boolean(path),
    error: null,
  });
  const latest = useRef(0);
  const loaded = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    const call = ++latest.current;
    // Another object: drop the old one, so a page never shows A's data under B's URL. A reload of
    // the same object keeps what is on screen, and keeps it if the reload fails.
    const same = loaded.current === path;
    loaded.current = path;
    setState((current) => ({ data: same ? current.data : null, loading: true, error: same ? current.error : null }));
    try {
      const data = await fetcher(client, path);
      if (call === latest.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (call === latest.current) setState((current) => ({ data: current.data, loading: false, error: errorMessage(error) }));
    }
  }, [client, path, fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  const setData = useCallback((data: T | null) => setState((current) => ({ ...current, data })), []);

  return { ...state, reload: load, setData };
}
