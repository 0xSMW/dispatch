import type { LucideIcon } from "lucide-react";

export type IconMotion = "mail" | "bars" | "broadcast" | "branches" | "document" | "people"
  | "target" | "globe" | "logs" | "key" | "webhook" | "activity" | "bolt" | "gear" | "code" | "keyboard";

/** Keep Lucide's original geometry; only its SVG parts move inside the fixed icon box. */
export function NavIcon({ icon: Icon, motion, size = 16 }: { icon: LucideIcon; motion: IconMotion; size?: number }) {
  return <Icon size={size} className={`navIcon navIcon-${motion}`} aria-hidden />;
}
