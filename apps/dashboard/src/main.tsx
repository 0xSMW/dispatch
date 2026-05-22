import React, { useEffect, useMemo, useState, useTransition } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  CheckCircle2,
  FileText,
  GitBranch,
  Globe2,
  Inbox,
  KeyRound,
  List,
  Mail,
  Megaphone,
  RefreshCw,
  Send,
  Users,
  Webhook,
} from "lucide-react";
import "./styles.css";

type View =
  | "setup"
  | "identity"
  | "domains"
  | "keys"
  | "send"
  | "emails"
  | "templates"
  | "audience"
  | "broadcasts"
  | "automations"
  | "inbound"
  | "webhooks"
  | "timeline"
  | "logs";
type ListResponse<T> = { data: T[]; request_id?: string };
type Domain = {
  id: string;
  name: string;
  region: string;
  status: string;
  records: Array<Record<string, string>>;
  checked_at?: string;
};
type TemplateVersion = {
  id: string;
  subject: string;
  html?: string | null;
  text?: string | null;
  variables?: string[];
  created_at: string;
  published_at?: string;
};
type TemplateRow = {
  id: string;
  name: string;
  alias?: string | null;
  published_version_id?: string | null;
  subject?: string;
  variables?: string[];
  version?: TemplateVersion | null;
  created_at: string;
  updated_at: string;
};
type Email = {
  id: string;
  request_id?: string;
  subject: string;
  status: string;
  from?: string;
  from_email?: string;
  to?: string[];
  provider_message_id?: string;
  created_at: string;
  recipients?: Array<{
    id: string;
    email: string;
    kind: string;
    status: string;
  }>;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    created_at: string;
  }>;
  events?: Event[];
};
type Event = {
  id: string;
  request_id?: string;
  type: string;
  created_at: string;
  data: Record<string, unknown>;
};
type WebhookRow = {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
};
type Attempt = {
  id: string;
  event_id: string;
  state: string;
  attempt: number;
  status?: number;
  error?: string;
  created_at: string;
};
type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  created_at: string;
  last_used_at?: string;
};
type UserRow = {
  id: string;
  email: string;
  name: string;
  created_at: string;
  deactivated_at?: string | null;
};
type RoleRow = {
  id: string;
  name: string;
  permissions: string[];
  created_at: string;
};
type MembershipRow = {
  id: string;
  user_id: string;
  email: string;
  name: string;
  role_id: string;
  role: string;
  created_at: string;
};
type SessionRow = {
  id: string;
  user_id: string;
  email: string;
  expires_at: string;
  created_at: string;
  revoked_at?: string | null;
};
type AuditRow = {
  id: string;
  request_id?: string;
  actor_email?: string | null;
  action: string;
  data?: Record<string, unknown>;
  created_at: string;
};
type IdentityData = {
  users: ListResponse<UserRow>;
  roles: ListResponse<RoleRow>;
  memberships: ListResponse<MembershipRow>;
  sessions: ListResponse<SessionRow>;
  audit: ListResponse<AuditRow>;
};
type LogRow = {
  id: string;
  request_id: string;
  user_agent?: string;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  created_at: string;
};
type TimelineRow = {
  kind: string;
  id: string;
  request_id?: string | null;
  name: string;
  summary: string;
  created_at: string;
};
type ContactRow = {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  properties?: Record<string, unknown>;
  unsubscribed_at?: string | null;
  created_at: string;
};
type SuppressionRow = {
  id: string;
  email: string;
  reason: string;
  created_at: string;
};
type TopicRow = {
  id: string;
  name: string;
  key: string;
  default_status: string;
  created_at: string;
};
type TopicSubscription = {
  id: string;
  email: string;
  status: string;
  first_name?: string | null;
  last_name?: string | null;
  created_at: string;
};
type SegmentRow = {
  id: string;
  name: string;
  description?: string | null;
  contacts?: number;
  created_at: string;
};
type SegmentContact = {
  id: string;
  contact_id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  created_at: string;
};
type AudienceData = {
  contacts: ListResponse<ContactRow>;
  suppressions: ListResponse<SuppressionRow>;
  topics: ListResponse<TopicRow>;
  segments: ListResponse<SegmentRow>;
};
type BroadcastRow = {
  id: string;
  name: string;
  from?: string;
  subject?: string | null;
  topic_id?: string | null;
  segment_id?: string | null;
  status: string;
  recipient_count: number;
  sent_count: number;
  created_at: string;
  sent_at?: string | null;
};
type BroadcastDetail = BroadcastRow & {
  html?: string | null;
  text?: string | null;
  variables?: Record<string, unknown>;
  recipients?: Array<{
    id: string;
    email: string;
    status: string;
    email_id?: string | null;
    created_at: string;
  }>;
};
type CustomEventRow = {
  id: string;
  request_id?: string;
  name: string;
  email?: string | null;
  data?: Record<string, unknown>;
  created_at: string;
};
type AutomationStep = { type: string; [key: string]: unknown };
type AutomationRow = {
  id: string;
  name: string;
  trigger: string;
  steps: AutomationStep[];
  enabled: boolean;
  created_at: string;
};
type AutomationRunRow = {
  id: string;
  automation_id?: string;
  event_id: string;
  event_name: string;
  email?: string | null;
  state: string;
  error?: string | null;
  created_at: string;
};
type AutomationRunDetail = AutomationRunRow & {
  event_data?: Record<string, unknown>;
  steps?: Array<{
    id: string;
    step_index: number;
    type: string;
    state: string;
    data?: Record<string, unknown>;
    error?: string | null;
    created_at: string;
  }>;
};
type AutomationsData = {
  automations: ListResponse<AutomationRow>;
  events: ListResponse<CustomEventRow>;
};
type ReceivedEmailRow = {
  id: string;
  request_id?: string;
  from: string;
  subject: string;
  to?: string[];
  created_at: string;
};
type ReceivedEmailDetail = ReceivedEmailRow & {
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  recipients?: Array<{
    id: string;
    email: string;
    kind: string;
    created_at: string;
  }>;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    created_at: string;
  }>;
};

const nav = [
  ["setup", CheckCircle2, "Setup"],
  ["identity", Users, "Identity"],
  ["domains", Globe2, "Domains"],
  ["keys", KeyRound, "Keys"],
  ["send", Send, "Send"],
  ["emails", Mail, "Emails"],
  ["templates", FileText, "Templates"],
  ["audience", Users, "Audience"],
  ["broadcasts", Megaphone, "Broadcasts"],
  ["automations", GitBranch, "Automations"],
  ["inbound", Inbox, "Inbound"],
  ["webhooks", Webhook, "Webhooks"],
  ["timeline", Activity, "Timeline"],
  ["logs", List, "Logs"],
] as const;

