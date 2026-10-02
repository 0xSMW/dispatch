import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Globe2 } from "lucide-react";
import { Badge, statusToVariant, type BadgeVariant } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Failed } from "../../components/Empty";
import { EventTimeline, type TimelineEvent } from "../../components/EventTimeline";
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
import { Records } from "./Records";
import "../../styles/operations.css";

type Tab = "records" | "configuration";
type Update = Partial<Pick<DomainRow, "open_tracking" | "click_tracking" | "tracking_subdomain" | "tls">> & {
  capabilities?: Partial<DomainRow["capabilities"]>;
};

const failing = ["failed", "temporary_failure", "partially_failed"];

/** The five verification steps, colored by how far the domain has got. */
export function verification(domain: Pick<DomainRow, "status" | "created_at" | "checked_at">): TimelineEvent[] {
  const labels = ["Created", "Checking DNS", "Records validated", "Internal verification", "Verified"];
  const reached: Record<string, number> = { not_started: 1, pending: 2, partially_verified: 4, verified: 5 };
  const failed = failing.includes(domain.status);
  const done = failed ? 1 : (reached[domain.status] ?? 1);
  return labels.map((label, index) => {
    const variant: BadgeVariant = index < done ? "success" : failed && index === 1 ? "danger" : index === done ? "info" : "neutral";
    const time = index === 0 ? domain.created_at : (index === 4 && domain.status === "verified") || (index === 1 && done >= 2) ? domain.checked_at : null;
    return { label, variant, time: time ?? null, status: label };
  });
}

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
  const verify = useMutation(() => client.post(`/domains/${id}/verify`), {
    success: "Verification started.",
    onSuccess: () => domain.reload(),
  });
  const doctor = useMutation(() => client.get<DomainDoctor>(`/domains/${id}/doctor`), {
    onSuccess: (data) => {
      const bad = data.checks.filter((check) => check.status !== "ok").length;
      if (bad === 0) toast.success("Every record checks out.");
      else toast.error(bad === 1 ? "1 record needs a fix." : `${bad} records need a fix.`);
      setTab("records");
    },
  });
  const update = useMutation((changes: Update) => client.patch<DomainRow>(`/domains/${id}`, changes), {
    success: "Domain updated.",
    onSuccess: (data) => domain.setData(data),
  });

  if (domain.error) return <Failed message={domain.error} onRetry={domain.reload} />;
  const restart = row && (row.status === "pending" || failing.includes(row.status));

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
              {can && row.status !== "verified" ? (
                <button type="button" className="secondary" disabled={verify.isLoading} onClick={() => void verify.mutate()}>
                  {restart ? "Restart" : "Verify DNS"}
                </button>
              ) : null}
              <button type="button" className="secondary" disabled={doctor.isLoading} onClick={() => void doctor.mutate()}>
                {doctor.isLoading ? <span className="spinner" aria-hidden /> : null}
                Doctor
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
            { label: "Status", value: <Badge value={row.status} /> },
            { label: "Provider", value: row.dns_provider ?? <span className="dim">Not detected</span> },
            { label: "Region", value: <Region code={row.region} /> },
            { label: "Last checked", value: <Time value={row.checked_at} /> },
            { label: "ID", value: row.id, copy: true },
          ]}
        />
      ) : (
        <Skeleton lines={2} />
      )}

      {row ? (
        <Panel title="Verification">
          <EventTimeline events={verification(row)} />
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
              <p className="muted grow">Click a value to copy it. Run Doctor to check what DNS returns for each record.</p>
              {can ? <Publish domainId={row.id} onDone={() => void domain.reload()} /> : null}
            </div>
            <Records
              records={row.records}
              checks={doctor.data?.checks}
              tracking={row.open_tracking || row.click_tracking}
              receiving={{
                enabled: row.capabilities.receiving === "enabled",
                busy: !can || update.isLoading,
                onChange: (on) => void update.mutate({ capabilities: { receiving: on ? "enabled" : "disabled" } }),
              }}
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
