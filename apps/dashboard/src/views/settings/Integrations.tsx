import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Badge } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Copy } from "../../components/Copy";
import { Empty, Failed } from "../../components/Empty";
import { Modal } from "../../components/Modal";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { docsBase } from "../../lib/docs";
import { useCan, useClient } from "../../shell/session";
import type { Integration, IntegrationCreated, IntegrationInput, InboundDelivery, List } from "../../types";
import { settingsTabs } from "../tabs";
import { IntegrationFields, integrationDraft, integrationPayload, MappedEvents, providers, validDraft } from "./IntegrationFields";
import "../../styles/settings.css";

type Credentials = { name: string; token: string; url: string; location: string };

function setupGuide(provider: IntegrationInput["provider"]) {
  return `${docsBase()}templates/${provider}.md#receiver-setup`;
}

export function Integrations() {
  const client = useClient();
  const can = useCan();
  const location = useLocation();
  const list = useList<Integration>("/integrations");
  const [adding, setAdding] = useState<IntegrationInput["provider"] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Integration | null>(null);
  const [deleting, setDeleting] = useState<Integration | null>(null);
  const [rotating, setRotating] = useState<Integration | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const current = useRef(location.key);
  current.current = location.key;
  const generation = useRef(0);
  useEffect(() => {
    setCredentials(null);
    setAdding(null);
    setSelected(null);
    setEditing(null);
    setDeleting(null);
    setRotating(null);
    generation.current++;
    return () => { generation.current++; };
  }, [location.key, can, client]);
  const reveal = (result: IntegrationCreated) => {
    setCredentials({ name: result.name, token: result.token, url: result.url, location: current.current });
    void list.reload();
  };

  const empty = !list.loading && !list.error && list.page === 1 && !list.rows.length;

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <Tabs tabs={settingsTabs} />
      {empty ? <Empty
        title="No integrations yet"
        body="Connect Stripe, Clerk, Supabase, or Standard Webhooks to update your contacts and start automations."
        action={<>{can ? <button type="button" onClick={() => { setCredentials(null); setAdding("stripe"); }}>Connect integration</button> : <span className="muted">An administrator can connect an integration.</span>}<a href={setupGuide("stripe")} target="_blank" rel="noreferrer">Stripe setup guide</a></>}
      /> : <>
      <Panel title="Integration setup">
        <div className="integrationGrid">
          {providers.map((provider) => <div key={provider.value} className="integrationCard">
            <h3>{provider.label}</h3>
            <p className="muted">Receive provider events, update contacts, and start automations.</p>
            <div className="toolbar">
              {can ? <button type="button" className="secondary" onClick={() => {
                setCredentials(null);
                setAdding(provider.value);
              }}>Connect {provider.label}</button> : null}
              <a href={setupGuide(provider.value)} target="_blank" rel="noreferrer">{provider.label} setup guide</a>
            </div>
          </div>)}
          <div className="integrationCard">
            <h3>Outgoing webhooks</h3>
            <p className="muted">Deliver Dispatch events to your application.</p>
            <Link to="/webhooks">Outgoing webhooks</Link>
          </div>
          <div className="integrationCard">
            <h3>SMTP</h3>
            <p className="muted">Send email through the relay.</p>
            <Link to="/settings/smtp">SMTP</Link>
          </div>
          <div className="integrationCard">
            <h3>Auth.js</h3>
            <p className="muted">Send verification links from your application.</p>
            <a href={`${docsBase()}templates/authjs.md`} target="_blank" rel="noreferrer">Auth.js recipe</a>
          </div>
          <div className="integrationCard">
            <h3>Better Auth</h3>
            <p className="muted">Send password reset, verification, and one-time codes.</p>
            <a href={`${docsBase()}templates/better-auth.md`} target="_blank" rel="noreferrer">Better Auth recipe</a>
          </div>
        </div>
      </Panel>
      <Panel title="Integrations" actions={can ? <button type="button" onClick={() => { setCredentials(null); setAdding("stripe"); }}>Add integration</button> : null}>
        <div className="stack">
          <p className="muted">Receive provider events to update contacts and start automations. Signing secrets and receiver URLs are never available through inspection.</p>
          {!can ? <p className="note">Read-only access. An administrator can create or change integrations.</p> : null}
          {list.loading ? <Skeleton lines={3} /> : list.error ? <Failed message={list.error} onRetry={list.reload} />
            : !list.rows.length ? <Empty title="No integrations yet" body="Connect Stripe, Clerk, Supabase, or Standard Webhooks to update your contacts and start automations." />
              : <table><thead><tr><th>Name</th><th>Provider</th><th>Last received</th><th>Actions</th></tr></thead><tbody>
                {list.rows.map((row) => <tr key={row.id}>
                  <td>{row.name}</td><td>{providers.find((provider) => provider.value === row.provider)?.label}</td>
                  <td>{row.last_received_at ? <Time value={row.last_received_at} /> : "Never"}</td>
                  <td><div className="toolbar">
                    <button type="button" className="secondary small" aria-label={`View ${row.name}`} onClick={() => { setCredentials(null); setSelected(row.id); }}>View</button>
                    {can ? <>
                      <button type="button" className="secondary small" aria-label={`Edit ${row.name}`} onClick={() => { setCredentials(null); setEditing(row); }}>Edit</button>
                      <button type="button" className="secondary small" aria-label={`Rotate ${row.name}`} onClick={() => { setCredentials(null); setRotating(row); }}>Rotate URL</button>
                      <button type="button" className="danger small" aria-label={`Delete ${row.name}`} onClick={() => { setCredentials(null); setDeleting(row); }}>Delete</button>
                    </> : null}
                  </div></td>
                </tr>)}
              </tbody></table>}
          {list.page > 1 || list.hasMore ? <div className="toolbar">
            <button type="button" className="secondary" disabled={list.loading || list.page === 1} onClick={list.previous}>Previous</button>
            <span>Page {list.page}</span>
            <button type="button" className="secondary" disabled={list.loading || !list.hasMore} onClick={list.next}>Next</button>
          </div> : null}
        </div>
      </Panel>
      </>}
      {can && adding ? <IntegrationForm provider={adding} onClose={() => setAdding(null)} onCreated={(result) => { setAdding(null); reveal(result); }} onSaved={() => void list.reload()} /> : null}
      {can && editing ? <IntegrationForm integration={editing} onClose={() => setEditing(null)} onCreated={reveal}
        onSaved={() => { setEditing(null); void list.reload(); }} /> : null}
      {selected ? <IntegrationDetail id={selected} onClose={() => setSelected(null)} /> : null}
      {can && credentials?.location === location.key ? <Modal isOpen title={`Receiver URL: ${credentials.name}`} onClose={() => setCredentials(null)}
        actions={<button type="button" onClick={() => setCredentials(null)}>Done</button>}>
        <div className="stack">
          <p className="note">Copy these now. The URL and token are shown once and cannot be retrieved later. Treat both as credentials.</p>
          <p>Receiver URL</p><Copy value={credentials.url} chip className="wrap" label="Copy receiver URL" />
          <p>Receiver token</p><Copy value={credentials.token} chip className="wrap" label="Copy receiver token" />
          <p className="muted">Configure the receiver URL in your provider. Rotation invalidates the previous URL; the provider signing secret is unchanged.</p>
        </div>
      </Modal> : null}
      {can && deleting ? <ConfirmPhrase title="Delete integration" body={`Stop receiving events from ${deleting.name}.`} phrase="DELETE" action="Delete integration"
        onClose={() => setDeleting(null)} onConfirm={async () => {
          try { await client.delete(`/integrations/${encodeURIComponent(deleting.id)}`); }
          catch { throw new Error("Integration could not be deleted."); }
        }} onDone={() => { setCredentials(null); void list.reload(); }} /> : null}
      {can && rotating ? <ConfirmPhrase title="Rotate receiver URL" body="The old receiver URL will stop working immediately. Update your provider with the new URL." phrase="ROTATE" action="Rotate URL"
        onClose={() => { generation.current++; setRotating(null); }} onConfirm={async () => {
          const version = generation.current;
          const origin = current.current;
          try {
            const result = await client.post<IntegrationCreated>(`/integrations/${encodeURIComponent(rotating.id)}/rotate`);
            if (version === generation.current && origin === current.current) reveal(result);
          } catch { throw new Error("Receiver URL could not be rotated."); }
        }} /> : null}
    </div>
  );
}

