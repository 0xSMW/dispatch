import { useCallback, useEffect, useMemo, useState } from "react";

export type Selection = {
  ids: string[];
  count: number;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Selects every visible row, or clears them when all are already selected. */
  toggleAll: () => void;
  allSelected: boolean;
  someSelected: boolean;
  clear: () => void;
};

/**
 * Checkbox state for the rows on screen. Pass the visible row ids; ids that leave the page drop out.
 * Pair with `<Table selection={...}>` and `<BulkBar>`.
 */
export function useSelection(visible: string[]): Selection {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const key = visible.join(",");

  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visible.includes(id)));
      return next.size === current.size ? current : next;
    });
    // `key` stands in for `visible`, which is a new array on every render
  }, [key]);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = visible.length > 0 && visible.every((id) => selected.has(id));

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(visible));
  }, [allSelected, key]);

  const clear = useCallback(() => setSelected(new Set()), []);

  return useMemo(
    () => ({
      ids: [...selected],
      count: selected.size,
      has: (id: string) => selected.has(id),
      toggle,
      toggleAll,
      allSelected,
      someSelected: selected.size > 0 && !allSelected,
      clear,
    }),
    [selected, toggle, toggleAll, allSelected, clear],
  );
}
