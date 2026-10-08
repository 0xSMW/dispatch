import { useState } from "react";
import { Link } from "react-router-dom";
import { Inbox } from "lucide-react";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { DateRange, useDateRange } from "../../components/DateRange";
import { Empty } from "../../components/Empty";
import { Field, TextArea } from "../../components/Field";
import { ListPage } from "../../components/ListPage";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { useFilters } from "../../hooks/useFilters";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { inboundBody } from "../../lib/utils";
import { useClient } from "../../shell/session";
import type { ReceivedEmail } from "../../types";
import { emailTabs } from "../tabs";

export const receivedCsv: Array<CsvColumn<ReceivedEmail>> = [
  { header: "id", value: (row) => row.id },
  { header: "from", value: (row) => row.from },
  { header: "to", value: (row) => row.to.join(" ") },
  { header: "subject", value: (row) => row.subject },
  { header: "created_at", value: (row) => row.created_at },
];

const blank = { from: "", to: "", cc: "", bcc: "", subject: "", text: "", html: "", headers: "" };

export function Received() {
  const filters = useFilters(["q"]);
  const range = useDateRange();
  const list = useList<ReceivedEmail>("/emails/receiving", { ...filters, from: range.start, to: range.end });
  const [open, setOpen] = useState(false);

  return (
    <ListPage
      title="Emails"
      tabs={emailTabs}
      actions={
        <button type="button" onClick={() => setOpen(true)}>
          Simulate inbound
        </button>
      }
      search="Search by sender or subject"
      filterExtra={
        <>
          <DateRange />
          <CsvExport rows={list.rows} columns={receivedCsv} name="received-emails" />
        </>
      }
      list={list}
      noun="emails"
      rowHref={(row) => `/emails/receiving/${row.id}`}
      empty={<Empty title="No received emails yet" body="Incoming emails and simulated messages show up here." />}
      columns={[
        {
          header: "From",
          cell: (row) => (
            <span className="cellMain">
              <Tile tone="info">
                <Inbox size={14} />
              </Tile>
              <Link to={`/emails/receiving/${row.id}`}>{row.from}</Link>
            </span>
          ),
        },
        { header: "To", cell: (row) => <span className="truncate">{row.to?.join(", ")}</span> },
        { header: "Subject", cell: (row) => <span className="truncate">{row.subject}</span> },
        { header: "Received", cell: (row) => <Time value={row.created_at} /> },
      ]}
    >
      {open ? <Simulate onClose={() => setOpen(false)} onDone={list.reload} /> : null}
    </ListPage>
  );
}

function Simulate({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [form, setForm] = useState(blank);
  const set = (key: keyof typeof blank) => (value: string) => setForm({ ...form, [key]: value });
  const { mutate, isLoading } = useMutation(() => client.post("/emails/receiving/simulate", inboundBody(form)), {
    success: "Inbound email simulated.",
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Modal isOpen title="Simulate inbound email" onClose={onClose} onSubmit={() => void mutate()} submitLabel="Simulate" submitting={isLoading} size="large">
      <div className="form two">
        <Field label="From" type="email" value={form.from} onChange={set("from")} placeholder="sender@example.net" required autoFocus />
        <Field label="To" value={form.to} onChange={set("to")} placeholder="inbound@yourdomain.com" required hint="Separate addresses with commas." />
        <Field label="CC" value={form.cc} onChange={set("cc")} />
        <Field label="BCC" value={form.bcc} onChange={set("bcc")} />
        <Field label="Subject" value={form.subject} onChange={set("subject")} required wide />
        <TextArea label="Text" value={form.text} onChange={set("text")} wide />
        <TextArea label="HTML" value={form.html} onChange={set("html")} mono wide />
        <TextArea label="Headers JSON" value={form.headers} onChange={set("headers")} placeholder="{}" mono rows={3} wide />
      </div>
    </Modal>
  );
}