function IntegrationForm({ integration, provider = "stripe", onClose, onCreated, onSaved }: {
  integration?: Integration; provider?: IntegrationInput["provider"]; onClose: () => void; onCreated: (row: IntegrationCreated) => void; onSaved: () => void;
}) {
  const client = useClient();
  const [value, setValue] = useState(() => ({ ...integrationDraft(integration), provider: integration?.provider ?? provider }));
  const [failed, setFailed] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const close = () => { active.current = false; onClose(); };
  // Return no response: useMutation must not retain a second copy of one-time credentials.
  const save = useMutation(async () => {
    try {
      if (integration) {
        await client.patch(`/integrations/${encodeURIComponent(integration.id)}`, integrationPayload(value, true));
        if (active.current) onSaved();
      } else {
        const result = await client.post<IntegrationCreated>("/integrations", integrationPayload(value));
        if (active.current) onCreated(result);
      }
    } catch { throw new Error("Integration could not be saved."); }
  }, { onError: () => { if (active.current) setFailed(true); } });
  return <Modal isOpen title={integration ? "Edit integration" : "Add integration"} onClose={close}
    onSubmit={() => { setFailed(false); void save.mutate(); }} submitLabel={integration ? "Save" : "Create integration"}
    submitDisabled={!validDraft(value, Boolean(integration))} submitting={save.isLoading} size="large">
    {failed ? <p role="alert">Integration could not be saved. Check the configuration and try again.</p> : null}
    <p><a href={setupGuide(value.provider)} target="_blank" rel="noreferrer">Open provider setup guide</a></p>
    <IntegrationFields value={value} onChange={setValue} integration={integration} disabled={save.isLoading} />
  </Modal>;
}

