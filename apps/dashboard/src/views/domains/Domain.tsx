import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Globe2 } from "lucide-react";
import { Badge, statusToVariant } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { saveFile } from "../../components/CsvExport";
import { Failed } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { Field, Select, Switch } from "../../components/Field";
import { Menu } from "../../components/Menu";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { Domain as DomainRow, DomainDoctor } from "../../types";
import { Region } from "./Domains";
import { Publish } from "./Publish";
import { CheckSummary, Records } from "./Records";
import { verificationState, verifyLabel } from "./verification";
import { toZone } from "./zone";
import "../../styles/operations.css";

type Tab = "records" | "configuration";
type Update = Partial<Pick<DomainRow, "open_tracking" | "click_tracking" | "tracking_subdomain" | "tls">> & {
  capabilities?: Partial<DomainRow["capabilities"]>;
};

export function Domain() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const navigate = useNavigate();
  const domain = useResource<DomainRow>(`/domains/${id}`);
  const [tab, setTab] = useState<Tab | null>(null);
  const [deleting, setDeleting] = useState(false);
  const row = domain.data;

  // A pending domain opens on Records and a verified one on Configuration.
  const current: Tab = tab ?? (row?.status === "verified" ? "configuration" : "records");

  const can = useCan();
  // Verifying (POST) asks SES to verify again. Checking DNS (GET) only reads what DNS returns now.
  const verify = useMutation(() => client.post(`/domains/${id}/verify`), {
    success: "Verification started.",
    onSuccess: () => domain.reload(),
  });
  const doctor = useMutation(() => client.get<DomainDoctor>(`/domains/${id}/doctor`), {
    onSuccess: () => setTab("records"),
  });
  const update = useMutation((changes: Update) => client.patch<DomainRow>(`/domains/${id}`, changes), {
    success: "Domain updated.",
    onSuccess: (data) => domain.setData(data),
  });

  if (domain.error) return <Failed message={domain.error} onRetry={domain.reload} />;
  const state = row ? verificationState(row) : null;

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/domains", label: "Domains" }}
        icon={<Globe2 size={20} />}
        tone={row ? statusToVariant(row.status) : "neutral"}
        label="Domain"
        title={row ? row.name : <Skeleton width="medium" />}
        actions={
          row ? (
            <>
              <button type="button" className="secondary" onClick={() => saveFile(`${row.name}.zone`, toZone(row), "text/plain;charset=utf-8")}>
                Download zone file
              </button>
              {can && row.status !== "verified" ? (
                <button type="button" className="secondary" disabled={verify.isLoading} onClick={() => void verify.mutate()}>
                  {verifyLabel(row.status)}
                </button>
              ) : null}
              <button type="button" className="secondary" disabled={doctor.isLoading} onClick={() => void doctor.mutate()}>
                {doctor.isLoading ? <span className="spinner" aria-hidden /> : null}
                Check DNS
              </button>
              {can ? <Menu label="Domain actions" items={[{ label: "Delete domain", danger: true, onSelect: () => setDeleting(true) }]} /> : null}
            </>
          ) : null
        }
      />

      {row ? (
        <Facts
          items={[
            { label: "Created", value: <Time value={row.created_at} mode="absolute" /> },
            { label: "Provider", value: row.dns_provider ?? <span className="dim">Not detected</span> },
            { label: "Region", value: <Region code={row.region} /> },
            { label: "ID", value: row.id, copy: true },
          ]}
        />
      ) : (
        <Skeleton lines={2} />
      )}

      {row && state ? (
        <Panel title="Verification">
          <div className="verificationState">
            <p className="inline">
              <Badge value={row.status} variant={state.tone} />
              <strong>{state.summary}</strong>
            </p>
            <p className="muted">{state.next}</p>
            <p className="muted">{row.checked_at ? <>Last checked <Time value={row.checked_at} mode="absolute" />.</> : "Not checked yet."}</p>
            {state.ready ? (
              <p>
                <Link to={`/setup/send?domain=${row.id}`}>Next: send your first email</Link>
              </p>
            ) : row.status === "verified" ? (
              <div className="toolbar">
                <button type="button" className="secondary small" onClick={() => setTab("configuration")}>
                  Open configuration
                </button>
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel>
        <Tabs<Tab>
          label="Domain sections"
          tabs={[
            { id: "records", label: "Records" },
            { id: "configuration", label: "Configuration" },
          ]}
          value={current}
          onChange={setTab}
        />
        {!row ? (
          <Skeleton lines={4} />
        ) : current === "records" ? (
          <div className="stack">
            <div className="toolbar">
              <p className="muted grow">Click a value to copy it. Check DNS to see what DNS returns for each record.</p>
              {can ? <Publish domainId={row.id} onDone={() => void domain.reload()} /> : null}
            </div>
            {doctor.data ? <CheckSummary records={row.records} checks={doctor.data.checks} /> : null}
            <Records
              records={row.records}
              checks={doctor.data?.checks}
              tracking={row.open_tracking || row.click_tracking}
              receiving={{ enabled: row.capabilities.receiving === "enabled", onConfigure: () => setTab("configuration") }}
            />
          </div>
        ) : (
          <Configuration domain={row} busy={!can || update.isLoading} onChange={(changes) => void update.mutate(changes)} />
        )}
      </Panel>

      {deleting && row ? (
        <ConfirmPhrase
          title="Delete domain"
          body={`Emails can no longer be sent from ${row.name}.`}
          phrase={row.name}
          action="Delete domain"
          onConfirm={() => client.delete(`/domains/${row.id}`)}
          onClose={() => setDeleting(false)}
          onDone={() => {
            toast.success("Domain deleted.");
            navigate("/domains");
          }}
        />
      ) : null}
    </div>
  );
}

function Configuration({ domain, busy, onChange }: { domain: DomainRow; busy: boolean; onChange: (changes: Update) => void }) {
  const [subdomain, setSubdomain] = useState(domain.tracking_subdomain);
  const tracking = domain.open_tracking || domain.click_tracking;

  return (
    <div className="config">
      <section className="stack">
        <h3>Tracking</h3>
        <Switch
          label="Click tracking"
          hint="Rewrites links to count clicks."
          checked={domain.click_tracking}
          disabled={busy}
          onChange={(on) => onChange({ click_tracking: on })}
        />
        <Switch
          label="Open tracking"
          hint="Adds a 1 pixel image to count opens."
          checked={domain.open_tracking}
          disabled={busy}
          onChange={(on) => onChange({ open_tracking: on })}
        />
        <form
          className="inlineForm"
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ tracking_subdomain: subdomain.trim() });
          }}
        >
          <Field
            label="Tracking subdomain"
            value={subdomain}
            onChange={setSubdomain}
            disabled={busy}
            mono
            hint={tracking ? `Links go through ${subdomain || "links"}.${domain.name} once its record verifies.` : "Used when tracking is on."}
          />
          <button type="submit" className="secondary" disabled={busy || !subdomain.trim() || subdomain.trim() === domain.tracking_subdomain}>
            Save
          </button>
        </form>
      </section>
      <section className="stack">
        <h3>Transport</h3>
        <Select
          label="TLS"
          value={domain.tls}
          onChange={(value) => onChange({ tls: value as DomainRow["tls"] })}
          disabled={busy}
          options={[
            { value: "opportunistic", label: "Opportunistic" },
            { value: "enforced", label: "Enforced" },
          ]}
          hint="Enforced refuses to deliver to servers that do not offer TLS."
        />
      </section>
      <section className="stack">
        <h3>Capabilities</h3>
        <Switch
          label="Sending"
          checked={domain.capabilities.sending === "enabled"}
          disabled={busy}
          onChange={(on) => onChange({ capabilities: { sending: on ? "enabled" : "disabled" } })}
        />
        <Switch
          label="Receiving"
          hint="Adds an MX record so this domain can take inbound mail."
          checked={domain.capabilities.receiving === "enabled"}
          disabled={busy}
          onChange={(on) => onChange({ capabilities: { receiving: on ? "enabled" : "disabled" } })}
        />
      </section>
    </div>
  );
}
