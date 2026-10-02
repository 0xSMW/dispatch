import type { ReactNode } from "react";
import { Badge } from "../../components/Badge";
import { Copy } from "../../components/Copy";
import { Switch } from "../../components/Field";
import { Table } from "../../components/Table";
import type { DomainCheck, DomainRecord } from "../../types";

type Group = { id: string; title: string; tag?: ReactNode; records: DomainRecord[]; note?: ReactNode; control?: ReactNode };

/** The doctor result for one record, matched on type and expected value (doctor names are fully qualified). */
export function checkFor(record: DomainRecord, checks: DomainCheck[] = []) {
  return checks.find((check) => check.type === record.type && check.expected === record.value);
}

export interface RecordsProps {
  records: DomainRecord[];
  /** Results of `GET /domains/:id/doctor`. A wrong or missing value is marked on its row. */
  checks?: DomainCheck[];
  /** Shows the Tracking group. */
  tracking?: boolean;
  /** The receiving switch on the Receiving group. Omit to hide the group when it has no records. */
  receiving?: { enabled: boolean; busy?: boolean; onChange: (enabled: boolean) => void };
  loading?: boolean;
}

/** DNS records in groups: DKIM, SPF, Receiving, DMARC, Tracking. */
export function Records({ records, checks, tracking = false, receiving, loading = false }: RecordsProps) {
  const of = (kind: string) => records.filter((record) => (record.record ?? "") === kind);
  const required = <Badge value="Required" variant="neutral" />;
  const groups: Group[] = [
    { id: "dkim", title: "DKIM", tag: required, records: of("DKIM") },
    { id: "spf", title: "SPF", tag: required, records: of("SPF") },
    {
      id: "receiving",
      title: "Receiving",
      records: of("Receiving MX"),
      control: receiving ? (
        <Switch label={receiving.enabled ? "On" : "Off"} checked={receiving.enabled} disabled={receiving.busy} onChange={receiving.onChange} />
      ) : null,
      note: receiving && !receiving.enabled ? "Turn on receiving to get the MX record for inbound mail." : null,
    },
    { id: "dmarc", title: "DMARC", tag: <Badge value="Recommended" variant="info" />, records: of("DMARC") },
    { id: "tracking", title: "Tracking", records: tracking ? of("Tracking") : [] },
  ];
  // Records with no `record` kind, from domains created before the field existed.
  const other = records.filter((record) => !record.record);
  if (other.length > 0) groups.push({ id: "other", title: "Records", records: other });

  return (
    <div className="recordGroups">
      {groups
        .filter((group) => group.records.length > 0 || group.control)
        .map((group) => (
          <section key={group.id} className="recordGroup" aria-label={`${group.title} records`}>
            <header className="recordGroupHeader">
              <h3>{group.title}</h3>
              {group.tag}
              {group.control ? <span className="recordGroupControl">{group.control}</span> : null}
            </header>
            {group.note ? <p className="muted">{group.note}</p> : null}
            {group.records.length > 0 ? (
              <Table
                compact
                loading={loading}
                rows={group.records}
                rowKey={(record) => `${record.type}-${record.name}-${record.value}`}
                columns={[
                  { header: "Type", cell: (record) => <span className="mono">{record.type}</span> },
                  { header: "Name", cell: (record) => <Copy value={record.name} chip label="Copy name" /> },
                  {
                    header: "Content",
                    cell: (record) => {
                      const check = checkFor(record, checks);
                      const wrong = check && check.status !== "ok";
                      return (
                        <span className={wrong ? "recordValue wrongValue" : "recordValue"}>
                          <Copy value={record.value} chip className="wrap" label="Copy value" />
                          {wrong ? <span className="fieldError">{check.message}</span> : null}
                        </span>
                      );
                    },
                  },
                  { header: "TTL", cell: (record) => <span className="mono">{record.ttl ?? "Auto"}</span> },
                  { header: "Priority", cell: (record) => <span className="mono">{record.priority ?? ""}</span> },
                  {
                    header: "Status",
                    cell: (record) => {
                      const check = checkFor(record, checks);
                      return check && check.status !== "ok" ? <Badge value={check.status} variant="danger" /> : <Badge value={record.status ?? "pending"} />;
                    },
                  },
                ]}
              />
            ) : null}
          </section>
        ))}
    </div>
  );
}
