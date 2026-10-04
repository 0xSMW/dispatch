import { Fragment } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "./Badge";
import { Failed } from "./Empty";
import { Panel } from "./Panel";
import { Skeleton } from "./Skeleton";
import "../styles/editor.css";

export type CheckRow = {
  /** The source rule or result's identity, independent of its text, severity, and position. */
  id: string;
  tone: "ok" | "warn" | "fail";
  text: string;
  detail?: string;
  group?: string;
};

export type CheckGroup = {
  id: string;
  title: string;
  tone: CheckRow["tone"];
};

export type ChecksProps = {
  rows: readonly CheckRow[];
  /** Optional existing categories, shown in the same list with their counts. */
  groups?: readonly CheckGroup[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};

const variants = { ok: "success", warn: "warning", fail: "danger" } as const;

function Row({ row }: { row: CheckRow }) {
  return (
    <li className={row.tone} data-check-id={row.id}>
      {row.tone === "ok" ? <CheckCircle2 size={15} aria-hidden /> : row.tone === "warn" ? <AlertTriangle size={15} aria-hidden /> : <XCircle size={15} aria-hidden />}
      <span>
        {row.text}
        {row.detail ? <span className="detail">{row.detail}</span> : null}
      </span>
    </li>
  );
}

/** Presents existing results only. Callers retain all checking, fetching, and blocking logic. */
export function Checks({ rows, groups = [], loading = false, error, onRetry }: ChecksProps) {
  const grouped = new Set(groups.map((group) => group.id));
  return (
    <Panel title="Checks">
      {error ? (
        <Failed message={error} onRetry={onRetry} />
      ) : loading ? (
        <Skeleton lines={4} />
      ) : (
        <ul className="checklist" aria-label="Checks">
          {groups.map((group) => {
            const items = rows.filter((row) => row.group === group.id);
            return (
              <Fragment key={group.id}>
                <li>
                  <div className="stack">
                    <h3 className="inline">
                      {group.title} <Badge value={items.length} variant={items.length ? variants[group.tone] : "neutral"} />
                    </h3>
                    {items.length === 0 ? <p className="dim">Nothing here.</p> : null}
                  </div>
                </li>
                {items.map((row) => <Row key={row.id} row={row} />)}
              </Fragment>
            );
          })}
          {rows.filter((row) => !row.group || !grouped.has(row.group)).map((row) => <Row key={row.id} row={row} />)}
        </ul>
      )}
    </Panel>
  );
}
