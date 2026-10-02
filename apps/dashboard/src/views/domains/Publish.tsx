import { useState } from "react";
import { Cloud } from "lucide-react";
import { Facts } from "../../components/Facts";
import { Modal } from "../../components/Modal";
import { Table } from "../../components/Table";
import { useMutation } from "../../hooks/useMutation";
import { useClient } from "../../shell/session";
import type { Route53Publish } from "../../types";

/** Auto-configure: writes the domain's records to its Route 53 hosted zone, then lists what it skipped and why. */
export function Publish({ domainId, onDone }: { domainId: string; onDone?: () => void }) {
  const client = useClient();
  const [result, setResult] = useState<Route53Publish | null>(null);
  const publish = useMutation(() => client.post<Route53Publish>(`/domains/${domainId}/publish-route53`), {
    success: (data) => (data.changes === 1 ? "1 record published." : `${data.changes} records published.`),
    onSuccess: (data) => {
      setResult(data);
      onDone?.();
    },
  });

  return (
    <>
      <button type="button" className="secondary" disabled={publish.isLoading} onClick={() => void publish.mutate()}>
        {publish.isLoading ? <span className="spinner" aria-hidden /> : <Cloud size={14} />}
        Publish to Route 53
      </button>
      <Modal
        isOpen={Boolean(result)}
        onClose={() => setResult(null)}
        title="Published to Route 53"
        size="large"
        actions={
          <button type="button" onClick={() => setResult(null)}>
            Done
          </button>
        }
      >
        {result ? (
          <div className="stack">
            <Facts
              columns={2}
              items={[
                { label: "Hosted zone", value: result.hosted_zone_id, copy: true },
                { label: "Records written", value: String(result.changes) },
              ]}
            />
            {result.skipped.length > 0 ? (
              <>
                <p className="muted">These records were left alone. Add or fix them by hand.</p>
                <Table
                  compact
                  rows={result.skipped}
                  rowKey={(row) => `${row.type}-${row.name}`}
                  columns={[
                    { header: "Record", cell: (row) => row.record },
                    { header: "Type", cell: (row) => <span className="mono">{row.type}</span> },
                    { header: "Name", cell: (row) => <span className="mono">{row.name}</span> },
                    { header: "Reason", cell: (row) => row.reason },
                  ]}
                />
              </>
            ) : (
              <p className="muted">Every record was written. Verify the domain once DNS has updated.</p>
            )}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
