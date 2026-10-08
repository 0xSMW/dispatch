import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Globe2 } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { Empty } from "../../components/Empty";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useFilters } from "../../hooks/useFilters";
import { useBulkKeys } from "../../hooks/useBulkKeys";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useSelection } from "../../hooks/useSelection";
import { domainRegions, domainStatuses } from "../../lib/events";
import { useClient } from "../../shell/session";
import type { Domain } from "../../types";
import "../../styles/operations.css";

/** SES region codes with the city Resend shows next to them. */
export const regionCities: Record<string, string> = {
  "us-east-1": "North Virginia",
  "eu-west-1": "Ireland",
  "sa-east-1": "São Paulo",
  "ap-northeast-1": "Tokyo",
};

export const domainCsv: Array<CsvColumn<Domain>> = [
  { header: "id", value: (row) => row.id },
  { header: "name", value: (row) => row.name },
  { header: "status", value: (row) => row.status },
  { header: "region", value: (row) => row.region },
  { header: "created_at", value: (row) => row.created_at },
];

export function Region({ code }: { code: string }) {
  return (
    <span>
      {regionCities[code] ?? code} {regionCities[code] ? <span className="mono dim">{code}</span> : null}
    </span>
  );
}

export function Domains() {
  const client = useClient();
  const navigate = useNavigate();
  const filters = useFilters(["q", "status", "region"]);
  const list = useList<Domain>("/domains", filters);
  const selection = useSelection(list.rows.map((row) => row.id));
  const [deleting, setDeleting] = useState<Domain[] | null>(null);
  const verify = useMutation((domain: Domain) => client.post(`/domains/${domain.id}/verify`), {
    success: "Verification started.",
    onSuccess: () => list.reload(),
  });

  useBulkKeys(selection, list.rows.length, () => setDeleting(list.rows.filter((row) => selection.has(row.id))));

  const one = deleting?.length === 1 ? deleting[0] : null;

  return (
    <ListPage
      title="Domains"
      actions={
        <Link className="button" to="/domains/add">
          Add domain
        </Link>
      }
      search="Search domains"
      filters={[
        { param: "status", label: "Statuses", options: [...domainStatuses] },
        { param: "region", label: "Regions", options: domainRegions.map((code) => ({ value: code, label: `${regionCities[code] ?? code} (${code})` })) },
      ]}
      filterExtra={<CsvExport rows={list.rows} columns={domainCsv} name="domains" />}
      list={list}
      noun="domains"
      rowHref={(row) => `/domains/${row.id}`}
      selection={selection}
      bulkActions={[
        { label: "Delete", hint: "⌫", danger: true, onClick: () => setDeleting(list.rows.filter((row) => selection.has(row.id))) },
      ]}
      empty={
        filters.q || filters.status || filters.region ? (
          <Empty title="No domains match" body="Try a different search or filter." />
        ) : (
          <Empty title="No domains yet" body="Add a domain to send email from your own address." />
        )
      }
      columns={[
        {
          header: "Domain",
          cell: (row) => (
            <span className="cellMain">
              <Tile tone={statusToVariant(row.status)}>
                <Globe2 size={14} />
              </Tile>
              <Link to={`/domains/${row.id}`}>{row.name}</Link>
            </span>
          ),
        },
        { header: "Status", cell: (row) => <Badge value={row.status} /> },
        { header: "Region", cell: (row) => <Region code={row.region} /> },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          items={[
            { label: "View domain", read: true, onSelect: () => navigate(`/domains/${row.id}`) },
            { label: "Verify DNS", onSelect: () => void verify.mutate(row) },
            "divider",
            { label: "Delete", danger: true, onSelect: () => setDeleting([row]) },
          ]}
        />
      )}
    >
      {deleting && deleting.length > 0 ? (
        <ConfirmPhrase
          title={one ? "Delete domain" : `Delete ${deleting.length} domains`}
          body={one ? `Emails can no longer be sent from ${one.name}.` : `Emails can no longer be sent from ${deleting.map((row) => row.name).join(", ")}.`}
          phrase={one ? one.name : `DELETE ${deleting.length} DOMAINS`}
          action={one ? "Delete domain" : "Delete domains"}
          onConfirm={async () => {
            // There is no batch delete route, so delete one at a time and stop at the first failure.
            try {
              for (const row of deleting) await client.delete(`/domains/${row.id}`);
            } catch (error) {
              void list.reload();
              throw error;
            }
          }}
          onClose={() => setDeleting(null)}
          onDone={() => {
            toast.success(one ? "Domain deleted." : `${deleting.length} domains deleted.`);
            selection.clear();
            void list.reload();
          }}
        />
      ) : null}
    </ListPage>
  );
}
