import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ScrollText } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { DateRange, useDateRange } from "../../components/DateRange";
import { Empty } from "../../components/Empty";
import { ListPage } from "../../components/ListPage";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { useFilters } from "../../hooks/useFilters";
import { useList } from "../../hooks/useList";
import type { Log } from "../../types";
import { useKeyOptions } from "../keys/options";
import "../../styles/operations.css";

/** Status classes, then the codes the API returns most. `GET /logs` takes either. */
export const statusOptions = [
  { value: "2xx", label: "2xx" },
  { value: "4xx", label: "4xx" },
  { value: "5xx", label: "5xx" },
  ...["200", "400", "401", "403", "404", "409", "422", "429", "500"].map((code) => ({ value: code, label: code })),
];

const logCsv: Array<CsvColumn<Log>> = [
  { header: "id", value: (row) => row.id },
  { header: "method", value: (row) => row.method },
  { header: "endpoint", value: (row) => row.endpoint },
  { header: "status", value: (row) => row.response_status },
  { header: "user_agent", value: (row) => row.user_agent },
  { header: "created_at", value: (row) => row.created_at },
];

export function Logs() {
  const filters = useFilters(["q", "status", "user_agent", "api_key_id", "email_id"]);
  const range = useDateRange();
  const keys = useKeyOptions();
  const list = useList<Log>("/logs", { ...filters, start_date: range.start, end_date: range.end });

  return (
    <ListPage
      title="Logs"
      context={filters.email_id ? <EmailScope id={filters.email_id} /> : undefined}
      search="Search by log ID, request ID, or endpoint"
      filters={[
        { param: "status", label: "Statuses", options: statusOptions },
        ...(keys.length > 0 ? [{ param: "api_key_id", label: "API keys", options: keys }] : []),
      ]}
      filterExtra={
        <>
          <ParamInput param="user_agent" label="User agent" />
          <DateRange />
          <CsvExport rows={list.rows} columns={logCsv} name="logs" />
        </>
      }
      list={list}
      noun="logs"
      rowHref={(row) => `/logs/${row.id}`}
      empty={<Empty title="No logs found" body="Every API request shows up here. Clear your filters to see all of them." />}
      columns={[
        {
          header: "Endpoint",
          cell: (row) => (
            <span className="cellMain">
              <Tile tone={statusToVariant(row.response_status)}>
                <ScrollText size={14} />
              </Tile>
              <Link className="mono" to={`/logs/${row.id}`}>
                {row.endpoint}
              </Link>
            </span>
          ),
        },
        { header: "Status", cell: (row) => <Badge value={row.response_status} /> },
        { header: "Method", cell: (row) => <span className="mono">{row.method}</span> },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
    />
  );
}

/** The note above a list scoped to one email's calls, with a way out. */
function EmailScope({ id }: { id: string }) {
  const [, setParams] = useSearchParams();
  return (
    <>
      Calls for email <Link className="mono" to={`/emails/${id}`}>{id}</Link>.{" "}
      <button
        type="button"
        className="ghost small"
        onClick={() =>
          setParams((previous) => {
            const next = new URLSearchParams(previous);
            next.delete("email_id");
            return next;
          })
        }
      >
        Show all logs
      </button>
    </>
  );
}

/** A text filter bound to one URL param. Writes on Enter or when focus leaves. */
function ParamInput({ param, label }: { param: string; label: string }) {
  const [params, setParams] = useSearchParams();
  const current = params.get(param) ?? "";
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current]);

  function commit() {
    if (text.trim() === current) return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (text.trim()) next.set(param, text.trim());
      else next.delete(param);
      return next;
    });
  }

  return (
    <input
      type="search"
      className="filterSelect paramInput"
      aria-label={label}
      placeholder={label}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}
