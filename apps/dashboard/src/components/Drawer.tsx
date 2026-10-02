import { useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useDialog } from "../hooks/useDialog";

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Small gray label above the title, such as "Run" or "Help". */
  label?: string;
  children: ReactNode;
  actions?: ReactNode;
  width?: "medium" | "wide";
}

/** Right-side panel for details and help. Same focus and Esc handling as `Modal`. */
export function Drawer({ isOpen, onClose, title, label, children, actions, width = "medium" }: DrawerProps) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialog(ref, isOpen, onClose);
  if (!isOpen) return null;

  return (
    <div
      className="overlay drawerOverlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`drawer ${width}`} tabIndex={-1}>
        <header className="drawerHeader">
          <div>
            {label ? <div className="typeLabel">{label}</div> : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          <div className="toolbar">
            {actions}
            <button type="button" className="ghost icon small" onClick={onClose} aria-label="Close panel">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="drawerBody">{children}</div>
      </aside>
    </div>
  );
}
