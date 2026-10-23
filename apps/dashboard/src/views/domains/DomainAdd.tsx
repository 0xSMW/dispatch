import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Lightbulb } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Empty, Failed } from "../../components/Empty";
import { Field, Select } from "../../components/Field";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { domainRegions } from "../../lib/events";
import { useCan, useClient } from "../../shell/session";
import type { Domain, DomainDoctor } from "../../types";
import { regionCities } from "./Domains";
import { Publish } from "./Publish";
import { CheckSummary, Records } from "./Records";
import { verificationState, verifyLabel } from "./verification";
import "../../styles/operations.css";

/**
 * Add a domain: name, region, and return path, then the DNS records to publish and verify,
 * then a finished step that links to the first send. The new domain's id stays in `?domain=`
 * so a reload stays on it.
 */
export function DomainAdd() {
  const [params, setParams] = useSearchParams();
  const id = params.get("domain");
  const can = useCan();
  const [status, setStatus] = useState<string | null>(null);
  const verified = Boolean(id) && status === "verified";

  return (
    <div className="page narrow">
      <PageHeader back={{ to: "/domains", label: "Domains" }} title="Add domain" />
      <ol className="stepper" aria-label="Steps">
        <li className={id ? "done" : "current"}>Domain</li>
        <li className={verified ? "done" : id ? "current" : undefined}>DNS records</li>
        <li className={verified ? "done" : undefined}>Verified</li>
      </ol>
      {!can ? (
        <Empty title="View-only access" body="You can view domains but not add them. Ask an admin for access." />
      ) : id ? (
        <DnsStep id={id} onStatus={setStatus} />
      ) : (
        <NameStep onAdded={(domain) => setParams({ domain: domain.id })} />
      )}
    </div>
  );
}

function NameStep({ onAdded }: { onAdded: (domain: Domain) => void }) {
  const client = useClient();
  const [name, setName] = useState("");
  const [region, setRegion] = useState<string>(domainRegions[0]);
  const [returnPath, setReturnPath] = useState("send");
  const add = useMutation(
    () => client.post<Domain>("/domains", { name: name.trim(), region, custom_return_path: returnPath.trim() || "send" }),
    { success: "Domain added.", onSuccess: onAdded },
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    void add.mutate();
  }

  return (
    <>
      <Panel>
        <form className="form" onSubmit={submit}>
          <Field label="Name" value={name} onChange={setName} placeholder="updates.example.com" required autoFocus mono />
          <Select
            label="Region"
            value={region}
            onChange={setRegion}
            options={domainRegions.map((code) => ({ value: code, label: `${regionCities[code] ?? code} (${code})` }))}
            hint="The SES region that sends this domain's mail. It cannot change later."
          />
          <section className="stack">
            <h2>Advanced</h2>
            <Field
              label="Custom return path"
              value={returnPath}
              onChange={setReturnPath}
              mono
              hint={`Bounces go to ${returnPath.trim() || "send"}.${name.trim() || "example.com"}. Set at creation only.`}
            />
          </section>
          <div className="toolbar">
            <button type="submit" disabled={add.isLoading || !name.trim()}>
              {add.isLoading ? <span className="spinner" aria-hidden /> : null}
              Add domain
            </button>
          </div>
        </form>
      </Panel>
      <aside className="tip">
        <Lightbulb size={16} aria-hidden />
        <p>
          Use a subdomain such as <span className="mono">updates.example.com</span>. It keeps your root domain's reputation apart from
          your sending, and separates kinds of mail.
        </p>
      </aside>
    </>
  );
}

function DnsStep({ id, onStatus }: { id: string; onStatus: (status: string) => void }) {
  const client = useClient();
  const domain = useResource<Domain>(`/domains/${id}`);
  const status = domain.data?.status;
  useEffect(() => {
    if (status) onStatus(status);
  }, [status, onStatus]);
  // Verifying (POST) asks SES to verify. Checking DNS (GET) only reads what DNS returns now.
  const verify = useMutation(() => client.post(`/domains/${id}/verify`), {
    success: "Verification started.",
    onSuccess: () => domain.reload(),
  });
  const doctor = useMutation(() => client.get<DomainDoctor>(`/domains/${id}/doctor`));

  if (domain.error) return <Failed message={domain.error} onRetry={domain.reload} />;
  const row = domain.data;
  const state = row ? verificationState(row) : null;

  if (row && state && row.status === "verified") {
    return (
      <Panel title="Domain verified">
        <div className="verificationState">
          <p>
            <strong>{state.summary}</strong> {state.next}
          </p>
          {state.ready ? (
            <p className="muted">Next, send your first email through the API. The guide gives you a command with this domain as the sender.</p>
          ) : null}
          <div className="toolbar">
            {state.ready ? (
              <Link className="button" to={`/setup/send?domain=${row.id}`}>
                Send your first email
              </Link>
            ) : null}
            <Link className={state.ready ? "button secondary" : "button"} to={`/domains/${id}`}>
              Go to domain
            </Link>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title={row ? `DNS records for ${row.name}` : "DNS records"}
        actions={row ? <Publish domainId={row.id} onDone={() => void domain.reload()} /> : null}
      >
        <p className="muted">
          Add these records at your DNS provider, or publish them to a Route 53 hosted zone. Then verify. DNS changes can take a few
          minutes to an hour to show up.
        </p>
        {row && doctor.data ? <CheckSummary records={row.records} checks={doctor.data.checks} /> : null}
        {row ? <Records records={row.records} checks={doctor.data?.checks} tracking={row.open_tracking || row.click_tracking} /> : <Skeleton lines={4} />}
      </Panel>
      {row && state && row.status !== "not_started" ? (
        <div className="verificationState" role="status">
          <p className="inline">
            <Badge value={row.status} variant={state.tone} />
            <strong>{state.summary}</strong>
          </p>
          <p className="muted">{state.next}</p>
        </div>
      ) : null}
      <div className="toolbar">
        <button type="button" disabled={!row || verify.isLoading} onClick={() => void verify.mutate()}>
          {row && row.status !== "not_started" ? verifyLabel(row.status) : "Verify DNS records"}
        </button>
        <button type="button" className="secondary" disabled={!row || doctor.isLoading} onClick={() => void doctor.mutate()}>
          {doctor.isLoading ? <span className="spinner" aria-hidden /> : null}
          Check DNS
        </button>
        {row && row.status !== "not_started" ? (
          <button type="button" className="secondary" disabled={domain.loading} onClick={() => void domain.reload()}>
            Refresh status
          </button>
        ) : null}
        <Link className="button secondary" to={`/domains/${id}`}>
          Go to domain
        </Link>
      </div>
    </>
  );
}
