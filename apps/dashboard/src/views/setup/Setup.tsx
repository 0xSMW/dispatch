import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, CircleAlert } from "lucide-react";
import { badgeLabel } from "../../components/Badge";
import { Facts } from "../../components/Facts";
import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Status } from "../../components/Status";
import { finish, useMutation } from "../../hooks/useMutation";
import { useSetup } from "../../shell/Onboarding";
import { useCan, useClient } from "../../shell/session";
import { Unavailable } from "./FirstSend";
import "../../styles/setup.css";

/** Onboarding checklist. Ported from SetupView; reached from the account menu. */
export function Setup() {
  const { setup, emails, steps, reload } = useSetup();
  const can = useCan();
  const [sending, setSending] = useState(false);
  const data = setup.data;
  // A failed request with nothing loaded leaves its facts unknown, not missing.
  const setupFailed = !setup.loading && Boolean(setup.error) && !data;

  return (
    <div className="page">
      <PageHeader title="Onboarding" />

      <Panel title="Steps">
        <ol className="steps">
          {steps.map((step) => (
            <li key={step.label} className={step.done ? "done" : undefined}>
              {step.unknown ? <CircleAlert size={18} /> : step.done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
              <Link to={step.to}>{step.label}</Link>
            </li>
          ))}
        </ol>
        {setupFailed ? <Unavailable what="Domain and API key status" error={setup.error!} onRetry={() => void setup.reload()} /> : null}
        {!emails.loading && emails.error && !emails.data ? (
          <Unavailable what="First email status" error={emails.error} onRetry={() => void emails.reload()} />
        ) : null}
        {/* {can ? (
          <div className="toolbar">
            <button type="button" onClick={() => setSending(true)}>
              Send a test email
            </button>
          </div>
        ) : null} */}
      </Panel>

      <Panel title="Lifecycle email (optional)">
        <div className="stack">
          <p className="muted">Explore lifecycle email when you are ready. These optional steps do not affect setup completion.</p>
          {can ? (
            <ul>
              <li><Link to="/settings/brand">Set your brand</Link></li>
              <li><Link to="/events">Send your first event</Link></li>
              <li><Link to="/templates/library">Choose a template</Link></li>
            </ul>
          ) : (
            <p className="muted">Ask a team member with full access to set the brand, send an event, or choose a template.</p>
          )}
          <p className="muted">Choose a ready-made template, then configure your automation. Review it before enabling it.</p>
        </div>
      </Panel>

      <section className="stack setupSection">
        <h2>Workspace details</h2>
        {setupFailed ? (
          <Unavailable what="Workspace details" error={setup.error!} onRetry={() => void setup.reload()} />
        ) : !data ? (
          <Skeleton lines={2} />
        ) : (
          <Facts
            items={[
              {
                label: "Workspace",
                value: <Status ok={Boolean(data.tenant)} text={data.tenant?.name ?? "Not found. The operator must finish installing Dispatch."} />,
              },
              {
                label: "First domain",
                value: (
                  <Status
                    ok={data.domain?.status === "verified"}
                    text={data.domain ? `${data.domain.name} · ${badgeLabel(data.domain.status)}` : "None added"}
                  />
                ),
              },
              {
                label: "First API key",
                value: (
                  <Status
                    ok={Boolean(data.api_key)}
                    text={data.api_key ? `${data.api_key.name} · ${data.api_key.prefix} · ${data.api_key.scope} access` : "None created"}
                  />
                ),
              },
              {
                label: "First user",
                value: <Status ok={Boolean(data.user)} text={data.user ? `${data.user.name} · ${data.user.email}` : "None found"} />,
              },
            ]}
          />
        )}
      </section>

      {sending ? (
        <TestSend
          from={data?.domain ? `hello@${data.domain.name}` : ""}
          to={data?.user?.email ?? ""}
          onClose={() => setSending(false)}
          onDone={reload}
        />
      ) : null}
    </div>
  );
}

function TestSend({ from, to, onClose, onDone }: { from: string; to: string; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [form, setForm] = useState({ from, to });
  const { mutate, isLoading } = useMutation(
    () => client.post("/emails", { ...form, subject: "Dispatch test", text: "Sent from the Dispatch dashboard." }),
    {
      success: "Test email queued.",
      onSuccess: finish(onDone, onClose),
    },
  );

  return (
    <Modal isOpen title="Send a test email" onClose={onClose} onSubmit={() => void mutate()} submitLabel="Send" submitting={isLoading}>
      <div className="form">
        <Field label="From" value={form.from} onChange={(value) => setForm({ ...form, from: value })} required autoFocus />
        <Field label="To" type="email" value={form.to} onChange={(value) => setForm({ ...form, to: value })} required />
      </div>
    </Modal>
  );
}
