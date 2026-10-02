import { createContext, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

export type MenuItem =
  | {
      label: string;
      onSelect: () => void;
      icon?: ReactNode;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      hidden?: boolean;
      /** Only reads, such as View or Copy ID, so a viewer gets it in a table's row menu. */
      read?: boolean;
    }
  | "divider";

/** True inside a viewer's table rows: their menus keep only the items marked `read`. */
export const ReadOnlyMenus = createContext(false);

export interface MenuProps {
  items: MenuItem[];
  /** Accessible name for the default "…" trigger. */
  label?: string;
  /** Custom trigger content, such as the account avatar. */
  trigger?: ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
  placement?: "down" | "up";
}

/** The "…" row and page menu. Closes on select, outside click, and Esc. Arrow keys move between items. */
export function Menu({ items, label = "Actions", trigger, triggerClassName, align = "end", placement = "down" }: MenuProps) {
  const [open, setOpen] = useState(false);
  // The list is position: fixed, so table and drawer overflow cannot clip it.
  const [coords, setCoords] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const readOnly = useContext(ReadOnlyMenus);
  const visible = items.filter((item) => item === "divider" || (!item.hidden && (!readOnly || item.read)));

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onMove() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  function toggle() {
    if (!open && button.current) {
      const box = button.current.getBoundingClientRect();
      setCoords({
        ...(placement === "down" ? { top: box.bottom + 4 } : { bottom: window.innerHeight - box.top + 4 }),
        ...(align === "end" ? { right: window.innerWidth - box.right } : { left: box.left }),
      });
    }
    setOpen(!open);
  }

  function move(step: number) {
    const entries = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    entries[(index + step + entries.length) % entries.length]?.focus();
  }

  // A viewer's row menu with nothing left to read shows no trigger at all.
  if (!visible.some((item) => item !== "divider")) return null;
  return (
    <div
      className="menu"
      ref={root}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          button.current?.focus();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className={triggerClassName ?? "ghost icon small"}
        aria-label={trigger ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
      >
        {trigger ?? <MoreHorizontal size={16} />}
      </button>
      {open ? (
        <div id={id} role="menu" className="menuList" style={coords}>
          {visible.map((item, index) =>
            item === "divider" ? (
              <hr key={`divider-${index}`} />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={item.danger ? "menuItem danger" : "menuItem"}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.hint ? <kbd>{item.hint}</kbd> : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
