import type { ReactNode } from "react";

export interface EmptyProps {
  title?: string;
  body?: ReactNode;
  action?: ReactNode;
}

/** "No results" with a line of help under it. Tables use it for empty pages. */
export function Empty({ title = "No results", body, action }: EmptyProps) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

/** Error state with a retry button. */
export function Failed({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty failed" role="alert">
      <strong>Could not load</strong>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="secondary small" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
