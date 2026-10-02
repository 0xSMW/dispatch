import type { ReactNode } from "react";
import { Copy } from "./Copy";

export type Fact = {
  label: string;
  value: ReactNode;
  /** Adds a copy button. `true` copies `value` when it is a string; a string copies itself. */
  copy?: boolean | string;
  mono?: boolean;
  hidden?: boolean;
};

export interface FactsProps {
  items: Fact[];
  columns?: 2 | 3 | 4;
  className?: string;
}

/** The facts grid: uppercase gray labels over values. IDs go in a mono chip with `copy`. */
export function Facts({ items, columns = 4, className = "" }: FactsProps) {
  return (
    <dl className={`facts cols${columns} ${className}`.trim()}>
      {items
        .filter((item) => !item.hidden)
        .map((item) => {
          const text = typeof item.copy === "string" ? item.copy : typeof item.value === "string" ? item.value : null;
          const empty = item.value === null || item.value === undefined || item.value === "";
          return (
            <div key={item.label} className="fact">
              <dt>{item.label}</dt>
              <dd className={item.mono ? "mono" : undefined}>
                {empty ? (
                  <span className="dim">—</span>
                ) : item.copy && text && typeof item.value === "string" ? (
                  <Copy value={text} chip />
                ) : item.copy && text ? (
                  <span className="inline">
                    {item.value}
                    <Copy value={text} />
                  </span>
                ) : (
                  item.value
                )}
              </dd>
            </div>
          );
        })}
    </dl>
  );
}
