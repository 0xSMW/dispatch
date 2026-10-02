import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Lock } from "lucide-react";
import { Badge } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Failed } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { Menu } from "../../components/Menu";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { ApiKeyDetail, Domain } from "../../types";
import { keyTone, permissions, RenameKey } from "./Keys";

export function Key() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const can = useCan();
  const navigate = useNavigate();
  const key = useResource<ApiKeyDetail>(`/api-keys/${id}`);
  const row = key.data;
  const domain = useResource<Domain>(row?.domain_id ? `/domains/${row.domain_id}` : null);
  const [dialog, setDialog] = useState<"rename" | "remove" | null>(null);

  if (key.error) return <Failed message={key.error} onRetry={key.reload} />;

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/api-keys", label: "API keys" }}
        icon={<Lock size={20} />}
        tone={row ? keyTone(row) : "neutral"}
        label="API key"
        title={row ? row.name : <Skeleton width="medium" />}
        actions={
          row && can ? (
            <>
              <button type="button" className="secondary" onClick={() => setDialog("rename")}>
                Edit
              </button>
              <Menu label="Key actions" items={[{ label: "Remove key", danger: true, onSelect: () => setDialog("remove") }]} />
            </>
          ) : null
        }
      />

      {row ? (
        <Facts
          items={[
            { label: "Token", value: row.token, mono: true },
            { label: "Permission", value: <Badge value={permissions.find((item) => item.value === row.permission)?.label ?? row.permission} variant="neutral" /> },
            {
              label: "Domain",
              value: row.domain_id ? (
                <Link to={`/domains/${row.domain_id}`}>{domain.data?.name ?? row.domain_id}</Link>
              ) : (
                <span className="dim">All domains</span>
              ),
            },
            {
              label: "Total uses",
              value: <Link to={`/logs?api_key_id=${encodeURIComponent(row.id)}`}>{row.total_uses.toLocaleString()}</Link>,
            },
            { label: "Last used", value: row.last_used_at ? <Time value={row.last_used_at} /> : <span className="dim">Never</span> },
            { label: "Created", value: <Time value={row.created_at} mode="absolute" /> },
            // Known for a key made in the dashboard. A key made with another key has no person behind it.
            { label: "Creator", value: row.creator ?? <span className="dim">API</span> },
            { label: "ID", value: row.id, copy: true },
          ]}
        />
      ) : (
        <Skeleton lines={3} />
      )}

      {dialog === "rename" && row ? <RenameKey apiKey={row} onClose={() => setDialog(null)} onDone={() => void key.reload()} /> : null}
      {dialog === "remove" && row ? (
        <ConfirmPhrase
          title="Remove API key"
          body={`Requests that use ${row.name} will fail at once.`}
          phrase={row.name}
          action="Remove key"
          onConfirm={() => client.delete(`/api-keys/${row.id}`)}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast.success("API key removed.");
            navigate("/api-keys");
          }}
        />
      ) : null}
    </div>
  );
}
