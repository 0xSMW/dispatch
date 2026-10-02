import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Eye, EyeOff, Webhook as WebhookIcon } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { Code } from "../../components/Code";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Copy } from "../../components/Copy";
import { Empty, Failed } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { Switch } from "../../components/Field";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { List, Webhook as WebhookRow, WebhookAttempt, WebhookEvent, WebhookEventDetail } from "../../types";
import { EventPicker } from "./EventPicker";
import "../../styles/operations.css";

/** Masks all but the `whsec_` prefix and the last four characters. */
export function maskSecret(secret: string) {
  const prefix = secret.startsWith("whsec_") ? "whsec_" : "";
  return `${prefix}${"•".repeat(12)}${secret.slice(-4)}`;
}

export function Webhook() {
  const can = useCan();
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const webhook = useResource<WebhookRow>(`/webhooks/${id}`);
  const deliveries = useList<WebhookEvent>(`/webhooks/${id}/events`, {}, { limit: 20 });
  const [dialog, setDialog] = useState<"events" | "rotate" | "delete" | null>(null);
  const [revealed, setRevealed] = useState(false);
  const selected = params.get("event") ?? deliveries.rows[0]?.id ?? null;

  const toggle = useMutation(
    (enabled: boolean) => client.patch<WebhookRow>(`/webhooks/${id}`, { status: enabled ? "enabled" : "disabled" }),
    {
      success: (row) => (row.status === "enabled" ? "Webhook enabled." : "Webhook disabled."),
      onSuccess: (row) => webhook.setData(row),
    },
  );

  if (webhook.error) return <Failed message={webhook.error} onRetry={webhook.reload} />;
  const row = webhook.data;
  const secret = row?.signing_secret;

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/webhooks", label: "Webhooks" }}
        icon={<WebhookIcon size={20} />}
        tone={row ? statusToVariant(row.status) : "neutral"}
        label="Webhook"
        title={row ? <span className="mono">{row.endpoint}</span> : <Skeleton width="medium" />}
        actions={
          row && can ? (
            <>
              <Switch label={row.status === "enabled" ? "Enabled" : "Disabled"} checked={row.status === "enabled"} disabled={toggle.isLoading} onChange={(on) => void toggle.mutate(on)} />
              <button type="button" className="secondary" onClick={() => setDialog("events")}>
                Edit events
              </button>
              <Menu
                label="Webhook actions"
                items={[
                  { label: "Rotate signing secret", onSelect: () => setDialog("rotate") },
                  "divider",
                  { label: "Delete webhook", danger: true, onSelect: () => setDialog("delete") },
                ]}
              />
            </>
          ) : null
        }
      />

      {row ? (
        <Facts
          items={[
            { label: "Listening for", value: <span className="mono">{row.events.join(", ")}</span> },
            { label: "Status", value: <Badge value={row.status} /> },
            { label: "Created", value: <Time value={row.created_at} mode="absolute" /> },
            {
              // A viewer's copy of the webhook has no signing secret.
              label: "Signing secret",
              hidden: !secret,
              value: secret ? (
                <span className="inline">
                  <Copy value={secret} chip display={revealed ? secret : maskSecret(secret)} label="Copy signing secret" className={revealed ? "wrap" : undefined} />
                  <button
                    type="button"
                    className="ghost icon small"
                    aria-label={revealed ? "Hide signing secret" : "Reveal signing secret"}
                    title={revealed ? "Hide" : "Reveal"}
                    onClick={() => setRevealed(!revealed)}
                  >
                    {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </span>
              ) : null,
            },
            { label: "ID", value: row.id, copy: true },
          ]}
        />
      ) : (
        <Skeleton lines={2} />
      )}

      <div className="deliveries">
        <Panel
          title="Deliveries"
          actions={
            <button type="button" className="secondary small" onClick={() => void deliveries.reload()}>
              Refresh
            </button>
          }
        >
          <Table
            compact
            rows={deliveries.rows}
            loading={deliveries.loading}
            error={deliveries.error}
            onRetry={() => void deliveries.reload()}
            empty={<p className="muted">No deliveries yet. Send a test event from the Webhooks page.</p>}
            onRowClick={(event) => setParams({ event: event.id }, { replace: true })}
            page={deliveries.page}
            hasMore={deliveries.hasMore}
            onNext={deliveries.next}
            onPrevious={deliveries.previous}
            columns={[
              {
                header: "Event",
                cell: (event) => <span className={event.id === selected ? "mono selectedText" : "mono"}>{event.type}</span>,
              },
              { header: "Age", cell: (event) => <Time value={event.created_at} /> },
              { header: "Status", cell: (event) => <Badge value={event.status} /> },
            ]}
          />
        </Panel>
        {selected ? (
          <Delivery key={selected} webhookId={id!} eventId={selected} onReplayed={() => void deliveries.reload()} />
        ) : (
          <Panel title="Delivery">
            <Empty title="No delivery selected" body="Pick a delivery to see its payload and attempts." />
          </Panel>
        )}
      </div>

      {dialog === "events" && row ? <EditEvents webhook={row} onClose={() => setDialog(null)} onSaved={(saved) => webhook.setData(saved)} /> : null}
      {dialog === "rotate" && row ? (
        <Rotate
          webhookId={row.id}
          onClose={() => setDialog(null)}
          onRotated={(rotated) => {
            webhook.setData({ ...row, ...rotated });
            setRevealed(true);
          }}
        />
      ) : null}
      {dialog === "delete" && row ? (
        <ConfirmPhrase
          title="Delete webhook"
          body={`Events will stop going to ${row.endpoint}.`}
          phrase="DELETE"
          action="Delete webhook"
          onConfirm={() => client.delete(`/webhooks/${row.id}`)}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast.success("Webhook deleted.");
            navigate("/webhooks");
          }}
        />
      ) : null}
    </div>
  );
}

