import { useState } from "react";
import { Link } from "react-router-dom";
import { Drawer } from "../../components/Drawer";
import { Empty, Failed } from "../../components/Empty";
import { Field, Select } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Skeleton } from "../../components/Skeleton";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { AutomationInstallation, AutomationPreset, Domain, List, Topic } from "../../types";
import { Canvas } from "./Canvas";
import { toTree } from "./graph";

export const stages = [
  { value: "acquisition", label: "Acquisition" },
  { value: "onboarding", label: "Onboarding" },
  { value: "retention", label: "Retention" },
  { value: "reengagement", label: "Re-engagement" },
  { value: "dunning", label: "Dunning" },
  { value: "reactivation", label: "Reactivation" },
] as const;

/** The existing tree adapter handles shared terminal exits without changing stored identities. */
export function presetTree(preset: AutomationPreset) {
  return toTree(preset.steps, preset.connections);
}

/** Slug-based, fixed list: never feed presets to ID-cursor pagination. */
export function Presets({ stage = "", onBlank }: { stage?: string; onBlank?: () => void }) {
  const presets = useResource<List<AutomationPreset>>("/template-library/automations");
  const can = useCan();
  const [open, setOpen] = useState<AutomationPreset | null>(null);
  return (
    <section className="stack" aria-label="Lifecycle automations">
      <h2 className="categoryTitle">Start with a lifecycle stage</h2>
      {can && onBlank ? <button className="secondary" type="button" onClick={onBlank}>Start blank</button> : null}
      {presets.error ? <Failed message={presets.error} onRetry={() => void presets.reload()} /> :
        presets.loading && !presets.data ? <Skeleton lines={6} /> :
        !presets.data?.data.length ? <Empty title="No automation presets" body="Start blank or add the lifecycle library to this install." /> :
        <div className="cardGrid">
          {stages.filter((item) => !stage || item.value === stage).map((item) => (
            <section className="card" key={item.value} aria-label={item.label}>
              <div className="cardBody">
                <h3>{item.label}</h3>
                {presets.data!.data.filter((preset) => preset.stage === item.value).map((preset) => (
                  <div className="stack" key={preset.slug}>
                    <button className="cardLink" type="button" onClick={() => setOpen(preset)}>{preset.name}</button>
                    <p className="cardText">{preset.description}</p>
                    <p className="cardText"><strong>When:</strong> {preset.when}</p>
                    <button className="secondary" type="button" onClick={() => setOpen(preset)}>{can ? "Install as automation" : "Preview automation"}</button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>}
      {open ? <PresetPreview preset={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function PresetPreview({ preset, onClose }: { preset: AutomationPreset; onClose: () => void }) {
  const can = useCan();
  const detail = useResource<AutomationPreset>(`/template-library/automations/${encodeURIComponent(preset.slug)}`);
  const [installing, setInstalling] = useState(false);
  const graph = detail.data ? presetTree(detail.data) : null;
  if (can && installing) return <InstallPreset preset={preset} onClose={onClose} />;
  return (
    <>
      <Drawer isOpen width="wide" label="Automation preset" title={preset.name} onClose={onClose}
        actions={can ? <button type="button" disabled={!detail.data || Boolean(detail.error) || Boolean(graph?.problem)} onClick={() => setInstalling(true)}>Install as automation</button> : null}>
        <div className="stack">
          <p>{preset.description}</p>
          <p><strong>When:</strong> {preset.when}</p>
          <p className="muted">Installs disabled. Review the automation and its emails before enabling.</p>
          {detail.error ? <Failed message={detail.error} onRetry={() => void detail.reload()} /> :
            graph?.problem ? <p role="alert">{graph.problem}</p> :
            graph ? <Canvas tree={graph.tree} disabled stacked /> : <Skeleton lines={6} />}
        </div>
      </Drawer>
    </>
  );
}

/** Client guidance only; the server revalidates the live sender domain at installation. */
export function verifiedSenders(domains: Domain[]) {
  return domains.filter((domain) => domain.status === "verified" && domain.capabilities.sending === "enabled");
}

export function senderMatches(from: string, domain: string) {
  if (!from.trim() || from.length > 998 || /[\r\n]/.test(from)) return false;
  const address = from.trim().match(/^(?:[^<>]+<([^<>]+)>|([^<>\s]+))$/);
  const email = (address?.[1] ?? address?.[2] ?? "").trim();
  const parts = email.split("@");
  return parts.length === 2 && Boolean(parts[0]) && !/\s/.test(email) && parts[1]!.toLowerCase() === domain.toLowerCase();
}

function InstallPreset({ preset, onClose }: { preset: AutomationPreset; onClose: () => void }) {
  const client = useClient();
  const can = useCan();
  const domains = useList<Domain>("/domains", {}, { all: true });
  const topics = useList<Topic>("/topics", {}, { all: true });
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [from, setFrom] = useState("");
  const [topic, setTopic] = useState("");
  const senders = verifiedSenders(domains.rows);
  const newsletter = preset.slug === "newsletter-welcome";
  const valid = can && !domains.loading && !domains.error && senders.some((row) => row.name === domain)
    && senderMatches(from, domain) && (!topic || (!topics.loading && !topics.error && topics.rows.some((row) => row.id === topic)))
    && (!newsletter || Boolean(topic));
  const install = useMutation(() => client.post<AutomationInstallation>(
    `/template-library/automations/${encodeURIComponent(preset.slug)}/install`,
    { ...(name.trim() ? { name: name.trim() } : {}), from: from.trim(), ...(topic ? { topic_id: topic } : {}) },
  ), { onError: () => undefined });
  return (
    <Modal isOpen title={`Install ${preset.name}`} onClose={onClose}
      onSubmit={install.data ? undefined : () => { if (valid && !install.isLoading) void install.mutate(); }}
      submitLabel="Install disabled" submitDisabled={!valid} submitting={install.isLoading}>
      {install.data ? <div className="stack">
        <p role="status">Installed disabled: {install.data.automation.name}</p>
        <ol>{install.data.next_steps.map((step) => <li key={step}>{step}</li>)}</ol>
        <Link className="button" to={`/automations/${install.data.automation.id}/editor`}>Review automation</Link>
      </div> : <div className="form">
        <Field label="Name" value={name} onChange={setName} placeholder={preset.name} />
        <Select label="Verified sender domain" value={domain} onChange={setDomain} placeholder="Choose a domain"
          options={senders.map((row) => ({ value: row.name, label: row.name }))} required />
        <Field label="From" value={from} onChange={setFrom} placeholder={domain ? `Your team <hello@${domain}>` : "Choose a verified domain first"} required
          hint="Use an address on the selected domain. Verification is checked again by the server." />
        {domains.error ? <Failed message={domains.error} onRetry={() => void domains.reload()} /> :
          !domains.loading && !senders.length ? <p className="fieldHint"><Link to="/domains">Verify a sending domain</Link> to install.</p> : null}
        <Select label={newsletter ? "Topic" : "Marketing topic (optional)"} value={topic} onChange={setTopic}
          placeholder={newsletter ? "Choose a topic" : "Choose later"} required={newsletter}
          options={topics.rows.map((row) => ({ value: row.id, label: row.name }))} disabled={topics.loading || Boolean(topics.error)} />
        {topics.error ? <Failed message={topics.error} onRetry={() => void topics.reload()} /> : null}
        {newsletter && !topics.loading && !topics.error && !topics.rows.length ? <p className="fieldHint"><Link to="/audience/topics">Create a topic</Link> for newsletter subscriptions.</p> : null}
        <p className="fieldHint">Existing library copies are reused without overwriting your edits. Review all emails before enabling.</p>
        {install.error ? <p className="fieldError" role="alert">{install.error.message}</p> : null}
      </div>}
    </Modal>
  );
}
