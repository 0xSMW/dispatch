import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { Filters } from "./useList";

/**
 * Reads the named URL search params as a filter object for `useList`.
 * `FilterBar` writes them, so a filtered list can be bookmarked and the back button restores it.
 */
export function useFilters(names: string[]): Filters {
  const [params] = useSearchParams();
  const key = names.map((name) => `${name}=${params.get(name) ?? ""}`).join("&");
  return useMemo(
    () => Object.fromEntries(names.map((name) => [name, params.get(name) || undefined])),
    // `key` captures every value read from `params`
    [key],
  );
}
