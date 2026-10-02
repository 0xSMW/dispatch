import { shortcuts, dialogOpen } from "../lib/shortcuts";
import { typing, useHotkey } from "./useHotkey";
import type { Selection } from "./useSelection";
import { useCan } from "../shell/session";

/**
 * The list keys: ⌘A selects every row on the page, and ⌫ opens delete for the
 * selection. Both stand aside while the user types or a dialog is open. ⌘A in a field keeps the
 * browser's own select-all. A viewer has no checkboxes, so neither key does anything for them.
 */
export function useBulkKeys(selection: Selection, rowCount: number, onDelete?: () => void) {
  const can = useCan();
  useHotkey(
    shortcuts.selectAll.combo,
    (event) => {
      if (!can || typing(event.target) || dialogOpen() || rowCount === 0) return;
      event.preventDefault();
      if (!selection.allSelected) selection.toggleAll();
    },
    { preventDefault: false },
  );
  useHotkey(
    shortcuts.remove.combo,
    () => {
      if (selection.count > 0 && !dialogOpen()) onDelete?.();
    },
    { enabled: can && Boolean(onDelete) && selection.count > 0 },
  );
}
