import { useCallback, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

export const themeKey = "dispatch.theme";

const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(themeKey);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

/** The current theme. Dark unless the viewer chose light. */
export function getTheme(): Theme {
  const current = document.documentElement.dataset.theme;
  if (current === "light" || current === "dark") return current;
  return stored() ?? "dark";
}

/** Writes `data-theme` on <html> without storing the choice. Call once at boot. */
export function applyTheme(theme: Theme = stored() ?? "dark") {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(themeKey, theme);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  for (const listener of listeners) listener();
}

export function toggleTheme() {
  setTheme(getTheme() === "dark" ? "light" : "dark");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "dark" as Theme);
  const toggle = useCallback(() => toggleTheme(), []);
  return [theme, toggle];
}
