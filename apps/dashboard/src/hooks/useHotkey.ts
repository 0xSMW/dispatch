import { useEffect, useRef } from "react";

export type HotkeyOptions = {
  enabled?: boolean;
  /** Fire even while focus is in an input, textarea, or select. Combos with `mod` always fire. */
  inInputs?: boolean;
  preventDefault?: boolean;
};

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// Inputs that take no text. A click focuses a checkbox in Chrome and Firefox, and list keys such
// as ⌫ and ⌘A have to keep working right after one is ticked.
const notText = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "INPUT") return !notText.has((target as HTMLInputElement).type);
  return ["TEXTAREA", "SELECT"].includes(target.tagName);
}

/** True when `event` matches a combo such as "m", "escape", "mod+enter", "mod+a", "shift+/". */
export function matches(combo: string, event: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop();
  const mod = parts.includes("mod");
  const wantMeta = parts.includes("meta") || (mod && isMac);
  const wantCtrl = parts.includes("ctrl") || (mod && !isMac);
  if (mod) {
    if (!(event.metaKey || event.ctrlKey)) return false;
  } else if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl) {
    return false;
  }
  if (parts.includes("shift") !== event.shiftKey && key !== "?") return false;
  if (parts.includes("alt") !== event.altKey) return false;
  const pressed = event.key.toLowerCase();
  return pressed === key || (key === "esc" && pressed === "escape") || (key === "delete" && pressed === "backspace");
}

/**
 * Binds a key combo on `document`. Single keys are ignored while the user is typing.
 * Examples: useHotkey("m", toggleTheme), useHotkey("mod+s", save).
 */
export function useHotkey(combo: string, handler: (event: KeyboardEvent) => void, options: HotkeyOptions = {}) {
  const callback = useRef(handler);
  callback.current = handler;
  const { enabled = true, inInputs = false, preventDefault = true } = options;

  useEffect(() => {
    if (!enabled) return;
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || !matches(combo, event)) return;
      const hasMod = /(^|\+)(mod|meta|ctrl)\+/.test(combo.toLowerCase());
      if (!hasMod && !inInputs && typing(event.target)) return;
      if (preventDefault) event.preventDefault();
      callback.current(event);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [combo, enabled, inInputs, preventDefault]);
}
