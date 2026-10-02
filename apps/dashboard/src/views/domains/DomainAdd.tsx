import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Lightbulb } from "lucide-react";
import { Empty, Failed } from "../../components/Empty";
import { Field, Select } from "../../components/Field";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { domainRegions } from "../../lib/events";
import { useCan, useClient } from "../../shell/session";
import type { Domain } from "../../types";
import { regionCities } from "./Domains";
import { Publish } from "./Publish";
import { Records } from "./Records";
import "../../styles/operations.css";

/**
 * Add a domain in two steps: name, region, and return path, then the DNS records to
 * publish. Step two keeps the new domain's id in `?domain=` so a reload stays on it.
 */
export function DomainAdd() {
  const [params, setParams] = useSearchParams();
  const id = params.get("domain");
  const can = useCan();

  return (
    <div className="page narrow">
      <PageHeader back={{ to: "/domains", label: "Domains" }} title="Add domain" />
      <ol className="stepper" aria-label="Steps">
        <li className={id ? "done" : "current"}>Domain</li>
        <li className={id ? "current" : undefined}>DNS records</li>
      </ol>
      {!can ? (
        <Empty title="Read access" body="Your role can read domains but not add them. Ask an admin for full access." />
      ) : id ? (
        <DnsStep id={id} />
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
          <details className="advanced">
            <summary>Advanced</summary>
            <Field
              label="Custom return path"
              value={returnPath}
              onChange={setReturnPath}
              mono
              hint={`Bounces go to ${returnPath.trim() || "send"}.${name.trim() || "example.com"}. Set at creation only.`}
            />
          </details>
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

function DnsStep({ id }: { id: string }) {
  const client = useClient();
  const domain = useResource<Domain>(`/domains/${id}`);
  const verify = useMutation(() => client.post(`/domains/${id}/verify`), {
    success: "Verification started.",
    onSuccess: () => domain.reload(),
  });

  if (domain.error) return <Failed message={domain.error} onRetry={domain.reload} />;
  const row = domain.data;

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
        {row ? <Records records={row.records} tracking={row.open_tracking || row.click_tracking} /> : <Skeleton lines={4} />}
      </Panel>
      <div className="toolbar">
        <button type="button" disabled={!row || verify.isLoading} onClick={() => void verify.mutate()}>
          Verify DNS records
        </button>
        <Link className="button secondary" to={`/domains/${id}`}>
          Go to domain
        </Link>
      </div>
    </>
  );
}
