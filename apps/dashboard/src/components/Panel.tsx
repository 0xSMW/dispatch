import type { ReactNode } from "react";

export interface PanelProps {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A bordered section with an optional title row. */
export function Panel({ title, actions, children, className = "" }: PanelProps) {
  return (
    <section className={`panel ${className}`.trim()}>
      {title || actions ? (
        <div className="panelHeader">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="toolbar">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
