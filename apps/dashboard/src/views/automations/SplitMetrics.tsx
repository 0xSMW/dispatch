import { useRef, useState } from "react";
import { Table } from "../../components/Table";
import type { SplitReport } from "../../types";

export type SplitMetricsProps = {
  report: SplitReport | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onWinner?: (key: string) => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
};

/** Stored assignments, including removed paths. The parent owns the pause/edit/resume transaction. */
export function SplitMetrics({
  report, loading = false, error = null, onRetry, onWinner, disabled = false, busy = false,
}: SplitMetricsProps) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);
  const blocked = disabled || busy || pending || loading || Boolean(error);
  const winner = async (key: string) => {
    if (blocked || lock.current || !onWinner || !report?.data.some((row) => row.key === key && row.weight !== null)) return;
    lock.current = true;
    setPending(true);
    setFailure(null);
    try {
      await onWinner(key);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Could not select the winner.");
    } finally {
      lock.current = false;
      setPending(false);
    }
  };

  return (
    <div className="stack" aria-label="Split comparison" aria-busy={busy || pending || loading}>
      <p className="fieldHint">Runs use recorded assignments, not current weights. Email metrics use same-run attribution within the report window.</p>
      {report ? <p className="fieldHint">Window: {report.start_date} to {report.end_date} (end exclusive).</p> : null}
      {onWinner ? <p className="fieldHint">A winner receives 100% of future assignments. Recorded assignments and existing paths stay unchanged.</p> : null}
      {failure ? <p className="fieldError" role="alert">{failure}</p> : null}
      <Table rows={report?.data ?? []} rowKey={(row) => row.key} loading={loading} error={error}
        onRetry={onRetry ? () => { if (!busy && !pending && !loading) onRetry(); } : undefined}
        empty={<p className="fieldHint">No split results in this time period.</p>}
        columns={[
          { header: "Variant", cell: (row) => <><strong>{row.label}</strong><div className="mono dim">{row.key}</div>{row.weight === null ? <div className="dim">Historical · removed path</div> : null}</> },
          { header: "Current weight", cell: (row) => row.weight === null ? "—" : `${row.weight}%` },
          { header: "Runs", cell: (row) => row.runs.toLocaleString() },
          { header: "Sent", cell: (row) => row.sent.toLocaleString() },
          { header: "Delivered", cell: (row) => row.delivered.toLocaleString() },
          { header: "Unique opens", cell: (row) => row.unique_opened.toLocaleString() },
          { header: "Open rate", cell: (row) => `${row.open_rate}%` },
          { header: "Unique clicks", cell: (row) => row.unique_clicked.toLocaleString() },
          { header: "Click rate", cell: (row) => `${row.click_rate}%` },
          { header: "Bounce rate", cell: (row) => `${row.bounce_rate}%` },
          { header: "Unsubscribes", cell: (row) => row.unsubscribed.toLocaleString() },
          ...(onWinner ? [{
            header: "Winner",
            cell: (row: SplitReport["data"][number]) => row.weight === null ? null : (
              <button type="button" className="secondary small" disabled={blocked}
                aria-label={`Use ${row.label} as winner`} onClick={() => void winner(row.key)}>Use as winner</button>
            ),
          }] : []),
        ]} />
    </div>
  );
}
