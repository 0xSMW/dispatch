import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, Circle, CircleAlert } from "lucide-react";
import { badgeLabel } from "../../components/Badge";
import { Code } from "../../components/Code";
import { PageHeader } from "../../components/PageHeader";
import { useAll, useResource } from "../../hooks/useResource";
import { curl } from "../../lib/reference";
import { useCan, useSession } from "../../shell/session";
import type { Domain, Setup } from "../../types";
import "../../styles/setup.css";

/**
 * The domain the API accepts as a sender: verified, with sending on. `preferred` is a domain id
 * to use when it qualifies; otherwise the first domain that does.
 */
export function sendingDomain(domains: Pick<Domain, "id" | "name" | "status" | "capabilities">[], preferred?: string | null) {
  const ready = domains.filter((domain) => domain.status === "verified" && domain.capabilities?.sending !== "disabled");
  return ready.find((domain) => domain.id === preferred) ?? ready[0] ?? null;
}

/**
 * The first `POST /emails` call as curl. The key is read from `$DISPATCH_API_KEY` in the
 * caller's shell; the dashboard never puts a key or its session token in the command.
 */
export function firstSendCommand(apiUrl: string, from: string, to: string) {
  return curl(
    {
      method: "POST",
      path: "/emails",
      summary: "Send an email",
      sdk: null,
      body: { from, to, subject: "Hello from Dispatch", text: "This is my first email sent through the Dispatch API." },
    },
    apiUrl,
  );
}

/** A prerequisite whose request failed: its state is unknown, so say so and offer a retry. */
export function Unavailable({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) {
  return (
    <p className="unavailable" role="alert">
      {what} unavailable: {error}{" "}
      <button type="button" className="secondary small" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}

/** Route `/setup/send`: the first-send guide on its own page. `?domain=` names the domain to send from. */
export function FirstSendPage() {
  const [params] = useSearchParams();
  return (
    <div className="page">
      <PageHeader title="Send your first email" back={{ to: "/setup", label: "Onboarding" }} />
      <FirstSend domain={params.get("domain")} />
    </div>
  );
}

/** What a first API send needs, and the command that sends it. Linked from onboarding and Emails. */
export function FirstSend({ domain }: { domain?: string | null }) {
  const { session } = useSession();
  const can = useCan();
  const setup = useResource<Setup>("/setup");
  const domains = useAll<Domain>("/domains");
  // A failed request with nothing loaded means the state is unknown, not empty.
  const domainsFailed = !domains.loading && Boolean(domains.error) && !domains.data;
  const setupFailed = !setup.loading && Boolean(setup.error) && !setup.data;
  const list = domains.data?.data ?? [];
  const sender = sendingDomain(list, domain);
  // A domain that exists but cannot send yet, so the guide can say which one and why.
  const waiting = sender ? null : (list.find((row) => row.id === domain) ?? list[0] ?? null);
  const key = setup.data?.api_key ?? null;
  const from = sender ? `hello@${sender.name}` : "hello@yourdomain.com";
  const to = session?.user?.email ?? setup.data?.user?.email ?? "you@example.com";
  const noSender = !domains.loading && Boolean(domains.data) && !sender;
  const noKey = !setup.loading && Boolean(setup.data) && !key;

  return (
    <>
      <section className="stack setupSection">
        <h2>Before you send</h2>
        <ol className="steps firstSendSteps">
          <li className={sender ? "done" : undefined}>
            {sender ? <CheckCircle2 size={18} /> : domainsFailed ? <CircleAlert size={18} /> : <Circle size={18} />}
            <div>
              <strong>A verified sending domain</strong>
              {domains.loading ? (
                <p>Checking your domains...</p>
              ) : domainsFailed ? (
                <Unavailable what="Domains" error={domains.error!} onRetry={() => void domains.reload()} />
              ) : sender ? (
                <p>Sending from {from}. Any address at {sender.name} works.</p>
              ) : waiting ? (
                <p>
                  {waiting.name} is {badgeLabel(waiting.status).toLowerCase()}
                  {waiting.status === "verified" ? " but sending is turned off" : ""}. Dispatch only sends from a verified domain with sending on.{" "}
                  <Link to={`/domains/${waiting.id}`}>Open {waiting.name}</Link>
                </p>
              ) : can ? (
                <p>
                  No domain yet. <Link to="/domains/add">Add a domain</Link> and publish its DNS records.
                </p>
              ) : (
                <p>No domain yet. Ask a team member with full access to add and verify one.</p>
              )}
            </div>
          </li>
          <li className={key ? "done" : undefined}>
            {key ? <CheckCircle2 size={18} /> : setupFailed ? <CircleAlert size={18} /> : <Circle size={18} />}
            <div>
              <strong>An API key</strong>
              {setup.loading ? (
                <p>Checking your API keys...</p>
              ) : setupFailed ? (
                <Unavailable what="API keys" error={setup.error!} onRetry={() => void setup.reload()} />
              ) : key ? (
                <p>
                  Use the full value of a key allowed to send from {sender?.name ?? "your sending domain"}: a full-access key, or a
                  sending-access key that is not limited to another domain. This page does not check which of your keys qualify. Dispatch
                  shows a key only once, when it is created. If you did not save it, <Link to="/api-keys">create another key</Link>.
                </p>
              ) : can ? (
                <p>
                  No API key yet. <Link to="/api-keys">Create an API key</Link> and save its value.
                </p>
              ) : (
                <p>No API key yet. Ask a team member with full access to create one.</p>
              )}
            </div>
          </li>
        </ol>
      </section>

      <section className="stack setupSection">
        <h2>Send with curl</h2>
        <p>
          Set <span className="mono">DISPATCH_API_KEY</span> to an API key allowed to send from the sender's domain, then run this command. It
          sends one email from {from} to {to}.
        </p>
        {noSender ? (
          <p className="setupWarning">
            This command fails until the sender's domain is verified with sending on. Replace the sender address after you verify a domain.
          </p>
        ) : noKey ? (
          <p className="setupWarning">Create an API key before you run this command.</p>
        ) : null}
        {session ? <Code value={firstSendCommand(session.apiUrl, from, to)} /> : null}
        <p className="muted">
          The email appears on <Link to="/emails">Emails</Link> within a few seconds, and this onboarding step is marked done.
        </p>
      </section>
    </>
  );
}
