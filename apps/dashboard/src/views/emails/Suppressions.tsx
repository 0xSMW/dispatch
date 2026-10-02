import { useRef, useState } from "react";
import { Ban, Upload } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { DateRange, useDateRange } from "../../components/DateRange";
import { Empty } from "../../components/Empty";
import { Field, TextArea } from "../../components/Field";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useFilters } from "../../hooks/useFilters";
import { useBulkKeys } from "../../hooks/useBulkKeys";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useSelection } from "../../hooks/useSelection";
import { addresses } from "../../lib/utils";
import { useClient } from "../../shell/session";
import type { Suppression } from "../../types";
import { emailTabs } from "../tabs";
import "../../styles/operations.css";

/** Origin colors: manual gray, complaint amber, bounce red. */
const origins: Record<string, "neutral" | "warning" | "danger"> = { manual: "neutral", complaint: "warning", bounce: "danger" };

const suppressionCsv: Array<CsvColumn<Suppression>> = [
  { header: "email", value: (row) => row.email },
  { header: "origin", value: (row) => row.origin },
  { header: "reason", value: (row) => row.reason },
  { header: "created_at", value: (row) => row.created_at },
];

/** Every address in a pasted list or a CSV file, once each, in order. */
export function emailsIn(text: string): string[] {
  const found = text.match(/[^\s,;"'<>]+@[^\s,;"'<>]+\.[^\s,;"'<>]+/g) ?? [];
  return [...new Set(found.map((email) => email.toLowerCase()))];
}

/** The API takes 100 addresses per batch call. */
export function chunks<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export function Suppressions() {
  const client = useClient();
  const filters = useFilters(["q", "origin"]);
  const range = useDateRange();
  const list = useList<Suppression>("/suppressions", { ...filters, from: range.start, to: range.end });
  const selection = useSelection(list.rows.map((row) => row.id));
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Suppression | null>(null);
  const [removingMany, setRemovingMany] = useState(false);

  useBulkKeys(selection, list.rows.length, () => setRemovingMany(true));

  return (
    <ListPage
      title="Emails"
      tabs={emailTabs}
      actions={
        <button type="button" onClick={() => setAdding(true)}>
          Add email addresses
        </button>
      }
      filters={[{ param: "origin", label: "Origins", options: ["manual", "bounce", "complaint"] }]}
      search="Search by email"
      filterExtra={
        <>
          <DateRange />
          <CsvExport rows={list.rows} columns={suppressionCsv} name="suppressions" />
        </>
      }
      list={list}
      noun="suppressions"
      selection={selection}
      bulkActions={[{ label: "Remove", hint: "⌫", danger: true, onClick: () => setRemovingMany(true) }]}
      empty={<Empty title="No suppressions" body="Bounced and complained addresses, and ones you add, show here." />}
      columns={[
        {
          header: "Email",
          cell: (row) => (
            <span className="cellMain">
              <Tile tone={origins[row.origin] ?? statusToVariant(row.origin)}>
                <Ban size={14} />
              </Tile>
              {row.email}
            </span>
          ),
        },
        { header: "Origin", cell: (row) => <Badge value={row.origin} variant={origins[row.origin]} /> },
        { header: "Reason", cell: (row) => <span className="truncate">{row.reason}</span> },
        { header: "Added", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => <Menu items={[{ label: "Remove", danger: true, onSelect: () => setRemoving(row) }]} />}
    >
      {adding ? <AddSuppressions onClose={() => setAdding(false)} onDone={list.reload} /> : null}
      {removing ? (
        <ConfirmPhrase
          title="Remove from suppression list"
          body={`Dispatch will send to ${removing.email} again.`}
          phrase={removing.email}
          action="Remove address"
          onConfirm={() => client.delete(`/suppressions/${removing.id}`)}
          onClose={() => setRemoving(null)}
          onDone={() => {
            toast.success("Address removed.");
            void list.reload();
          }}
        />
      ) : null}
      {removingMany ? (
        <ConfirmPhrase
          title="Remove from suppression list"
          body={`Dispatch will send to ${selection.count} ${selection.count === 1 ? "address" : "addresses"} again.`}
          phrase={`REMOVE ${selection.count}`}
          action="Remove addresses"
          onConfirm={() => client.post("/suppressions/batch/remove", { ids: selection.ids })}
          onClose={() => setRemovingMany(false)}
          onDone={() => {
            toast.success(`${selection.count} ${selection.count === 1 ? "address" : "addresses"} removed.`);
            selection.clear();
            void list.reload();
          }}
        />
      ) : null}
    </ListPage>
  );
}

function AddSuppressions({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const file = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const emails = emailsIn(addresses(text).join("\n"));
  const { mutate, isLoading } = useMutation(
    async () => {
      if (emails.length === 1) {
        await client.post("/suppressions", { email: emails[0], ...(reason.trim() ? { reason: reason.trim() } : {}) });
        return 1;
      }
      for (const batch of chunks(emails)) await client.post("/suppressions/batch/add", { emails: batch });
      return emails.length;
    },
    {
      success: (count) => (count === 1 ? "Address suppressed." : `${count} addresses suppressed.`),
      onSuccess: () => {
        onDone();
        onClose();
      },
    },
  );

  async function load(input: HTMLInputElement) {
    const picked = input.files?.[0];
    if (!picked) return;
    const found = emailsIn(await picked.text());
    input.value = "";
    if (found.length === 0) {
      toast.error("No email addresses found in that file.");
      return;
    }
    setText((current) => [current.trim(), ...found].filter(Boolean).join("\n"));
  }

  return (
    <Modal
      isOpen
      title="Add email addresses"
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitLabel={emails.length > 1 ? `Add ${emails.length}` : "Add"}
      submitDisabled={emails.length === 0}
      submitting={isLoading}
    >
      <div className="form">
        <TextArea
          label="Addresses"
          value={text}
          onChange={setText}
          placeholder={"blocked@example.com\nother@example.com"}
          hint="Separate addresses with commas or line breaks."
          autoFocus
        />
        <div className="inline">
          <button type="button" className="secondary small" onClick={() => file.current?.click()}>
            <Upload size={14} /> Import CSV
          </button>
          <span className="fieldHint">Every address in the file is added to the list above.</span>
          <input ref={file} type="file" accept=".csv,text/csv,text/plain" aria-label="CSV file" hidden onChange={(event) => void load(event.target)} />
        </div>
        {emails.length <= 1 ? <Field label="Reason" value={reason} onChange={setReason} placeholder="manual" /> : null}
      </div>
    </Modal>
  );
}
