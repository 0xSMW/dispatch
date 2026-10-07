import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Mail } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { copyText } from "../../components/Copy";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { DateRange, useDateRange } from "../../components/DateRange";
import { Empty } from "../../components/Empty";
import { ListPage } from "../../components/ListPage";
import { Menu, type MenuItem } from "../../components/Menu";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useFilters } from "../../hooks/useFilters";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { emailStatuses } from "../../lib/events";
import { useClient } from "../../shell/session";
import type { Email } from "../../types";
import { useKeyOptions } from "../keys/options";
import { emailTabs } from "../tabs";
import { Sandbox } from "./Sandbox";

export const emailCsv: Array<CsvColumn<Email>> = [
  { header: "id", value: (row) => row.id },
  { header: "to", value: (row) => row.to.join(" ") },
  { header: "from", value: (row) => row.from },
  { header: "subject", value: (row) => row.subject },
  { header: "status", value: (row) => row.last_event },
  { header: "sandbox", value: (row) => String(row.sandbox) },
  { header: "created_at", value: (row) => row.created_at },
];

/** An email can be canceled or rescheduled while it waits, and retried after it fails or is canceled. */
export const cancelable = (email: Pick<Email, "last_event">) => ["queued", "scheduled"].includes(email.last_event);
export const retryable = (email: Pick<Email, "last_event">) => ["failed", "canceled"].includes(email.last_event);

export function Emails() {
  const client = useClient();
  const navigate = useNavigate();
  const filters = useFilters(["q", "status", "api_key_id"]);
  const range = useDateRange();
  const list = useList<Email>("/emails", { ...filters, from: range.start, to: range.end });
  const keys = useKeyOptions();
  const [canceling, setCanceling] = useState<Email | null>(null);
  const retry = useMutation((email: Email) => client.post(`/emails/${email.id}/retry`), {
    success: "Email queued again.",
    onSuccess: () => list.reload(),
  });

  return (
    <ListPage
      title="Emails"
      actions={
        <Link className="button" to="/emails/send">
          Send email
        </Link>
      }
      tabs={emailTabs}
      search="Search by recipient or subject"
      filters={[
        { param: "status", label: "Statuses", options: [...emailStatuses] },
        ...(keys.length > 0 ? [{ param: "api_key_id", label: "API keys", options: keys }] : []),
      ]}
      filterExtra={
        <>
          <DateRange />
          <CsvExport rows={list.rows} columns={emailCsv} name="emails" />
        </>
      }
      list={list}
      noun="emails"
      rowHref={(row) => `/emails/${row.id}`}
      empty={<EmptyEmails />}
      columns={[
        {
          header: "To",
          cell: (row) => (
            <span className="cellMain">
              <Tile tone={statusToVariant(row.last_event)}>
                <Mail size={14} />
              </Tile>
              <Link to={`/emails/${row.id}`}>{row.to.join(", ") || "—"}</Link>
            </span>
          ),
        },
        { header: "Status", cell: (row) => <span className="inline"><Badge value={row.last_event} />{row.sandbox ? <Sandbox /> : null}</span> },
        { header: "Subject", cell: (row) => <span className="truncate">{row.subject}</span> },
        { header: "Sent", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          items={[
            { label: "View email", read: true, onSelect: () => navigate(`/emails/${row.id}`) },
            {
              label: "Copy ID",
              read: true,
              onSelect: () => void copyText(row.id).then((ok) => ok && toast.success("ID copied.")),
            },
            { label: "Retry", hidden: !retryable(row), onSelect: () => void retry.mutate(row) },
            ...(cancelable(row)
              ? (["divider", { label: "Cancel send", danger: true, onSelect: () => setCanceling(row) }] as MenuItem[])
              : []),
          ]}
        />
      )}
    >
      {canceling ? (
        <ConfirmPhrase
          title="Cancel email"
          body={`The email to ${canceling.to.join(", ")} will not be sent.`}
          phrase="CANCEL"
          action="Cancel email"
          onConfirm={() => client.post(`/emails/${canceling.id}/cancel`)}
          onClose={() => setCanceling(null)}
          onDone={() => {
            toast.success("Email canceled.");
            void list.reload();
          }}
        />
      ) : null}
    </ListPage>
  );
}

function EmptyEmails() {
  return (
    <Empty
      title="No emails"
      body={
        <>
          Send one with the API, the SDK, or the <Link to="/emails/send">test form</Link>. Clear the filters to see every email.
        </>
      }
    />
  );
}
