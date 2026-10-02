import { metaKey } from "../components/Kbd";

// Every keyboard shortcut, in one place. The handlers bind `combo` with
// `useHotkey`, and the help dialog lists `keys` and `label`, so the two cannot drift.

export type Shortcut = {
  /** What `useHotkey` binds, such as "mod+s". */
  combo: string;
  /** How the help dialog and buttons show it, one entry per key cap. */
  keys: string[];
  label: string;
  /** Where it works. */
  scope: "Anywhere" | "Lists" | "Dialogs" | "Editors";
};

export const shortcuts = {
  api: { combo: "a", keys: ["A"], label: "Open the API reference for this page", scope: "Anywhere" },
  theme: { combo: "m", keys: ["M"], label: "Switch between dark and light", scope: "Anywhere" },
  help: { combo: "?", keys: ["?"], label: "Show keyboard shortcuts", scope: "Anywhere" },
  selectAll: { combo: "mod+a", keys: [metaKey.trim(), "A"], label: "Select every row on the page", scope: "Lists" },
  remove: { combo: "backspace", keys: ["⌫"], label: "Delete the selected rows", scope: "Lists" },
  dismiss: { combo: "escape", keys: ["Esc"], label: "Close a dialog, drawer, or menu", scope: "Dialogs" },
  submit: { combo: "mod+enter", keys: [metaKey.trim(), "↵"], label: "Submit a dialog", scope: "Dialogs" },
  save: { combo: "mod+s", keys: [metaKey.trim(), "S"], label: "Save", scope: "Editors" },
} satisfies Record<string, Shortcut>;

export const scopes: Shortcut["scope"][] = ["Anywhere", "Lists", "Dialogs", "Editors"];

/** True while a modal or drawer is open, so page keys stay out of its way. */
export function dialogOpen() {
  return Boolean(document.querySelector('[role="dialog"]'));
}
