import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Webhook } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { Copy } from "../../components/Copy";
import { Empty } from "../../components/Empty";
import { Field } from "../../components/Field";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useClient } from "../../shell/session";
import type { Webhook as WebhookRow } from "../../types";
import { EventPicker } from "./EventPicker";
import "../../styles/operations.css";

export const webhookCsv: Array<CsvColumn<WebhookRow>> = [
  { header: "id", value: (row) => row.id },
  { header: "endpoint", value: (row) => row.endpoint },
  { header: "status", value: (row) => row.status },
  { header: "events", value: (row) => row.events.join(" ") },
  { header: "created_at", value: (row) => row.created_at },
];

/** "email.sent, email.delivered", or "email.sent, email.delivered and 3 more" when the list is long. */
export function eventSummary(events: string[]) {
  return events.length <= 2 ? events.join(", ") : `${events.slice(0, 2).join(", ")} and ${events.length - 2} more`;
}

export function Webhooks() {
  const client = useClient();
  const navigate = useNavigate();
  const list = useList<WebhookRow>("/webhooks");
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<WebhookRow | null>(null);
  const [deleting, setDeleting] = useState<WebhookRow | null>(null);
  const test = useMutation(() => client.post("/webhooks/test"), { success: "Test event sent." });
  const toggle = useMutation(
    (row: WebhookRow) => client.patch<WebhookRow>(`/webhooks/${row.id}`, { status: row.status === "enabled" ? "disabled" : "enabled" }),
    {
      success: (row) => (row.status === "enabled" ? "Webhook enabled." : "Webhook disabled."),
      onSuccess: () => list.reload(),
    },
  );

  return (
    <ListPage
      title="Webhooks"
      actions={
        <>
          {list.rows.length ? <button type="button" className="secondary" disabled={test.isLoading} onClick={() => void test.mutate()}>
            Send test event
          </button> : null}
          <button type="button" onClick={() => setAdding(true)}>
            Add webhook
          </button>
        </>
      }
      filterExtra={<CsvExport rows={list.rows} columns={webhookCsv} name="webhooks" />}
      list={list}
      noun="webhooks"
      rowHref={(row) => `/webhooks/${row.id}`}
      empty={<Empty title="No webhooks" body="Add an endpoint to receive email, contact, and domain events." />}
      columns={[
        {
          header: "Endpoint",
          cell: (row) => (
            <span className="cellMain">
              <Tile tone={statusToVariant(row.status)}>
                <Webhook size={14} />
              </Tile>
              <Link className="mono" to={`/webhooks/${row.id}`}>
                {row.endpoint}
              </Link>
            </span>
          ),
        },
        { header: "Status", cell: (row) => <Badge value={row.status} /> },
        { header: "Events", cell: (row) => <span className="truncate mono">{eventSummary(row.events)}</span> },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          items={[
            { label: "View webhook", read: true, onSelect: () => navigate(`/webhooks/${row.id}`) },
            { label: row.status === "enabled" ? "Disable" : "Enable", onSelect: () => void toggle.mutate(row) },
            "divider",
            { label: "Delete", danger: true, onSelect: () => setDeleting(row) },
          ]}
        />
      )}
    >
      {adding ? (
        <AddWebhook
          onClose={() => setAdding(false)}
          onCreated={(webhook) => {
            setAdding(false);
            setCreated(webhook);
            void list.reload();
          }}
        />
      ) : null}

      {created ? (
        <Modal
          isOpen
          onClose={() => setCreated(null)}
          title="Webhook added"
          actions={
            <>
              <button type="button" className="secondary" onClick={() => navigate(`/webhooks/${created.id}`)}>
                View webhook
              </button>
              <button type="button" onClick={() => setCreated(null)}>
                Done
              </button>
            </>
          }
        >
          <div className="stack">
            <p className="muted">Verify each delivery with this signing secret. You can also reveal it later on the webhook's page.</p>
            {created.signing_secret ? <Copy value={created.signing_secret} chip className="wrap" label="Copy signing secret" /> : null}
          </div>
        </Modal>
      ) : null}

      {deleting ? (
        <ConfirmPhrase
          title="Delete webhook"
          body={`Events will stop going to ${deleting.endpoint}.`}
          phrase="DELETE"
          action="Delete webhook"
          onConfirm={() => client.delete(`/webhooks/${deleting.id}`)}
          onClose={() => setDeleting(null)}
          onDone={() => {
            toast.success("Webhook deleted.");
            void list.reload();
          }}
        />
      ) : null}
    </ListPage>
  );
}

function AddWebhook({ onClose, onCreated }: { onClose: () => void; onCreated: (webhook: WebhookRow) => void }) {
  const client = useClient();
  const [endpoint, setEndpoint] = useState("");
  const [events, setEvents] = useState<string[]>(["email.sent", "email.delivered", "email.bounced"]);
  const { mutate, isLoading } = useMutation(() => client.post<WebhookRow>("/webhooks", { endpoint: endpoint.trim(), events }), {
    success: "Webhook added.",
    onSuccess: onCreated,
  });

  return (
    <Modal
      isOpen
      title="Add webhook"
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitLabel="Add"
      submitDisabled={!endpoint.trim() || events.length === 0}
      submitting={isLoading}
      size="large"
    >
      <div className="form">
        <Field label="Endpoint URL" type="url" value={endpoint} onChange={setEndpoint} placeholder="https://example.com/webhooks" required autoFocus mono />
        <EventPicker value={events} onChange={setEvents} />
      </div>
    </Modal>
  );
}
