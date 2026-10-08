import { Link } from "react-router-dom";
import { Code } from "../../components/Code";
import { Empty, Failed } from "../../components/Empty";
import { Facts } from "../../components/Facts";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Tabs } from "../../components/Tabs";
import { useResource } from "../../hooks/useResource";
import { useSession } from "../../shell/session";
import type { System } from "../../types";
import { settingsTabs } from "../tabs";
import "../../styles/settings.css";

/** The API's host name, the guess for the relay when the operator did not set SMTP_HOST. */
export function smtpHost(apiUrl: string | undefined): string {
  try {
    return apiUrl ? new URL(apiUrl).hostname : "localhost";
  } catch {
    return "localhost";
  }
}

/** Host and ports from `GET /system`. The host falls back to the API's host name, and says so. */
export function relay(smtp: System["smtp"], apiUrl: string | undefined) {
  return {
    host: smtp?.host || smtpHost(apiUrl),
    guessed: !smtp?.host,
    port: smtp?.port ?? 587,
    tlsPort: smtp?.tls_port ?? 465,
  };
}

/** SMTP relay connection details. The password is an API key. */
export function Smtp() {
  const { session } = useSession();
  const system = useResource<System>("/system");
  const { host, guessed, port, tlsPort } = relay(system.data?.smtp, session?.apiUrl);

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <Tabs tabs={settingsTabs} />
      <Panel title="SMTP">
        <div className="stack">
          {system.loading ? (
            <Skeleton lines={4} />
          ) : system.error ? (
            <Failed message={system.error} onRetry={system.reload} />
          ) : !system.data?.smtp ? (
            <Empty compact title="SMTP isn't available here" body="Send your emails through the API instead." action={<Link className="button secondary" to="/emails/send">Send a test email</Link>} />
          ) : (
            <>
              <p className="muted">Send through Dispatch from anything that speaks SMTP. Messages take the same path as the API.</p>
              <Facts
                columns={2}
                items={[
                  { label: "Host", value: host, copy: true },
                  { label: "Username", value: "dispatch", copy: true },
                  { label: "Port, STARTTLS", value: String(port), copy: true },
                  { label: "Port, implicit TLS", value: String(tlsPort), copy: true },
                  {
                    label: "Password",
                    value: (
                      <span>
                        An API key, <span className="mono">sk_...</span>. A sending key is enough. <Link to="/api-keys">Create one</Link>.
                      </span>
                    ),
                  },
                  { label: "Auth methods", value: "PLAIN, LOGIN", mono: true },
                ]}
              />
              <p className="note">
                {guessed
                  ? "The relay host is not configured, so this shows the API's host name. The operator can set SMTP_HOST to show the real one. "
                  : null}
                Port {tlsPort} is open only when the relay has a TLS certificate.
              </p>
              <Code
                language="text"
                value={[`SMTP_HOST=${host}`, `SMTP_PORT=${port}`, "SMTP_USER=dispatch", "SMTP_PASS=sk_your_api_key"].join("\n")}
              />
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