function App() {
  const [view, setView] = useState<View>("setup");
  const [apiUrl, setApiUrl] = useState(import.meta.env.VITE_API_URL ?? "http://localhost:3100");
  const [apiKey, setApiKey] = useState("sk_local_dispatch_dev_key_change_before_deploy");
  const [data, setData] = useState<Record<string, unknown>>({});
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const client = useMemo(() => makeClient(apiUrl, apiKey), [apiUrl, apiKey]);

  useEffect(() => {
    localStorage.removeItem("dispatch.apiUrl");
    localStorage.removeItem("dispatch.apiKey");
  }, []);

  useEffect(() => {
    refresh();
  }, [view, client]);

  function refresh() {
    startTransition(async () => {
      try {
        const result = await loadView(view, client);
        setData((current) => ({ ...current, [view]: result }));
        setMessage("");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    });
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Activity size={22} />
          <span>Dispatch</span>
        </div>
        <nav>
          {nav.map(([key, Icon, label]) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => setView(key)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <h1>{title(view)}</h1>
            <p>Local control plane</p>
          </div>
          <button className="iconButton" onClick={refresh} aria-label="Refresh">
            <RefreshCw size={18} className={isPending ? "spin" : ""} />
          </button>
        </header>

        <section className="settings">
          <label>
            API URL
            <input
              value={apiUrl}
              onChange={(event) => setApiUrl(event.target.value)}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          {message ? <div className="alert">{message}</div> : null}
        </section>

        {view === "setup" ? (
          <Setup data={data.setup} client={client} refresh={refresh} />
        ) : null}
        {view === "identity" ? (
          <Identity
            data={data.identity as IdentityData | undefined}
            client={client}
            apiKey={apiKey}
            refresh={refresh}
          />
        ) : null}
        {view === "domains" ? (
          <Domains
            data={data.domains as ListResponse<Domain> | undefined}
            client={client}
            refresh={refresh}
          />
        ) : null}
        {view === "keys" ? (
          <Keys
            data={data.keys as ListResponse<KeyRow> | undefined}
            client={client}
            refresh={refresh}
          />
        ) : null}
        {view === "send" ? <SendView client={client} /> : null}
        {view === "emails" ? (
          <Emails
            data={data.emails as ListResponse<Email> | undefined}
            client={client}
          />
        ) : null}
        {view === "templates" ? (
          <Templates
            data={data.templates as ListResponse<TemplateRow> | undefined}
            client={client}
            refresh={refresh}
          />
        ) : null}
        {view === "audience" ? (
          <Audience
            data={data.audience as AudienceData | undefined}
            client={client}
            refresh={refresh}
          />
        ) : null}
        {view === "broadcasts" ? (
          <Broadcasts
            data={data.broadcasts as ListResponse<BroadcastRow> | undefined}
            client={client}
            refresh={refresh}
          />
        ) : null}
        {view === "automations" ? (
          <Automations
            data={data.automations as AutomationsData | undefined}
            client={client}
            refresh={refresh}
          />
        ) : null}
        {view === "inbound" ? (
          <Inbound
            data={data.inbound as ListResponse<ReceivedEmailRow> | undefined}
            client={client}
            refresh={refresh}
          />
        ) : null}
        {view === "webhooks" ? (
          <Webhooks
            data={data.webhooks as ListResponse<WebhookRow> | undefined}
            client={client}
            refresh={refresh}
          />
        ) : null}
        {view === "timeline" ? (
          <Timeline data={data.timeline as ListResponse<TimelineRow> | undefined} />
        ) : null}
        {view === "logs" ? (
          <Logs data={data.logs as ListResponse<LogRow> | undefined} />
        ) : null}
      </main>
    </div>
  );
}

function Setup({
  data,
  client,
  refresh,
}: {
  data: unknown;
  client: Client;
  refresh: () => void;
}) {
  const setup = data as
    | {
        tenant?: { name: string };
        domain?: { name: string; status: string };
        api_key?: { prefix: string };
        user?: { email: string; name: string };
      }
    | undefined;
  return (
    <div className="grid">
      <Panel title="Tenant">
        <Status
          ok={Boolean(setup?.tenant)}
          text={setup?.tenant?.name ?? "Run pnpm db:seed"}
        />
      </Panel>
      <Panel title="API key">
        <Status
          ok={Boolean(setup?.api_key)}
          text={setup?.api_key?.prefix ?? "Missing"}
        />
      </Panel>
      <Panel title="User">
        <Status
          ok={Boolean(setup?.user)}
          text={setup?.user ? `${setup.user.name} ${setup.user.email}` : "Missing"}
        />
      </Panel>
      <Panel title="Domain">
        <Status
          ok={setup?.domain?.status === "verified"}
          text={
            setup?.domain
              ? `${setup.domain.name} ${setup.domain.status}`
              : "Missing"
          }
        />
      </Panel>
      <Panel title="First send">
        <button
          onClick={async () => {
            await client.send({
              from: "hello@example.com",
              to: "you@example.com",
              subject: "Dispatch local test",
              text: "Sent from the dashboard.",
            });
            refresh();
          }}
        >
          Send test
        </button>
      </Panel>
    </div>
  );
}

function Identity({
  data,
  client,
  apiKey,
  refresh,
}: {
  data?: IdentityData;
  client: Client;
  apiKey: string;
  refresh: () => void;
}) {
  const [user, setUser] = useState({
    email: "operator@example.test",
    name: "Operator",
  });
  const [role, setRole] = useState({
    name: "owner",
    permissions: "full",
  });
  const [membership, setMembership] = useState({
    user_id: "",
    role_id: "",
  });
  const [session, setSession] = useState({
    email: "operator@example.test",
    api_key: apiKey,
  });
  const [result, setResult] = useState<unknown>(null);
  return (
    <div className="stack">
      <div className="grid two">
        <Panel title="Users">
          <form
            className="form compact"
            onSubmit={async (event) => {
              event.preventDefault();
              await client.post("/v1/users", user);
              refresh();
            }}
          >
            <label>
              Email
              <input value={user.email} onChange={(event) => setUser({ ...user, email: event.target.value })} />
            </label>
            <label>
              Name
              <input value={user.name} onChange={(event) => setUser({ ...user, name: event.target.value })} />
            </label>
            <button>Create user</button>
          </form>
        </Panel>
        <Panel title="Roles">
          <form
            className="form compact"
            onSubmit={async (event) => {
              event.preventDefault();
              await client.post("/v1/roles", { name: role.name, permissions: csv(role.permissions) });
              refresh();
            }}
          >
            <label>
              Name
              <input value={role.name} onChange={(event) => setRole({ ...role, name: event.target.value })} />
            </label>
            <label>
              Permissions
              <input value={role.permissions} onChange={(event) => setRole({ ...role, permissions: event.target.value })} />
            </label>
            <button>Create role</button>
          </form>
        </Panel>
      </div>
      <div className="grid two">
        <Panel title="Membership">
          <form
            className="form compact"
            onSubmit={async (event) => {
              event.preventDefault();
              await client.post("/v1/memberships", membership);
              refresh();
            }}
          >
            <label>
              User ID
              <input value={membership.user_id} onChange={(event) => setMembership({ ...membership, user_id: event.target.value })} />
            </label>
            <label>
              Role ID
              <input value={membership.role_id} onChange={(event) => setMembership({ ...membership, role_id: event.target.value })} />
            </label>
            <button>Set membership</button>
          </form>
        </Panel>
        <Panel title="Session">
          <form
            className="form compact"
            onSubmit={async (event) => {
              event.preventDefault();
              const response = await client.publicPost("/v1/sessions", session);
              setResult(response);
            }}
          >
            <label>
              Email
              <input value={session.email} onChange={(event) => setSession({ ...session, email: event.target.value })} />
            </label>
            <label>
              API key
              <input
                type="password"
                value={session.api_key}
                onChange={(event) => setSession({ ...session, api_key: event.target.value })}
              />
            </label>
            <button>Create session</button>
          </form>
        </Panel>
      </div>
      <Table
        columns={["User", "Name", "Created"]}
        rows={(data?.users.data ?? []).map((row) => [row.email, row.name, row.created_at])}
      />
      <Table
        columns={["Role", "Permissions", "Created"]}
        rows={(data?.roles.data ?? []).map((row) => [row.name, row.permissions.join(", "), row.created_at])}
      />
      <Table
        columns={["Member", "Role", "Created"]}
        rows={(data?.memberships.data ?? []).map((row) => [row.email, row.role, row.created_at])}
      />
      <Table
        columns={["Session", "Email", "Expires", "Created"]}
        rows={(data?.sessions.data ?? []).map((row) => [row.id, row.email, row.expires_at, row.created_at])}
      />
      <Table
        columns={["Action", "Actor", "Request", "Created"]}
        rows={(data?.audit.data ?? []).map((row) => [row.action, row.actor_email ?? "", row.request_id ?? "", row.created_at])}
      />
      <pre>{result ? JSON.stringify(result, null, 2) : ""}</pre>
    </div>
  );
}

function Domains({
  data,
  client,
  refresh,
}: {
  data?: ListResponse<Domain>;
  client: Client;
  refresh: () => void;
}) {
  const [name, setName] = useState("example.com");
  const [detail, setDetail] = useState<Domain | null>(null);
  const [checks, setChecks] = useState<unknown>(null);
  return (
    <div className="split">
      <div>
        <form
          className="toolbar"
          onSubmit={async (event) => {
            event.preventDefault();
            await client.post("/v1/domains", { name, region: "us-east-1" });
            refresh();
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button>Add domain</button>
        </form>
        <Table
          columns={["Domain", "Region", "Status", "Last check"]}
          rows={(data?.data ?? []).map((domain) => [
            <button
              className="link"
              key={domain.id}
              onClick={async () => {
                const result = (await client.get(
                  `/v1/domains/${domain.id}`,
                )) as { domain: Domain };
                setDetail(result.domain);
                setChecks(null);
              }}
            >
              {domain.name}
            </button>,
            domain.region,
            <Badge key="status" value={domain.status} />,
            domain.checked_at ?? "pending",
          ])}
        />
      </div>
      <Panel title="DNS">
        {detail ? (
          <>
            <div className="toolbar">
              <button
                onClick={async () => {
                  const result = (await client.post(
                    `/v1/domains/${detail.id}/verify`,
                    {},
                  )) as { domain: Domain };
                  setDetail(result.domain);
                  refresh();
                }}
              >
                Verify
              </button>
              <button
                onClick={async () =>
                  setChecks(await client.get(`/v1/domains/${detail.id}/doctor`))
                }
              >
                Doctor
              </button>
              <button
                onClick={async () => {
                  await client.delete(`/v1/domains/${detail.id}`);
                  setDetail(null);
                  setChecks(null);
                  refresh();
                }}
              >
                Delete
              </button>
            </div>
            <Table
              columns={["Type", "Name", "Value", "Status"]}
              rows={(detail.records ?? []).map((record) => [
                record.type,
                record.name,
                <code key="value">{record.value}</code>,
                record.status ?? detail.status,
              ])}
            />
            <pre>{checks ? JSON.stringify(checks, null, 2) : ""}</pre>
          </>
        ) : (
          <p>Select a domain.</p>
        )}
      </Panel>
    </div>
  );
}

function Keys({
  data,
  client,
  refresh,
}: {
  data?: ListResponse<KeyRow>;
  client: Client;
  refresh: () => void;
}) {
  return (
    <>
      <div className="toolbar">
        <button
          onClick={async () => {
            const result = await client.post("/v1/api-keys", {
              name: `key-${Date.now()}`,
              scope: "full",
            });
            alert(JSON.stringify(result, null, 2));
            refresh();
          }}
        >
          Create key
        </button>
      </div>
      <Table
        columns={["Name", "Prefix", "Scope", "Created", "Action"]}
        rows={(data?.data ?? []).map((key) => [
          key.name,
          key.prefix,
          key.scope,
          key.created_at,
          <button
            key="revoke"
            onClick={async () => {
              await client.delete(`/v1/api-keys/${key.id}`);
              refresh();
            }}
          >
            Revoke
          </button>,
        ])}
      />
    </>
  );
}

function SendView({ client }: { client: Client }) {
  const [form, setForm] = useState({
    from: "hello@example.com",
    to: "you@example.com",
    cc: "",
    bcc: "",
    subject: "Dispatch local test",
    text: "Hello from Dispatch.",
    html: "",
    headers: "{}",
    tags: "{}",
    scheduled_at: "",
  });
  const [batchForm, setBatchForm] = useState({
    from: "hello@example.com",
    to: "batch-one@example.com, batch-two@example.com",
    subject: "Dispatch local batch",
    text: "Hello from the batch API.",
  });
  const [result, setResult] = useState<unknown>();
  const [batchResult, setBatchResult] = useState<unknown>();
  return (
    <div className="split">
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          setResult(await client.send(sendBody(form)));
        }}
      >
        {Object.entries(form).map(([key, value]) => (
          <label key={key}>
            {key}
            {key === "text" ||
            key === "html" ||
            key === "headers" ||
            key === "tags" ? (
              <textarea
                value={value}
                onChange={(event) =>
                  setForm({ ...form, [key]: event.target.value })
                }
              />
            ) : (
              <input
                value={value}
                onChange={(event) =>
                  setForm({ ...form, [key]: event.target.value })
                }
              />
            )}
          </label>
        ))}
        <button>Send email</button>
      </form>
      <div className="stack">
        <pre>{JSON.stringify(result, null, 2)}</pre>
        <Panel title="Batch send">
          <form
            className="form compact"
            onSubmit={async (event) => {
              event.preventDefault();
              const emails = csv(batchForm.to).map((to, index) => ({
                from: batchForm.from,
                to,
                subject:
                  csv(batchForm.to).length === 1
                    ? batchForm.subject
                    : `${batchForm.subject} ${index + 1}`,
                text: batchForm.text,
              }));
              setBatchResult(await client.post("/v1/emails/batch", { emails }));
            }}
          >
            {Object.entries(batchForm).map(([key, value]) => (
              <label key={key} className={key === "text" ? "wideField" : ""}>
                {key}
                {key === "text" ? (
                  <textarea
                    value={value}
                    onChange={(event) =>
                      setBatchForm({
                        ...batchForm,
                        [key]: event.target.value,
                      })
                    }
                  />
                ) : (
                  <input
                    value={value}
                    onChange={(event) =>
                      setBatchForm({
                        ...batchForm,
                        [key]: event.target.value,
                      })
                    }
                  />
                )}
              </label>
            ))}
            <button>Send batch</button>
          </form>
          <pre>{JSON.stringify(batchResult, null, 2)}</pre>
        </Panel>
      </div>
    </div>
  );
}

function Emails({
  data,
  client,
}: {
  data?: ListResponse<Email>;
  client: Client;
}) {
  const [detail, setDetail] = useState<Email | null>(null);
  return (
    <div className="split">
      <Table
        columns={["Subject", "To", "Status", "Created"]}
        rows={(data?.data ?? []).map((email) => [
          <button
            className="link"
            key={email.id}
            onClick={async () =>
              setDetail(
                (
                  (await client.get(`/v1/emails/${email.id}`)) as {
                    email: Email;
                  }
                ).email,
              )
            }
          >
            {email.subject}
          </button>,
          email.to?.join(", ") ?? "",
          <Badge key="status" value={email.status} />,
          email.created_at,
        ])}
      />
      <Panel title="Timeline">
        {detail ? (
          <>
            <dl className="facts">
              <dt>Request</dt>
              <dd>{detail.request_id}</dd>
              <dt>Provider</dt>
              <dd>{detail.provider_message_id ?? "pending"}</dd>
              <dt>From</dt>
              <dd>{detail.from_email ?? detail.from}</dd>
            </dl>
            <div className="toolbar">
              <button
                disabled={!["queued", "scheduled"].includes(detail.status)}
                onClick={async () => {
                  const result = (await client.post(
                    `/v1/emails/${detail.id}/cancel`,
                    {},
                  )) as { email: { status: string } };
                  setDetail({ ...detail, status: result.email.status });
                }}
              >
                Cancel
              </button>
            </div>
            <Table
              columns={["Recipient", "Kind", "Status"]}
              rows={(detail.recipients ?? []).map((recipient) => [
                recipient.email,
                recipient.kind,
                <Badge key="status" value={recipient.status} />,
              ])}
            />
            <Table
              columns={["Attachment", "Type", "Size", "Created"]}
              rows={(detail.attachments ?? []).map((attachment) => [
                attachment.filename,
                attachment.content_type,
                `${attachment.size_bytes} bytes`,
                attachment.created_at,
              ])}
            />
            {detail.events?.length ? (
              <ol className="timeline">
                {detail.events.map((event) => (
                  <li key={event.id}>
                    <span>{event.type}</span>
                    <time>{event.created_at}</time>
                    <code>{event.request_id}</code>
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : (
          <p>Select an email.</p>
        )}
      </Panel>
    </div>
  );
}

function Templates({
  data,
  client,
  refresh,
}: {
  data?: ListResponse<TemplateRow>;
  client: Client;
  refresh: () => void;
}) {
  const [form, setForm] = useState({
    name: "Welcome",
    alias: "welcome",
    subject: "Welcome to Dispatch",
    text: "Hello {{name}}, welcome to Dispatch.",
    html: "",
    variables: "name",
  });
  const [detail, setDetail] = useState<TemplateRow | null>(null);
  const [renderVars, setRenderVars] = useState('{"name":"Ada"}');
  const [result, setResult] = useState<unknown>(null);
  return (
    <div className="split">
      <div className="stack">
        <Panel title="Create template">
          <form
            className="form compact"
            onSubmit={async (event) => {
              event.preventDefault();
              await client.post("/v1/templates", templateBody(form));
              refresh();
            }}
          >
            <label>
              Name
              <input
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
              />
            </label>
            <label>
              Alias
              <input
                value={form.alias}
                onChange={(event) =>
                  setForm({ ...form, alias: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              Subject
              <input
                value={form.subject}
                onChange={(event) =>
                  setForm({ ...form, subject: event.target.value })
                }
              />
            </label>
            <label>
              Variables
              <input
                value={form.variables}
                onChange={(event) =>
                  setForm({ ...form, variables: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              Text
              <textarea
                value={form.text}
                onChange={(event) =>
                  setForm({ ...form, text: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              HTML
              <textarea
                value={form.html}
                onChange={(event) =>
                  setForm({ ...form, html: event.target.value })
                }
              />
            </label>
            <button>Create</button>
          </form>
        </Panel>
        <Table
          columns={["Name", "Alias", "Subject", "Variables", "Updated"]}
          rows={(data?.data ?? []).map((template) => [
            <button
              className="link"
              key={template.id}
              onClick={async () => {
                const result = (await client.get(
                  `/v1/templates/${template.id}`,
                )) as { template: TemplateRow };
                setDetail(result.template);
                setResult(null);
              }}
            >
              {template.name}
            </button>,
            template.alias ?? "",
            template.subject ?? template.version?.subject ?? "",
            (template.variables ?? template.version?.variables ?? []).join(
              ", ",
            ),
            template.updated_at,
          ])}
        />
      </div>
      <Panel title="Render">
        {detail ? (
          <div className="stack">
            <dl className="facts">
              <dt>ID</dt>
              <dd>{detail.id}</dd>
              <dt>Published</dt>
              <dd>{detail.published_version_id ?? "none"}</dd>
              <dt>Subject</dt>
              <dd>{detail.version?.subject ?? detail.subject}</dd>
            </dl>
            <label className="soloField">
              Variables JSON
              <textarea
                value={renderVars}
                onChange={(event) => setRenderVars(event.target.value)}
              />
            </label>
            <div className="toolbar">
              <button
                onClick={async () =>
                  setResult(
                    await client.post(`/v1/templates/${detail.id}/render`, {
                      variables: parseJson(renderVars, {}),
                    }),
                  )
                }
              >
                Render
              </button>
              <button
                onClick={async () => {
                  await client.post(`/v1/templates/${detail.id}/duplicate`, {});
                  refresh();
                }}
              >
                Duplicate
              </button>
              <button
                onClick={async () => {
                  await client.delete(`/v1/templates/${detail.id}`);
                  setDetail(null);
                  refresh();
                }}
              >
                Delete
              </button>
            </div>
            <pre>
              {result
                ? JSON.stringify(result, null, 2)
                : JSON.stringify(detail.version ?? detail, null, 2)}
            </pre>
          </div>
        ) : (
          <p>Select a template.</p>
        )}
      </Panel>
    </div>
  );
}

function Audience({
  data,
  client,
  refresh,
}: {
  data?: AudienceData;
  client: Client;
  refresh: () => void;
}) {
  const [tab, setTab] = useState<
    "contacts" | "suppressions" | "topics" | "segments"
  >("contacts");
  const [contact, setContact] = useState({
    email: "ada@example.com",
    first_name: "Ada",
    last_name: "Lovelace",
  });
  const [suppression, setSuppression] = useState({
    email: "blocked@example.com",
    reason: "manual",
  });
  const [topic, setTopic] = useState({
    name: "Product updates",
    key: "product-updates",
    default_status: "subscribed",
  });
  const [selectedTopic, setSelectedTopic] = useState<TopicRow | null>(null);
  const [subscriptions, setSubscriptions] =
    useState<ListResponse<TopicSubscription> | null>(null);
  const [subscriptionEmail, setSubscriptionEmail] = useState("ada@example.com");
  const [segment, setSegment] = useState({
    name: "Early users",
    description: "",
  });
  const [selectedSegment, setSelectedSegment] = useState<SegmentRow | null>(
    null,
  );
  const [members, setMembers] = useState<ListResponse<SegmentContact> | null>(
    null,
  );
  const [memberEmail, setMemberEmail] = useState("ada@example.com");

  async function loadTopic(row: TopicRow) {
    setSelectedTopic(row);
    setSubscriptions(
      (await client.get(
        `/v1/topics/${row.id}/subscriptions`,
      )) as ListResponse<TopicSubscription>,
    );
  }

  async function loadSegment(row: SegmentRow) {
    setSelectedSegment(row);
    setMembers(
      (await client.get(
        `/v1/segments/${row.id}/contacts`,
      )) as ListResponse<SegmentContact>,
    );
  }

  return (
    <div className="stack">
      <div className="tabs" aria-label="Audience sections">
        {(["contacts", "suppressions", "topics", "segments"] as const).map(
          (key) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
            >
              {key}
            </button>
          ),
        )}
      </div>

      {tab === "contacts" ? (
        <div className="stack">
          <form
            className="toolbar wrap"
            onSubmit={async (event) => {
              event.preventDefault();
              await client.post("/v1/contacts", emptyBody(contact));
              refresh();
            }}
          >
            <input
              value={contact.email}
              onChange={(event) =>
                setContact({ ...contact, email: event.target.value })
              }
            />
            <input
              value={contact.first_name}
              onChange={(event) =>
                setContact({ ...contact, first_name: event.target.value })
              }
            />
            <input
              value={contact.last_name}
              onChange={(event) =>
                setContact({ ...contact, last_name: event.target.value })
              }
            />
            <button>Create contact</button>
          </form>
          <Table
            columns={["Email", "Name", "Unsubscribed", "Created"]}
            rows={(data?.contacts.data ?? []).map((row) => [
              row.email,
              [row.first_name, row.last_name].filter(Boolean).join(" "),
              row.unsubscribed_at ? "yes" : "no",
              row.created_at,
            ])}
          />
        </div>
      ) : null}

      {tab === "suppressions" ? (
        <div className="stack">
          <form
            className="toolbar wrap"
            onSubmit={async (event) => {
              event.preventDefault();
              await client.post("/v1/suppressions", emptyBody(suppression));
              refresh();
            }}
          >
            <input
              value={suppression.email}
              onChange={(event) =>
                setSuppression({ ...suppression, email: event.target.value })
              }
            />
            <input
              value={suppression.reason}
              onChange={(event) =>
                setSuppression({ ...suppression, reason: event.target.value })
              }
            />
            <button>Suppress</button>
          </form>
          <Table
            columns={["Email", "Reason", "Created"]}
            rows={(data?.suppressions.data ?? []).map((row) => [
              row.email,
              row.reason,
              row.created_at,
            ])}
          />
        </div>
      ) : null}

      {tab === "topics" ? (
        <div className="split">
          <div className="stack">
            <form
              className="toolbar wrap"
              onSubmit={async (event) => {
                event.preventDefault();
                await client.post("/v1/topics", emptyBody(topic));
                refresh();
              }}
            >
              <input
                value={topic.name}
                onChange={(event) =>
                  setTopic({ ...topic, name: event.target.value })
                }
              />
              <input
                value={topic.key}
                onChange={(event) =>
                  setTopic({ ...topic, key: event.target.value })
                }
              />
              <select
                value={topic.default_status}
                onChange={(event) =>
                  setTopic({ ...topic, default_status: event.target.value })
                }
              >
                <option value="subscribed">subscribed</option>
                <option value="unsubscribed">unsubscribed</option>
              </select>
              <button>Create topic</button>
            </form>
            <Table
              columns={["Name", "Key", "Default", "Created"]}
              rows={(data?.topics.data ?? []).map((row) => [
                <button
                  className="link"
                  key={row.id}
                  onClick={() => loadTopic(row)}
                >
                  {row.name}
                </button>,
                row.key,
                row.default_status,
                row.created_at,
              ])}
            />
          </div>
          <Panel title="Subscriptions">
            {selectedTopic ? (
              <div className="stack">
                <form
                  className="toolbar wrap"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    await client.post(
                      `/v1/topics/${selectedTopic.id}/subscriptions`,
                      { email: subscriptionEmail, status: "subscribed" },
                    );
                    await loadTopic(selectedTopic);
                    refresh();
                  }}
                >
                  <input
                    value={subscriptionEmail}
                    onChange={(event) =>
                      setSubscriptionEmail(event.target.value)
                    }
                  />
                  <button>Subscribe</button>
                </form>
                <Table
                  columns={["Email", "Status", "Created"]}
                  rows={(subscriptions?.data ?? []).map((row) => [
                    row.email,
                    <Badge key="status" value={row.status} />,
                    row.created_at,
                  ])}
                />
              </div>
            ) : (
              <p>Select a topic.</p>
            )}
          </Panel>
        </div>
      ) : null}

      {tab === "segments" ? (
        <div className="split">
          <div className="stack">
            <form
              className="toolbar wrap"
              onSubmit={async (event) => {
                event.preventDefault();
                await client.post("/v1/segments", emptyBody(segment));
                refresh();
              }}
            >
              <input
                value={segment.name}
                onChange={(event) =>
                  setSegment({ ...segment, name: event.target.value })
                }
              />
              <input
                value={segment.description}
                onChange={(event) =>
                  setSegment({ ...segment, description: event.target.value })
                }
              />
              <button>Create segment</button>
            </form>
            <Table
              columns={["Name", "Description", "Contacts", "Created"]}
              rows={(data?.segments.data ?? []).map((row) => [
                <button
                  className="link"
                  key={row.id}
                  onClick={() => loadSegment(row)}
                >
                  {row.name}
                </button>,
                row.description ?? "",
                String(row.contacts ?? 0),
                row.created_at,
              ])}
            />
          </div>
          <Panel title="Contacts">
            {selectedSegment ? (
              <div className="stack">
                <form
                  className="toolbar wrap"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    await client.post(
                      `/v1/segments/${selectedSegment.id}/contacts`,
                      { email: memberEmail },
                    );
                    await loadSegment(selectedSegment);
                    refresh();
                  }}
                >
                  <input
                    value={memberEmail}
                    onChange={(event) => setMemberEmail(event.target.value)}
                  />
                  <button>Add contact</button>
                </form>
                <Table
                  columns={["Email", "Name", "Added"]}
                  rows={(members?.data ?? []).map((row) => [
                    row.email,
                    [row.first_name, row.last_name].filter(Boolean).join(" "),
                    row.created_at,
                  ])}
                />
              </div>
            ) : (
              <p>Select a segment.</p>
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

function Broadcasts({
  data,
  client,
  refresh,
}: {
  data?: ListResponse<BroadcastRow>;
  client: Client;
  refresh: () => void;
}) {
  const [form, setForm] = useState({
    name: "Product update",
    from: "hello@example.com",
    subject: "Dispatch update",
    text: "A short update from Dispatch.",
    html: "",
    template: "",
    variables: "{}",
    topic_id: "",
    segment_id: "",
  });
  const [detail, setDetail] = useState<BroadcastDetail | null>(null);

  async function loadBroadcast(id: string) {
    const result = (await client.get(`/v1/broadcasts/${id}`)) as {
      broadcast: BroadcastDetail;
    };
    setDetail(result.broadcast);
  }

  return (
    <div className="split">
      <div className="stack">
        <Panel title="Draft broadcast">
          <form
            className="form compact"
            onSubmit={async (event) => {
              event.preventDefault();
              await client.post("/v1/broadcasts", broadcastBody(form));
              refresh();
            }}
          >
            <label>
              Name
              <input
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
              />
            </label>
            <label>
              From
              <input
                value={form.from}
                onChange={(event) =>
                  setForm({ ...form, from: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              Subject
              <input
                value={form.subject}
                onChange={(event) =>
                  setForm({ ...form, subject: event.target.value })
                }
              />
            </label>
            <label>
              Template
              <input
                value={form.template}
                onChange={(event) =>
                  setForm({ ...form, template: event.target.value })
                }
              />
            </label>
            <label>
              Topic ID
              <input
                value={form.topic_id}
                onChange={(event) =>
                  setForm({ ...form, topic_id: event.target.value })
                }
              />
            </label>
            <label>
              Segment ID
              <input
                value={form.segment_id}
                onChange={(event) =>
                  setForm({ ...form, segment_id: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              Text
              <textarea
                value={form.text}
                onChange={(event) =>
                  setForm({ ...form, text: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              HTML
              <textarea
                value={form.html}
                onChange={(event) =>
                  setForm({ ...form, html: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              Variables JSON
              <textarea
                value={form.variables}
                onChange={(event) =>
                  setForm({ ...form, variables: event.target.value })
                }
              />
            </label>
            <button>Create draft</button>
          </form>
        </Panel>
        <Table
          columns={[
            "Name",
            "Subject",
            "Status",
            "Recipients",
            "Sent",
            "Created",
          ]}
          rows={(data?.data ?? []).map((row) => [
            <button
              className="link"
              key={row.id}
              onClick={() => loadBroadcast(row.id)}
            >
              {row.name}
            </button>,
            row.subject ?? "",
            <Badge key="status" value={row.status} />,
            String(row.recipient_count),
            String(row.sent_count),
            row.created_at,
          ])}
        />
      </div>
      <Panel title="Broadcast">
        {detail ? (
          <div className="stack">
            <dl className="facts">
              <dt>ID</dt>
              <dd>{detail.id}</dd>
              <dt>From</dt>
              <dd>{detail.from}</dd>
              <dt>Topic</dt>
              <dd>{detail.topic_id ?? "any"}</dd>
              <dt>Segment</dt>
              <dd>{detail.segment_id ?? "any"}</dd>
            </dl>
            <div className="toolbar">
              <button
                disabled={detail.status !== "draft"}
                onClick={async () => {
                  const result = (await client.post(
                    `/v1/broadcasts/${detail.id}/send`,
                    {},
                  )) as { broadcast: BroadcastDetail };
                  setDetail(result.broadcast);
                  refresh();
                }}
              >
                Send broadcast
              </button>
            </div>
            <Table
              columns={["Email", "Status", "Email ID", "Created"]}
              rows={(detail.recipients ?? []).map((row) => [
                row.email,
                <Badge key="status" value={row.status} />,
                row.email_id ?? "",
                row.created_at,
              ])}
            />
            <pre>
              {JSON.stringify(
                {
                  text: detail.text,
                  html: detail.html,
                  variables: detail.variables,
                },
                null,
                2,
              )}
            </pre>
          </div>
        ) : (
          <p>Select a broadcast.</p>
        )}
      </Panel>
    </div>
  );
}

function Automations({
  data,
  client,
  refresh,
}: {
  data?: AutomationsData;
  client: Client;
  refresh: () => void;
}) {
  const [eventForm, setEventForm] = useState({
    name: "user.signup",
    email: "ada@example.com",
    data: '{"name":"Ada"}',
  });
  const [automationForm, setAutomationForm] = useState({
    name: "Tag signup",
    trigger: "user.signup",
    steps: '[{"type":"update_contact","properties":{"source":"signup"}}]',
  });
  const [selected, setSelected] = useState<AutomationRow | null>(null);
  const [runs, setRuns] = useState<ListResponse<AutomationRunRow> | null>(null);
  const [runDetail, setRunDetail] = useState<AutomationRunDetail | null>(null);

  async function loadRuns(row: AutomationRow) {
    setSelected(row);
    setRunDetail(null);
    setRuns(
      (await client.get(
        `/v1/automations/${row.id}/runs`,
      )) as ListResponse<AutomationRunRow>,
    );
  }

  return (
    <div className="split">
      <div className="stack">
        <Panel title="Events">
          <form
            className="form compact"
            onSubmit={async (event) => {
              event.preventDefault();
              await client.post("/v1/events", {
                ...emptyBody(eventForm),
                data: parseJson(eventForm.data, {}),
              });
              refresh();
            }}
          >
            <label>
              Name
              <input
                value={eventForm.name}
                onChange={(event) =>
                  setEventForm({ ...eventForm, name: event.target.value })
                }
              />
            </label>
            <label>
              Email
              <input
                value={eventForm.email}
                onChange={(event) =>
                  setEventForm({ ...eventForm, email: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              Data JSON
              <textarea
                value={eventForm.data}
                onChange={(event) =>
                  setEventForm({ ...eventForm, data: event.target.value })
                }
              />
            </label>
            <button>Create event</button>
          </form>
        </Panel>
        <Table
          columns={["Name", "Email", "Data", "Created"]}
          rows={(data?.events.data ?? []).map((row) => [
            row.name,
            row.email ?? "",
            shortJson(row.data),
            row.created_at,
          ])}
        />
      </div>
      <div className="stack">
        <Panel title="Automations">
          <form
            className="form compact"
            onSubmit={async (event) => {
              event.preventDefault();
              await client.post("/v1/automations", {
                ...emptyBody(automationForm),
                steps: parseJson(automationForm.steps, []),
              });
              refresh();
            }}
          >
            <label>
              Name
              <input
                value={automationForm.name}
                onChange={(event) =>
                  setAutomationForm({
                    ...automationForm,
                    name: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Trigger
              <input
                value={automationForm.trigger}
                onChange={(event) =>
                  setAutomationForm({
                    ...automationForm,
                    trigger: event.target.value,
                  })
                }
              />
            </label>
            <label className="wideField">
              Steps JSON
              <textarea
                value={automationForm.steps}
                onChange={(event) =>
                  setAutomationForm({
                    ...automationForm,
                    steps: event.target.value,
                  })
                }
              />
            </label>
            <button>Create automation</button>
          </form>
        </Panel>
        <Table
          columns={["Name", "Trigger", "Enabled", "Steps", "Created"]}
          rows={(data?.automations.data ?? []).map((row) => [
            <button className="link" key={row.id} onClick={() => loadRuns(row)}>
              {row.name}
            </button>,
            row.trigger,
            row.enabled ? "yes" : "no",
            String(row.steps.length),
            row.created_at,
          ])}
        />
        <Panel title="Runs">
          {selected ? (
            <div className="stack">
              <div className="toolbar">
                <button onClick={() => loadRuns(selected)}>Refresh runs</button>
              </div>
              <Table
                columns={["Event", "Email", "State", "Created"]}
                rows={(runs?.data ?? []).map((row) => [
                  <button
                    className="link"
                    key={row.id}
                    onClick={async () =>
                      setRunDetail(
                        (
                          (await client.get(
                            `/v1/automation-runs/${row.id}`,
                          )) as { run: AutomationRunDetail }
                        ).run,
                      )
                    }
                  >
                    {row.event_name}
                  </button>,
                  row.email ?? "",
                  <Badge key="state" value={row.state} />,
                  row.created_at,
                ])}
              />
              <pre>{runDetail ? JSON.stringify(runDetail, null, 2) : ""}</pre>
            </div>
          ) : (
            <p>Select an automation.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Inbound({
  data,
  client,
  refresh,
}: {
  data?: ListResponse<ReceivedEmailRow>;
  client: Client;
  refresh: () => void;
}) {
  const [form, setForm] = useState({
    from: "sender@example.net",
    to: "inbound@example.com",
    cc: "",
    bcc: "",
    subject: "Inbound local test",
    text: "This received email was simulated locally.",
    html: "",
    headers: "{}",
  });
  const [detail, setDetail] = useState<ReceivedEmailDetail | null>(null);
  return (
    <div className="split">
      <div className="stack">
        <Panel title="Simulate inbound">
          <form
            className="form compact"
            onSubmit={async (event) => {
              event.preventDefault();
              await client.post(
                "/v1/received-emails/simulate",
                inboundBody(form),
              );
              refresh();
            }}
          >
            <label>
              From
              <input
                value={form.from}
                onChange={(event) =>
                  setForm({ ...form, from: event.target.value })
                }
              />
            </label>
            <label>
              To
              <input
                value={form.to}
                onChange={(event) =>
                  setForm({ ...form, to: event.target.value })
                }
              />
            </label>
            <label>
              CC
              <input
                value={form.cc}
                onChange={(event) =>
                  setForm({ ...form, cc: event.target.value })
                }
              />
            </label>
            <label>
              BCC
              <input
                value={form.bcc}
                onChange={(event) =>
                  setForm({ ...form, bcc: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              Subject
              <input
                value={form.subject}
                onChange={(event) =>
                  setForm({ ...form, subject: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              Text
              <textarea
                value={form.text}
                onChange={(event) =>
                  setForm({ ...form, text: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              HTML
              <textarea
                value={form.html}
                onChange={(event) =>
                  setForm({ ...form, html: event.target.value })
                }
              />
            </label>
            <label className="wideField">
              Headers JSON
              <textarea
                value={form.headers}
                onChange={(event) =>
                  setForm({ ...form, headers: event.target.value })
                }
              />
            </label>
            <button>Simulate</button>
          </form>
        </Panel>
        <Table
          columns={["Subject", "From", "To", "Created"]}
          rows={(data?.data ?? []).map((row) => [
            <button
              className="link"
              key={row.id}
              onClick={async () =>
                setDetail(
                  (
                    (await client.get(`/v1/received-emails/${row.id}`)) as {
                      received_email: ReceivedEmailDetail;
                    }
                  ).received_email,
                )
              }
            >
              {row.subject}
            </button>,
            row.from,
            row.to?.join(", ") ?? "",
            row.created_at,
          ])}
        />
      </div>
      <Panel title="Received email">
        {detail ? (
          <div className="stack">
            <dl className="facts">
              <dt>Request</dt>
              <dd>{detail.request_id}</dd>
              <dt>From</dt>
              <dd>{detail.from}</dd>
              <dt>Subject</dt>
              <dd>{detail.subject}</dd>
            </dl>
            <Table
              columns={["Recipient", "Kind", "Created"]}
              rows={(detail.recipients ?? []).map((row) => [
                row.email,
                row.kind,
                row.created_at,
              ])}
            />
            <Table
              columns={["Attachment", "Type", "Size", "Created"]}
              rows={(detail.attachments ?? []).map((row) => [
                row.filename,
                row.content_type,
                `${row.size_bytes} bytes`,
                row.created_at,
              ])}
            />
            <pre>
              {JSON.stringify(
                {
                  text: detail.text,
                  html: detail.html,
                  headers: detail.headers,
                },
                null,
                2,
              )}
            </pre>
          </div>
        ) : (
          <p>Select a received email.</p>
        )}
      </Panel>
    </div>
  );
}

function Webhooks({
  data,
  client,
  refresh,
}: {
  data?: ListResponse<WebhookRow>;
  client: Client;
  refresh: () => void;
}) {
  const [url, setUrl] = useState("http://localhost:8787/webhooks");
  const [selected, setSelected] = useState<WebhookRow | null>(null);
  const [attempts, setAttempts] = useState<ListResponse<Attempt> | null>(null);
  return (
    <div className="split">
      <div>
        <div className="toolbar">
          <input value={url} onChange={(event) => setUrl(event.target.value)} />
          <button
            onClick={async () => {
              await client.post("/v1/webhooks", {
                url,
                events: ["email.sent", "email.delivered", "email.failed"],
              });
              refresh();
            }}
          >
            Add webhook
          </button>
          <button
            onClick={async () => {
              await client.post("/v1/webhooks/test", {});
              refresh();
            }}
          >
            Test webhook
          </button>
        </div>
        <Table
          columns={["URL", "Events", "Enabled", "Created"]}
          rows={(data?.data ?? []).map((webhook) => [
            <button
              className="link"
              key={webhook.id}
              onClick={async () => {
                setSelected(webhook);
                setAttempts(
                  (await client.get(
                    `/v1/webhooks/${webhook.id}/attempts`,
                  )) as ListResponse<Attempt>,
                );
              }}
            >
              {webhook.url}
            </button>,
            webhook.events.join(", "),
            webhook.enabled ? "yes" : "no",
            webhook.created_at,
          ])}
        />
      </div>
      <Panel title="Attempts">
        {selected ? (
          <>
            <div className="toolbar">
              <button
                onClick={async () => {
                  const result = (await client.patch(
                    `/v1/webhooks/${selected.id}`,
                    { enabled: !selected.enabled },
                  )) as { webhook: WebhookRow };
                  setSelected(result.webhook);
                  refresh();
                }}
              >
                {selected.enabled ? "Disable" : "Enable"}
              </button>
              <button
                onClick={async () =>
                  setAttempts(
                    (await client.get(
                      `/v1/webhooks/${selected.id}/attempts`,
                    )) as ListResponse<Attempt>,
                  )
                }
              >
                Refresh
              </button>
              <button
                onClick={async () => {
                  await client.post(`/v1/webhooks/${selected.id}/replay`, {});
                  setAttempts(
                    (await client.get(
                      `/v1/webhooks/${selected.id}/attempts`,
                    )) as ListResponse<Attempt>,
                  );
                }}
              >
                Replay failed
              </button>
              <button
                onClick={async () => {
                  await client.delete(`/v1/webhooks/${selected.id}`);
                  setSelected(null);
                  setAttempts(null);
                  refresh();
                }}
              >
                Delete
              </button>
            </div>
            <Table
              columns={["State", "Attempt", "Status", "Created"]}
              rows={(attempts?.data ?? []).map((attempt) => [
                <Badge key="state" value={attempt.state} />,
                String(attempt.attempt),
                String(attempt.status ?? attempt.error ?? ""),
                attempt.created_at,
              ])}
            />
          </>
        ) : (
          <p>Select a webhook.</p>
        )}
      </Panel>
    </div>
  );
}

function Logs({ data }: { data?: ListResponse<LogRow> }) {
  return (
    <Table
      columns={["Method", "Path", "Status", "Latency", "Request"]}
      rows={(data?.data ?? []).map((log) => [
        log.method,
        log.path,
        String(log.status),
        `${log.latency_ms}ms`,
        log.request_id,
      ])}
    />
  );
}

function Timeline({ data }: { data?: ListResponse<TimelineRow> }) {
  return (
    <Table
      columns={["Kind", "Name", "Summary", "Request", "Created"]}
      rows={(data?.data ?? []).map((row) => [
        row.kind,
        <span className="badge" key="name">{row.name}</span>,
        row.summary,
        row.request_id ?? "",
        row.created_at,
      ])}
    />
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <article className="panel">
      <h2>{title}</h2>
      {children}
    </article>
  );
}

function Status({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className={ok ? "status ok" : "status"}>
      <CheckCircle2 size={18} />
      <span>{text}</span>
    </div>
  );
}

function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{value}</span>;
}

function Table({
  columns,
  rows,
}: {
  columns: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Client = ReturnType<typeof makeClient>;

function makeClient(apiUrl: string, apiKey: string) {
  async function request(path: string, options: RequestInit & { auth?: boolean } = {}) {
    const headers = new Headers(options.headers);
    if (options.auth !== false) headers.set("authorization", `Bearer ${apiKey}`);
    if (options.body) headers.set("content-type", "application/json");
    const { auth: _auth, ...init } = options;
    const response = await fetch(`${apiBase(apiUrl)}${path}`, { ...init, headers });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(json?.message ?? response.statusText);
    return json;
  }

  return {
    get: (path: string) => request(path),
    post: (path: string, body: unknown) =>
      request(path, { method: "POST", body: JSON.stringify(body) }),
    publicPost: (path: string, body: unknown) =>
      request(path, { method: "POST", body: JSON.stringify(body), auth: false }),
    patch: (path: string, body: unknown) =>
      request(path, { method: "PATCH", body: JSON.stringify(body) }),
    delete: (path: string) => request(path, { method: "DELETE" }),
    send: (body: Record<string, unknown>) =>
      request("/v1/emails", { method: "POST", body: JSON.stringify(body) }),
    setup: () =>
      fetch(`${apiBase(apiUrl)}/v1/setup`).then((response) => response.json()),
  };
}

function apiBase(value: string) {
  const url = new URL(value, window.location.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const sameOrigin = url.origin === window.location.origin;
  if (!["http:", "https:"].includes(url.protocol) || (!local && !sameOrigin && import.meta.env.VITE_ALLOW_REMOTE_API !== "true")) {
    throw new Error("API URL is not allowed");
  }
  return url.origin;
}

async function loadView(view: View, client: Client) {
  if (view === "setup") return client.setup();
  if (view === "identity") {
    const [users, roles, memberships, sessions, audit] = await Promise.all([
      client.get("/v1/users"),
      client.get("/v1/roles"),
      client.get("/v1/memberships"),
      client.get("/v1/sessions"),
      client.get("/v1/audit-logs"),
    ]);
    return { users, roles, memberships, sessions, audit };
  }
  if (view === "domains") return client.get("/v1/domains");
  if (view === "keys") return client.get("/v1/api-keys");
  if (view === "emails") return client.get("/v1/emails");
  if (view === "templates") return client.get("/v1/templates");
  if (view === "audience") {
    const [contacts, suppressions, topics, segments] = await Promise.all([
      client.get("/v1/contacts"),
      client.get("/v1/suppressions"),
      client.get("/v1/topics"),
      client.get("/v1/segments"),
    ]);
    return { contacts, suppressions, topics, segments };
  }
  if (view === "broadcasts") return client.get("/v1/broadcasts");
  if (view === "automations") {
    const [automations, events] = await Promise.all([
      client.get("/v1/automations"),
      client.get("/v1/events"),
    ]);
    return { automations, events };
  }
  if (view === "inbound") return client.get("/v1/received-emails");
  if (view === "webhooks") return client.get("/v1/webhooks");
  if (view === "timeline") return client.get("/v1/timeline");
  if (view === "logs") return client.get("/v1/logs");
  return {};
}

function title(view: View) {
  const titles: Record<View, string> = {
    setup: "Setup",
    identity: "Identity",
    domains: "Domains",
    keys: "Keys",
    send: "Send",
    emails: "Emails",
    templates: "Templates",
    audience: "Audience",
    broadcasts: "Broadcasts",
    automations: "Automations / Events",
    inbound: "Inbound",
    webhooks: "Webhooks",
    timeline: "Timeline",
    logs: "Logs",
  };
  return titles[view];
}

function sendBody(form: Record<string, string>) {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    if (!value.trim()) continue;
    if (key === "headers" || key === "tags") {
      body[key] = JSON.parse(value);
    } else if (key === "to" || key === "cc" || key === "bcc") {
      body[key] = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      body[key] = value;
    }
  }
  return body;
}

function templateBody(form: Record<string, string>) {
  return { ...emptyBody(form), variables: csv(form.variables) };
}

function broadcastBody(form: Record<string, string>) {
  return { ...emptyBody(form), variables: parseJson(form.variables, {}) };
}

function inboundBody(form: Record<string, string>) {
  const body: Record<string, unknown> = {
    ...emptyBody(form),
    to: csv(form.to),
    headers: parseJson(form.headers, {}),
  };
  const cc = csv(form.cc);
  const bcc = csv(form.bcc);
  if (cc.length) body.cc = cc;
  if (bcc.length) body.bcc = bcc;
  return body;
}

function emptyBody(form: Record<string, string>) {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    if (value.trim()) body[key] = value;
  }
  return body;
}

function csv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJson<T>(value: string, fallback: T): T {
  return value.trim() ? (JSON.parse(value) as T) : fallback;
}

function shortJson(value: unknown) {
  const text = JSON.stringify(value ?? {});
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

createRoot(document.getElementById("root")!).render(<App />);
