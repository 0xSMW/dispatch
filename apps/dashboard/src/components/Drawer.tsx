import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  useEffect(() => {
    if (!isOpen) {
      if (timer.current) clearTimeout(timer.current);
      closingRef.current = false;
      setClosing(false);
    }
  }, [isOpen]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  function close() {
    if (closingRef.current) return;
    if (!window.matchMedia || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      closeCallback.current();
      return;
    }
    closingRef.current = true;
    setClosing(true);
    // Keep conditionally mounted panels alive until their exit transition finishes.
    timer.current = setTimeout(() => closeCallback.current(), 220);
  }
  useDialog(ref, isOpen, close);
  if (!isOpen) return null;

  return (
    <div
      className={`overlay drawerOverlay${closing ? " closing" : ""}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
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
            <button type="button" className="ghost icon small" onClick={close} aria-label="Close panel">
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="drawerBody">{children}</div>
      </aside>
    </div>
  );
}
