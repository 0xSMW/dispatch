import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { GitBranch } from "lucide-react";
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

/** One creation surface: select a recipe, then configure it without stacked dialogs. */
export function Presets({ onBlank, onClose }: { onBlank?: () => void; onClose: () => void }) {
  const presets = useResource<List<AutomationPreset>>("/template-library/automations");
  const can = useCan();
  const [selected, setSelected] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [ready, setReady] = useState(false);
  const preset = presets.data?.data.find((item) => item.slug === selected);
  if (installing && preset) return <InstallPreset preset={preset} onClose={onClose} onBack={() => setInstalling(false)} />;
  return <Modal isOpen size="wide" title="Create automation" onClose={onClose}
    actions={can ? <button type="button" disabled={!preset || !ready} onClick={() => setInstalling(true)}>Use this recipe</button> : undefined}>
    {can && onBlank ? <button type="button" className="secondary" onClick={onBlank}>Start blank</button> : null}
    {presets.error ? <Failed message={presets.error} onRetry={() => void presets.reload()} /> :
      presets.loading && !presets.data ? <Skeleton lines={6} /> :
      <div className="automationChooser">
        <nav className="automationChoices" aria-label="Starting points">
          <p className="muted">Recipes</p>
          {presets.data?.data.map((item) => <button key={item.slug} type="button"
            className="automationChoice" aria-label={item.name} aria-pressed={preset?.slug === item.slug} onClick={() => { if (selected !== item.slug) { setReady(false); setSelected(item.slug); } }}>
            <span>{item.name}</span><small>{stages.find((stage) => stage.value === item.stage)?.label}</small>
          </button>)}
        </nav>
        {preset ? <PresetPreview key={preset.slug} preset={preset} onReady={setReady} /> :
          <Empty title={presets.data?.data.length ? "Choose a starting point" : "No recipes available"} body="Select a recipe to preview its workflow, or start blank." icon={<GitBranch size={28} strokeWidth={1.5} />} />}
      </div>}
  </Modal>;
}

function PresetPreview({ preset, onReady }: { preset: AutomationPreset; onReady: (ready: boolean) => void }) {
  const detail = useResource<AutomationPreset>(`/template-library/automations/${encodeURIComponent(preset.slug)}`);
  const graph = detail.data ? presetTree(detail.data) : null;
  useEffect(() => onReady(Boolean(detail.data) && !detail.loading && !detail.error && !graph?.problem), [detail.data, detail.loading, detail.error, graph?.problem, onReady]);
  return <section className="automationRecipe">
    <h3>{preset.name}</h3>
    <p>{preset.description}</p>
    <p className="muted">{preset.when}</p>
    <div className="automationRecipeGraph">
      {detail.error ? <Failed message={detail.error} onRetry={() => void detail.reload()} /> :
        graph?.problem ? <p role="alert">{graph.problem}</p> :
        graph ? <Canvas tree={graph.tree} disabled stacked /> : <Skeleton lines={6} />}
    </div>
    <div className="automationRecipeAction">
      <p className="fieldHint">Created disabled so you can review before enabling.</p>
    </div>
  </section>;
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

function InstallPreset({ preset, onClose, onBack }: { preset: AutomationPreset; onClose: () => void; onBack: () => void }) {
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
    <Modal isOpen size="wide" title={`Configure ${preset.name}`} onClose={onClose}
      actions={install.data ? undefined : <><button type="button" className="secondary" onClick={onBack} disabled={install.isLoading}>Back</button><button type="submit" disabled={!valid || install.isLoading}>{install.isLoading ? "Creating…" : "Create automation"}</button></>}
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
          !domains.loading && !senders.length ? <p className="fieldHint"><Link to="/domains" target="_blank" rel="noreferrer">Verify a sending domain</Link>, then <button type="button" className="secondary small" onClick={() => void domains.reload()}>Refresh domains</button>.</p> : null}
        <Select label={newsletter ? "Topic" : "Marketing topic (optional)"} value={topic} onChange={setTopic}
          placeholder={newsletter ? "Choose a topic" : "Choose later"} required={newsletter}
          options={topics.rows.map((row) => ({ value: row.id, label: row.name }))} disabled={topics.loading || Boolean(topics.error)} />
        {topics.error ? <Failed message={topics.error} onRetry={() => void topics.reload()} /> : null}
        {newsletter && !topics.loading && !topics.error && !topics.rows.length ? <p className="fieldHint"><Link to="/audience/topics" target="_blank" rel="noreferrer">Create a topic</Link>, then <button type="button" className="secondary small" onClick={() => void topics.reload()}>Refresh topics</button>.</p> : null}
        <p className="fieldHint">Existing library copies are reused without overwriting your edits. Review all emails before enabling.</p>
        {install.error ? <p className="fieldError" role="alert">{install.error.message}</p> : null}
      </div>}
    </Modal>
  );
}
