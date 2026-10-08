import "../../styles/settings.css";
import { useEffect, useState, type FormEvent } from "react";
import { Failed, Field, PageHeader, Panel, Skeleton, Switch, Tabs, TextArea } from "../../components";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { Settings } from "../../types";
import { settingsTabs } from "../tabs";

export function General() {
  const client = useClient();
  const can = useCan();
  const saved = useResource<Settings>("/settings");
  const [imports, setImports] = useState(false);
  const [domains, setDomains] = useState("");
  const [confirmationLimit, setConfirmationLimit] = useState("500");
  useEffect(() => {
    if (!saved.data) return;
    setImports(saved.data.import_trigger_automations);
    setDomains(saved.data.sandbox_domains.join("\n"));
    setConfirmationLimit(String(saved.data.confirmation_daily_limit ?? 500));
  }, [saved.data]);
  const names = domains.split(/[\s,]+/).filter(Boolean);
  const dirty = saved.data && (imports !== saved.data.import_trigger_automations || names.join("\n") !== saved.data.sandbox_domains.join("\n") || Number(confirmationLimit) !== (saved.data.confirmation_daily_limit ?? 500));
  const validLimit = /^\d+$/.test(confirmationLimit) && Number(confirmationLimit) <= 100000;
  const save = useMutation(() => client.patch<Settings>("/settings", { import_trigger_automations: imports, sandbox_domains: names, confirmation_daily_limit: Number(confirmationLimit) }), {
    success: "Settings saved.", onSuccess: (data) => saved.setData(data),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (can && dirty && validLimit) void save.mutate();
  }
  return (
    <div className="page settingsPage">
      <PageHeader title="Settings" />
      <Tabs tabs={settingsTabs} />
      <Panel title="General">
        {saved.error ? <Failed message={saved.error} onRetry={saved.reload} /> : null}
        {!saved.data && !saved.error ? <Skeleton lines={4} /> : null}
        {saved.data ? <form className="stack" onSubmit={submit}>
          <fieldset className="form" disabled={!can}>
            <Switch label="Start automations for imported contacts by default" checked={imports} onChange={setImports} hint="Each import can override this choice. Matching flows may send emails immediately." />
            <TextArea label="Additional sandbox domains" value={domains} onChange={setDomains} rows={4} hint="One hostname per line. Mail to these domains is stored for testing and never sent to SES." />
            <Field label="Daily confirmation email limit" type="number" value={confirmationLimit} onChange={setConfirmationLimit} hint="Per tenant, per UTC day. Default 500. Zero disables confirmation sends." error={!validLimit ? "Use a whole number from 0 to 100000" : undefined} />
          </fieldset>
          {can ? <button type="submit" disabled={!dirty || !validLimit || save.isLoading} aria-busy={save.isLoading}>Save</button> : null}
        </form> : null}
      </Panel>
    </div>
  );
}
