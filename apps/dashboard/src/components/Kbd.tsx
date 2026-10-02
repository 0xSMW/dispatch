import type { ReactNode } from "react";

/** "⌘" on Apple platforms, "Ctrl" elsewhere. */
export const metaKey = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";

/** A key hint, such as <Kbd>Esc</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
