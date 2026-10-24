import type { ReactNode } from "react";
import { Badge } from "../../components/Badge";
import { Copy } from "../../components/Copy";
import { Table } from "../../components/Table";
import type { DomainCheck, DomainRecord } from "../../types";

type Group = { id: string; title: string; tag?: string; records: DomainRecord[]; note?: ReactNode; control?: ReactNode };

const checkLabels: Record<DomainCheck["status"], string> = { ok: "Found", mismatch: "Wrong value", missing: "Not found" };

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
  /**
   * Receiving state for the Receiving group. The switch itself is on Configuration; when receiving
   * is off, the group links there. Omit to hide the group when it has no records.
   */
  receiving?: { enabled: boolean; onConfigure: () => void };
  loading?: boolean;
}

/** DNS records in groups: DKIM, SPF, Receiving, DMARC, Tracking. */
export function Records({ records, checks, tracking = false, receiving, loading = false }: RecordsProps) {
  const of = (kind: string) => records.filter((record) => (record.record ?? "") === kind);
  const groups: Group[] = [
    { id: "dkim", title: "DKIM", tag: "Required", records: of("DKIM") },
    { id: "spf", title: "SPF", tag: "Required", records: of("SPF") },
    {
      id: "receiving",
      title: "Receiving",
      tag: receiving ? (receiving.enabled ? "On" : "Off") : undefined,
      records: of("Receiving MX"),
      control: receiving && !receiving.enabled ? (
        <button type="button" className="secondary small" onClick={receiving.onConfigure}>
          Open configuration
        </button>
      ) : null,
      note: receiving && !receiving.enabled ? "Receiving is off. Turn it on in Configuration to get the MX record for inbound mail." : null,
    },
    { id: "dmarc", title: "DMARC", tag: "Recommended", records: of("DMARC") },
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
              {group.tag ? <span className="recordTag">{group.tag}</span> : null}
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
                  { header: "Status", cell: (record) => <Badge value={record.status ?? "pending"} /> },
                  ...(checks
                    ? [
                        {
                          header: "DNS check",
                          cell: (record: DomainRecord) => {
                            const check = checkFor(record, checks);
                            return check ? (
                              <Badge value={check.status} label={checkLabels[check.status]} variant={check.status === "ok" ? "success" : "danger"} />
                            ) : (
                              <span className="dim">Not checked</span>
                            );
                          },
                        },
                      ]
                    : []),
                ]}
              />
            ) : null}
          </section>
        ))}
    </div>
  );
}

/**
 * The result of `GET /domains/:id/doctor` in words: how many records DNS returns as expected,
 * and any check that matches no listed record.
 */
export function CheckSummary({ records, checks }: { records: DomainRecord[]; checks: DomainCheck[] }) {
  const found = checks.filter((check) => check.status === "ok").length;
  const unmatched = checks.filter((check) => !records.some((record) => checkFor(record, [check])));
  return (
    <div className="checkSummary" role="status">
      <p>
        <strong>DNS check:</strong>{" "}
        {found === checks.length
          ? `DNS returns all ${checks.length} records as expected.`
          : `${checks.length - found} of ${checks.length} records are wrong or missing. Each one is marked in the DNS check column below.`}
      </p>
      {unmatched.length ? (
        <ul>
          {unmatched.map((check) => (
            <li key={`${check.type}-${check.name}-${check.expected}`}>
              <span className="mono">{check.type} {check.name}</span>: {checkLabels[check.status]}. {check.status === "ok" ? null : check.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
