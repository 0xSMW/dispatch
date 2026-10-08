import { useId, useRef, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { useDialog } from "../hooks/useDialog";
import { Kbd } from "./Kbd";
import { shortcuts } from "../lib/shortcuts";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Custom footer. When omitted and `onSubmit` is set, the footer is the submit and Cancel buttons. */
  actions?: ReactNode;
  /** Makes the body a form. Enter in a field and ⌘↵ anywhere both submit. */
  onSubmit?: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  /** Shows a spinner in the submit button and disables it. */
  submitting?: boolean;
  danger?: boolean;
  size?: "small" | "medium" | "large" | "wide";
}

/** Centered dialog with focus trap, Esc to close, and key hints on its buttons. */
export function Modal({
  isOpen,
  onClose,
  title,
  children,
  actions,
  onSubmit,
  submitLabel = "Save",
  submitDisabled = false,
  submitting = false,
  danger = false,
  size = "medium",
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(ref, isOpen, onClose);

  if (!isOpen) return null;

  const blocked = submitDisabled || submitting;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!blocked) onSubmit?.();
  };

  const footer =
    actions ??
    (onSubmit ? (
      <>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel <span className="keyHints">{shortcuts.dismiss.keys.map((key) => <Kbd key={key}>{key}</Kbd>)}</span>
        </button>
        <button type="submit" className={danger ? "danger" : undefined} disabled={blocked} aria-busy={submitting}>
          {submitting ? <span className="spinner" aria-hidden /> : null}
          {submitLabel} <span className="keyHints">{shortcuts.submit.keys.map((key) => <Kbd key={key}>{key}</Kbd>)}</span>
        </button>
      </>
    ) : null);

  const body = (
    <>
      <div className="modalBody">{children}</div>
      {footer ? <div className="modalFooter">{footer}</div> : null}
    </>
  );

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal ${size}`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!blocked) ref.current?.querySelector("form")?.requestSubmit();
          }
        }}
      >
        <div className="modalHeader">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="ghost icon small" onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </button>
        </div>
        {onSubmit ? (
          <form onSubmit={submit}>
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </div>
  );
}