const failureReasons: Record<string, string> = {
  invalid_signature: "Invalid signature", invalid_payload: "Invalid payload", processing_failed: "Processing failed",
  unsupported_event: "Unsupported event", no_contact: "No matching contact",
};

function IntegrationDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const path = `/integrations/${encodeURIComponent(id)}`;
  const resource = useResource<Integration>(path);
  const deliveries = useResource<List<InboundDelivery>>(`${path}/deliveries?limit=20`);
  const row = resource.data;
  return <Modal isOpen title={row?.name ?? "Integration"} onClose={onClose} size="large">
    <div className="stack">
      {resource.loading ? <Skeleton lines={3} /> : resource.error ? <Failed message={resource.error} onRetry={resource.reload} /> : row ? <>
        <p>Provider: {providers.find((provider) => provider.value === row.provider)?.label}</p>
        <p>Namespace: <code>{row.slug}</code></p>
        <p><a href={setupGuide(row.provider)} target="_blank" rel="noreferrer">Open provider setup guide</a></p>
        <p>Last received: {row.last_received_at ? <Time value={row.last_received_at} /> : "Never"}</p>
        {row.provider === "stripe" ? <p>Plan storage: {row.settings.map_plan ? "On" : "Off"}. Restricted customer key: {row.has_restricted_key ? "Configured" : "Not configured"}.</p> : null}
        {row.provider === "clerk" ? <p>On user deletion: {row.settings.delete_contact ? "Delete contact" : "Retain contact and history"}.</p> : null}
        {row.provider === "supabase" ? <p>Secret header: <code>{row.settings.secret_header ?? "x-webhook-secret"}</code></p> : null}
        <MappedEvents provider={row.provider} slug={row.slug} />
      </> : null}
      <h3>Last 20 deliveries</h3>
      <button type="button" className="secondary" disabled={deliveries.loading} onClick={() => void deliveries.reload()}>Refresh deliveries</button>
      {deliveries.loading ? <Skeleton lines={3} /> : deliveries.error ? <Failed message={deliveries.error} onRetry={deliveries.reload} />
        : !deliveries.data?.data.length ? <p className="muted">No deliveries yet. Events received from this integration show up here.</p>
          : <table><thead><tr><th>Received</th><th>Status</th><th>Event</th><th>Contact</th><th>Result</th></tr></thead><tbody>
            {deliveries.data.data.slice(0, 20).map((delivery) => <tr key={delivery.id}>
              <td><Time value={delivery.created_at} /></td><td><Badge value={delivery.status} /></td>
              <td><code>{delivery.event_name}</code></td>
              <td>{delivery.contact_id ? <Link to={`/audience/contacts/${encodeURIComponent(delivery.contact_id)}`} onClick={onClose}>View contact</Link> : "—"}</td>
              <td>{delivery.error ? failureReasons[delivery.error] ?? "Delivery failed" : "—"}</td>
            </tr>)}
          </tbody></table>}
      <p className="muted">Delivery history contains no request bodies, tokens, or signing secrets.</p>
    </div>
  </Modal>;
}