function Delivery({ webhookId, eventId, onReplayed }: { webhookId: string; eventId: string; onReplayed: () => void }) {
  const client = useClient();
  const can = useCan();
  const detail = useResource<WebhookEventDetail>(`/webhooks/${webhookId}/events/${eventId}`);
  const attempts = useResource<List<WebhookAttempt>>(`/webhooks/${webhookId}/events/${eventId}/attempts`);
  const replay = useMutation(() => client.post(`/webhooks/${webhookId}/events/${eventId}/replay`), {
    success: "Replay queued.",
    onSuccess: () => {
      onReplayed();
      void detail.reload();
      void attempts.reload();
    },
  });

  const event = detail.data;
  const tries = attempts.data?.data ?? [];
  const last = tries.at(-1);

  return (
    <Panel
      title="Delivery"
      actions={
        can ? (
          <button type="button" className="secondary small" disabled={!event || replay.isLoading} onClick={() => void replay.mutate()}>
            Replay
          </button>
        ) : null
      }
    >
      {detail.error ? (
        <Failed message={detail.error} onRetry={detail.reload} />
      ) : !event ? (
        <Skeleton lines={4} />
      ) : (
        <div className="stack">
          <Facts
            columns={2}
            items={[
              { label: "Event", value: <span className="mono">{event.type}</span> },
              { label: "Status", value: <Badge value={event.status} /> },
              { label: "ID", value: event.id, copy: true },
              { label: "Created", value: <Time value={event.created_at} mode="absolute" /> },
              { label: "HTTP status", value: last?.http_status_code ? <Badge value={last.http_status_code} /> : null },
              { label: "Attempts", value: String(tries.length) },
              { label: "Next retry", value: <Time value={event.next_attempt_at} />, hidden: !event.next_attempt_at },
            ]}
          />
          <section className="stack">
            <h3>Attempts</h3>
            <Table
              compact
              rows={tries}
              loading={attempts.loading}
              error={attempts.error}
              onRetry={attempts.reload}
              empty={<p className="muted">No attempts yet.</p>}
              columns={[
                { header: "Sent", cell: (attempt) => <Time value={attempt.sent_at} mode="absolute" /> },
                { header: "HTTP", cell: (attempt) => (attempt.http_status_code ? <Badge value={attempt.http_status_code} /> : <span className="dim">—</span>) },
                { header: "Response", cell: (attempt) => <span className="mono truncate">{attempt.response ?? ""}</span> },
              ]}
            />
          </section>
          {last?.response ? (
            <section className="stack">
              <h3>Response body</h3>
              <Code value={last.response} language={last.response.trim().startsWith("{") ? "json" : "text"} />
            </section>
          ) : null}
          <section className="stack">
            <h3>Payload</h3>
            <Code value={event.payload} language="json" />
          </section>
        </div>
      )}
    </Panel>
  );
}

function EditEvents({ webhook, onClose, onSaved }: { webhook: WebhookRow; onClose: () => void; onSaved: (webhook: WebhookRow) => void }) {
  const client = useClient();
  const [events, setEvents] = useState(webhook.events);
  const save = useMutation(() => client.patch<WebhookRow>(`/webhooks/${webhook.id}`, { events }), {
    success: "Events updated.",
    onSuccess: (saved) => {
      onSaved(saved);
      onClose();
    },
  });
  return (
    <Modal isOpen title="Edit events" onClose={onClose} onSubmit={() => void save.mutate()} submitDisabled={events.length === 0} submitting={save.isLoading} size="large">
      <EventPicker value={events} onChange={setEvents} />
    </Modal>
  );
}

function Rotate({ webhookId, onClose, onRotated }: { webhookId: string; onClose: () => void; onRotated: (webhook: WebhookRow) => void }) {
  const client = useClient();
  const rotate = useMutation(() => client.post<WebhookRow>(`/webhooks/${webhookId}/signing-secret/rotate`), {
    success: "Signing secret rotated.",
    onSuccess: (rotated) => {
      onRotated(rotated);
      onClose();
    },
  });
  return (
    <Modal isOpen title="Rotate signing secret" onClose={onClose} onSubmit={() => void rotate.mutate()} submitLabel="Rotate" submitting={rotate.isLoading} size="small">
      <p className="muted">Dispatch signs with both the old and the new secret for 24 hours. Update your endpoint to the new secret before then.</p>
    </Modal>
  );
}
