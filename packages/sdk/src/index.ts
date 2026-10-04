import { render } from "./render.js";
import { verifyWebhook, type VerifyInput } from "./verify.js";

export { WebhookVerificationError, verifyWebhook, type VerifyInput, type WebhookHeaders } from "./verify.js";

const version = "0.1.0";

export type ClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  userAgent?: string;
};

export type ErrorBody = { name: string; statusCode: number | null; message: string };
export type Result<T> = ({ data: T; error: null } | { data: null; error: ErrorBody }) & {
  headers: Record<string, string> | null;
};
export type Page = { limit?: number } & ({ after?: string; before?: never } | { before?: string; after?: never });
export type List<T = Row> = { object: "list"; has_more: boolean; data: T[] };
export type Row = { id: string; object?: string; [key: string]: unknown };
export type ContactActivity = Row & {
  object: "contact_activity";
  type: string;
  resource_id: string | null;
  label: string | null;
  email_id: string | null;
  automation_id?: string | null;
  run_id?: string | null;
  exit_reason?: AutomationExitReason | null;
  created_at: string;
};
export type Deleted = { object: string; id: string; deleted: true };

export type EmailRecipient = {
  id?: string;
  email: string;
  kind: "to" | "cc" | "bcc";
  status: string;
  sandbox: boolean;
  created_at?: string;
};
export type Email = Row & {
  /** True only when every original recipient is sandbox; no email is sent externally. */
  sandbox: boolean;
  last_event: string;
  recipients: EmailRecipient[];
};
export type EmailDetail = Email;

type Body = Record<string, unknown>;
type CallOptions = { idempotencyKey?: string; headers?: Record<string, string>; auth?: boolean };
type Ref = { id?: string; contactId?: string; email?: string };

export type Attachment = {
  filename: string;
  content?: string;
  path?: string;
  contentType?: string;
  contentId?: string;
  disposition?: "attachment" | "inline";
};

export type Tag = { name: string; value: string };

export type SendOptions = {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | string[];
  subject?: string;
  html?: string;
  text?: string;
  react?: unknown;
  attachments?: Attachment[];
  template?: string | { id: string; variables?: Record<string, unknown> };
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  tags?: Tag[] | Record<string, string>;
  topicId?: string;
  scheduledAt?: string;
};

export type BatchOptions = Omit<SendOptions, "attachments">;

export type EmailUpdate = {
  id: string;
  scheduledAt?: string | null;
  subject?: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  tags?: Tag[] | Record<string, string>;
};

export type MetricsOptions = {
  startDate?: string;
  endDate?: string;
  timezone?: string;
  granularity?: "hourly" | "daily" | "weekly" | "monthly";
  metrics?: string[];
  dimensions?: string[];
  domainId?: string[];
  emailId?: string[];
  broadcastId?: string[];
  automationId?: string[];
};

export type DomainCreate = {
  name: string;
  region?: string;
  customReturnPath?: string;
  openTracking?: boolean;
  clickTracking?: boolean;
  trackingSubdomain?: string;
  tls?: "opportunistic" | "enforced";
  capabilities?: { sending?: "enabled" | "disabled"; receiving?: "enabled" | "disabled" };
};

export type DomainUpdate = { id: string } & Partial<Omit<DomainCreate, "name" | "region" | "customReturnPath">>;

export type ApiKeyCreate = {
  name: string;
  permission?: "full_access" | "sending_access";
  scope?: "full" | "send";
  domainId?: string;
};

export type LifecycleEventType = "email.unsubscribed" | "automation.run.started" | "automation.run.completed" | "automation.run.failed";
export type AutomationRunEvent = {
  automation_id: string;
  run_id: string;
  contact_id: string | null;
  state: string;
  exit_reason: AutomationExitReason | null;
};

export type WebhookCreate = {
  endpoint?: string;
  url?: string;
  events?: string[];
  status?: "enabled" | "disabled";
  enabled?: boolean;
};

export type TemplateVariable = { key: string; type?: "string" | "number" | "list"; fallbackValue?: string | number | null };

export type SendKind = "transactional" | "marketing";
export type Template = Row & {
  /** Derived from library source.send_kind or unsubscribe placeholders in the content. */
  kind: SendKind;
};

export type TemplateCreate = {
  name: string;
  alias?: string;
  from?: string;
  replyTo?: string | string[];
  subject?: string;
  html?: string;
  text?: string;
  react?: unknown;
  variables?: Array<string | TemplateVariable>;
  publish?: boolean;
  source?: { kind: string; path?: string; slug?: string; version?: string; send_kind?: SendKind };
};

export type TemplateUpdate = Partial<Omit<TemplateCreate, "alias" | "html" | "text">> & {
  alias?: string | null;
  html?: string | null;
  text?: string | null;
};

export type TemplateVersion = Omit<TemplateCreate, "name" | "alias" | "publish">;

export type ContactCreate = {
  email: string;
  firstName?: string;
  lastName?: string;
  properties?: Record<string, unknown>;
  unsubscribed?: boolean;
  segments?: Array<{ id: string }>;
  topics?: Array<{ id: string; subscription?: "opt_in" | "opt_out" }>;
};

export type ContactUpdate = ({ id: string; email?: never } | { email: string; id?: never }) & {
  firstName?: string | null;
  lastName?: string | null;
  properties?: Record<string, unknown>;
  unsubscribed?: boolean;
};

export type PropertyType = "string" | "number" | "boolean" | "date";
/** Dates are ISO strings; null clears a fallback. */
export type PropertyValue = string | number | boolean | null;
export type ContactProperty = Row & {
  object: "contact_property";
  key: string;
  type: PropertyType;
  fallback_value: PropertyValue;
};
export type ContactPropertyCreate = { key: string; type?: PropertyType; fallbackValue?: PropertyValue };
export type ImportColumn = { column: string; type?: PropertyType };
/** Nested column-map keys use the API's snake_case names. */
export type ImportColumnMap = {
  email?: ImportColumn;
  first_name?: ImportColumn | null;
  last_name?: ImportColumn | null;
  unsubscribed?: ImportColumn | null;
  properties?: Record<string, ImportColumn>;
};

export type ContactImport = {
  file: Blob | string;
  filename?: string;
  // Sent as given. The API's keys are snake_case: { email: { column }, first_name: { column }, properties: { key: { column, type } } }.
  columnMap?: ImportColumnMap | Record<string, unknown>;
  onConflict?: "upsert" | "skip";
  segments?: Array<{ id: string }>;
  topics?: Array<{ id: string; subscription?: "opt_in" | "opt_out" }>;
  /** Omit to use the tenant default, resolved and stored when the import is created. */
  triggerAutomations?: boolean;
};

export type ContactImportResult = Row & {
  object: "contact_import";
  trigger_automations: boolean;
};

export type TopicCreate = {
  name: string;
  key?: string;
  description?: string;
  visibility?: "public" | "private";
  defaultSubscription?: "opt_in" | "opt_out";
};

export type BroadcastCreate = {
  name?: string;
  from: string;
  subject?: string;
  replyTo?: string | string[];
  previewText?: string;
  html?: string;
  text?: string;
  react?: unknown;
  template?: string;
  variables?: Record<string, unknown>;
  segmentId?: string;
  topicId?: string;
  scheduledAt?: string;
  send?: boolean;
  [key: string]: unknown;
};

export type RecipientType = "sent" | "delivered" | "opened" | "clicked" | "bounced" | "complained" | "unsubscribed" | "suppressed";

export type Operator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains" | "starts_with" | "ends_with" | "within" | "not_within" | "exists" | "is_empty";
export type Rule =
  | { type: "rule"; field: string; operator: Operator; value?: unknown }
  | { type: "and" | "or"; rules: Rule[] };

export type StepType = "trigger" | "send_email" | "delay" | "wait_for_event" | "condition" | "add_to_segment" | "contact_update" | "contact_delete" | "exit" | "filter" | "branch";
export type ConnectionType = "default" | "condition_met" | "condition_not_met" | "timeout" | "event_received" | "branch";
export type ExitConfig = Record<string, never>;
/** next tests once; following also saves a guard checked before every later step. */
export type FilterConfig = { rule: Rule; scope: "next" | "following" };
export type BranchPath = { key: string; label: string; rule: Rule };
/** Two to ten ordered paths, with unique nonempty keys other than "otherwise". */
export type BranchConfig = { paths: BranchPath[] };
export type AutomationConnection = {
  from: string;
  to: string;
  type?: string;
  /** Required only for type branch: a configured path key or "otherwise". */
  path?: string;
};
export type AutomationExitReason = "completed" | "exit" | "filter" | "stopped" | "stranded";
export type AutomationGuard = { filter: string; rule: Rule };
export type AutomationRun = Row & {
  object: "automation_run";
  automation_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  exit_reason: AutomationExitReason | null;
  guards: AutomationGuard[];
  event: { id: string; name: string; email: string | null };
  error: string | null;
  created_at: string;
  updated_at: string;
};
export type AutomationRunDetail = AutomationRun & {
  event: AutomationRun["event"] & { payload: Record<string, unknown> };
  steps: Array<{
    key: string;
    type: StepType;
    status: string;
    started_at: string | null;
    completed_at: string | null;
    output: Record<string, unknown>;
    error: string | null;
  }>;
};
/** Step config keys are sent as given, using snake_case. Variables stay literal. */
export type SendEmailConfig = {
  template: string | { id: string; variables?: Record<string, unknown> };
  /** Omit for legacy topic_id inference. Marketing drafts may omit topic_id, but cannot run. */
  kind?: SendKind;
  from?: string;
  to?: string;
  subject?: string;
  reply_to?: string | string[];
  topic_id?: string;
  variables?: Record<string, unknown>;
  variable_mapping?: Record<string, string>;
};

/** Dates are ISO strings; transition values retain their JSON primitive types. */
export type AutomationTriggerConfig =
  | { type: "event"; event_name: string }
  | { type: "contact_created" }
  | { type: "contact_updated"; field?: string; from?: PropertyValue; to?: PropertyValue }
  | { type: "topic_subscribed"; topic_id: string }
  | { type: "segment_added"; segment_id: string };

export type AutomationReentry = "once" | "every_time";
export type AutomationStatus = "enabled" | "paused" | "disabled";

export type AutomationDryRun = {
  stranded_runs: number;
  by_step: Record<string, number>;
};

export type AutomationEnrollment = { segmentId: string; all?: never } | { all: true; segmentId?: never };

export type AutomationEnrollmentJob = {
  object: "automation_enrollment_job";
  id: string;
  automation_id: string;
  segment_id: string | null;
  status: "queued" | "in_progress" | "completed" | "failed" | "cancelled";
  counts: { total: number; processed: number; enrolled: number; skipped: number; failed: number };
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

export type Automation = Row & {
  status: AutomationStatus;
  readonly version: number;
  trigger: string | null;
  trigger_config: AutomationTriggerConfig;
  reentry: AutomationReentry;
};

export type AutomationCreate = {
  name: string;
  status?: "enabled" | "disabled";
  enabled?: boolean;
  version?: never;
  steps: Array<Record<string, unknown>>;
  connections?: AutomationConnection[];
  trigger?: string;
  reentry?: AutomationReentry;
  [key: string]: unknown;
};

export type AutomationUpdate = {
  name?: string;
  /** Pause holds runs; enabling resumes them; disabling stops them. */
  status?: AutomationStatus;
  enabled?: boolean;
  version?: never;
  steps?: Array<Record<string, unknown>>;
  connections?: AutomationConnection[];
  trigger?: string;
  reentry?: AutomationReentry;
  [key: string]: unknown;
};

export type EventSend = ({ contactId: string; email?: never } | { email: string; contactId?: never }) & {
  event: string;
  payload?: Record<string, unknown>;
};

export type EventSchema = Record<string, "string" | "number" | "boolean" | "date">;

export type LibraryStage = "acquisition" | "onboarding" | "retention" | "reengagement" | "dunning" | "reactivation";

/** Read-only library definition. Template references are library slugs, not tenant IDs. */
export type AutomationPreset = {
  slug: string;
  name: string;
  stage: LibraryStage;
  description: string;
  when: string;
  /** Newsletter topic_id is the {{topic_id}} install placeholder. */
  trigger_config: AutomationTriggerConfig;
  reentry: AutomationReentry;
  events: Array<{ name: string; schema: EventSchema }>;
  properties: Array<{ key: string; type: PropertyType }>;
  steps: Array<{ key: string; type: StepType; config: Record<string, unknown> }>;
  connections: Array<{ from: string; to: string; type: ConnectionType; path?: string }>;
  templates: string[];
};

export type AutomationPresetDetail = AutomationPreset & { object: "automation_preset" };

const seg = encodeURIComponent;

function snake(key: string) {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

// Maps camelCase keys to the API's snake_case. Only the top level and attachment
// objects are mapped, so user data under variables, properties, headers, and
// payload keeps its keys.
export function wire(input: object): Body {
  const out: Body = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out[snake(key)] = nested(key, value);
  }
  return out;
}

// Attachments, and template variable declarations (a list of { key, type, fallbackValue }),
// are objects the SDK defines, so their keys are converted too. A variables record on a send
// is the caller's own data and is left as it is, like properties, headers, and payloads.
function nested(key: string, value: unknown) {
  if (!Array.isArray(value)) return value;
  if (key === "attachments") return value.map((item) => wire(item));
  if (key === "variables") return value.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? wire(item) : item));
  return value;
}

function query(params: object = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    const name = snake(key);
    if (Array.isArray(value)) for (const item of value) search.append(name, String(item));
    else search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function content<T extends { react?: unknown }>(input: T): Promise<Omit<T, "react">> {
  const { react, ...rest } = input;
  if (react === undefined || react === null) return rest;
  return { ...rest, html: await render(react) };
}

function contactRef(input: Ref) {
  const ref = input.id ?? input.contactId ?? input.email;
  return ref ? seg(ref) : null;
}

// Mirrors resend-node: a missing identifier comes back as an error result, not a throw.
async function missing<T>(field: string): Promise<Result<T>> {
  return { data: null, error: { name: "missing_required_field", statusCode: null, message: `Missing \`${field}\` field.` }, headers: null };
}

function env(name: string) {
  return typeof process === "undefined" ? undefined : process.env[name];
}

export class Dispatch {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  readonly emails = new Emails(this);
  readonly batch = new Batch(this);
  readonly domains = new Domains(this);
  readonly apiKeys = new ApiKeys(this);
  readonly webhooks = new Webhooks(this);
  readonly templates = new Templates(this);
  readonly contacts = new Contacts(this);
  readonly contactProperties = new ContactProperties(this);
  readonly segments = new Segments(this);
  readonly topics = new Topics(this);
  readonly suppressions = new Suppressions(this);
  readonly broadcasts = new Broadcasts(this);
  readonly automations = new Automations(this);
  readonly events = new Events(this);
  readonly logs = new Logs(this);
  readonly brand = new Brand(this);
  readonly settings = new Settings(this);
  readonly usage = new Single(this, "/usage");
  readonly system = new Single(this, "/system");
  // Sent with the key. Where public setup is on the route ignores it, and in production the route needs it.
  readonly setup = new Single(this, "/setup");
  readonly me = new Single(this, "/me");
  readonly timeline = new Timeline(this);
  readonly auditLogs = new AuditLogs(this);
  readonly users = new Members(this, "/users");
  readonly roles = new Members(this, "/roles");
  readonly memberships = new Memberships(this);
  readonly sessions = new Sessions(this);
  readonly links = new Links(this);

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env("DISPATCH_API_KEY");
    if (!apiKey) throw new Error("Missing API key. Pass `apiKey` or set DISPATCH_API_KEY.");
    this.apiKey = apiKey;
    // DISPATCH_API_URL is the name the CLI uses. Either works here.
    this.baseUrl = (options.baseUrl ?? env("DISPATCH_BASE_URL") ?? env("DISPATCH_API_URL") ?? "http://localhost:3100").replace(/\/$/, "");
    this.userAgent = options.userAgent ?? env("DISPATCH_USER_AGENT") ?? `dispatch-node:${version}`;
  }

  health() {
    return this.call<{ ok: boolean; [key: string]: unknown }>("GET", "/health", undefined, { auth: false });
  }

  async call<T>(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<Result<T>> {
    const headers = new Headers({ "user-agent": this.userAgent });
    if (options.auth !== false) headers.set("authorization", `Bearer ${this.apiKey}`);
    const form = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !form) headers.set("content-type", "application/json");
    if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
    for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body)
      });
      const parsed = (await response.json().catch(() => null)) as unknown;
      // Only an object body is spread into the error. A string or array body would otherwise
      // turn into numbered keys.
      const json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      const out = Object.fromEntries(response.headers.entries());
      if (!response.ok) {
        const error = {
          ...json,
          name: typeof json?.name === "string" ? json.name : "application_error",
          statusCode: typeof json?.statusCode === "number" ? json.statusCode : response.status,
          message: typeof json?.message === "string" ? json.message : response.statusText
        };
        return { data: null, error, headers: out };
      }
      return { data: (json ?? parsed) as T, error: null, headers: out };
    } catch {
      return {
        data: null,
        error: {
          name: "application_error",
          statusCode: null,
          message: "Unable to fetch data. The request could not be resolved."
        },
        headers: null
      };
    }
  }
}

class Resource {
  constructor(protected readonly client: Dispatch) {}
}

class EmailAttachments extends Resource {
  list({ emailId, ...page }: { emailId: string } & Page) {
    return this.client.call<List>("GET", `/emails/${seg(emailId)}/attachments${query(page)}`);
  }

  get({ emailId, id }: { emailId: string; id: string }) {
    return this.client.call<Row>("GET", `/emails/${seg(emailId)}/attachments/${seg(id)}`);
  }
}

class ReceivedAttachments extends Resource {
  list({ emailId, ...page }: { emailId: string } & Page) {
    return this.client.call<List>("GET", `/emails/receiving/${seg(emailId)}/attachments${query(page)}`);
  }

  get({ emailId, id }: { emailId: string; id: string }) {
    return this.client.call<Row>("GET", `/emails/receiving/${seg(emailId)}/attachments/${seg(id)}`);
  }
}

class Receiving extends Resource {
  readonly attachments = new ReceivedAttachments(this.client);

  list(page: Page = {}) {
    return this.client.call<List>("GET", `/emails/receiving${query(page)}`);
  }

  get(id: string, options: { htmlFormat?: "data_uri" | "cid" } = {}) {
    return this.client.call<Row>("GET", `/emails/receiving/${seg(id)}${query(options)}`);
  }

  // No server route. Fetch the received email and its attachments, then send them through
  // POST /emails. The HTML keeps its `cid:` references and the inline images travel as inline
  // attachments. Inlining them as data URIs can push the HTML past the 1 MB limit, and Gmail
  // and Outlook do not show data images.
  async forward(
    input: { emailId: string; to: string | string[]; from: string },
    options: { idempotencyKey?: string } = {}
  ): Promise<Result<{ id: string }>> {
    const received = await this.get(input.emailId, { htmlFormat: "cid" });
    if (received.error) return { data: null, error: received.error, headers: received.headers };
    const email = received.data as { subject?: string | null; html?: string | null; text?: string | null };
    const files = await this.files(input.emailId);
    if (files.error) return { data: null, error: files.error, headers: files.headers };
    const subject = email.subject || "(no subject)";
    return this.client.emails.send(
      {
        from: input.from,
        to: input.to,
        subject: /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`,
        html: email.html ?? undefined,
        text: email.text ?? undefined,
        ...(files.data.length ? { attachments: files.data } : {})
      },
      options
    );
  }

  // A received email's attachments, downloaded through their signed URLs.
  private async files(emailId: string): Promise<Result<Attachment[]>> {
    const listed = await this.attachments.list({ emailId, limit: 100 });
    if (listed.error) return { data: null, error: listed.error, headers: listed.headers };
    const out: Attachment[] = [];
    for (const item of listed.data.data ?? []) {
      const file = item as { filename?: string; content_type?: string; content_id?: string | null; download_url?: string };
      if (!file.download_url) continue;
      const name = file.filename || "attachment";
      let response: Response | undefined;
      try {
        response = await fetch(file.download_url);
      } catch {
        response = undefined;
      }
      if (!response?.ok) {
        return {
          data: null,
          error: { name: "application_error", statusCode: response?.status ?? null, message: `Could not download the attachment ${name}` },
          headers: null
        };
      }
      out.push({
        filename: name,
        content: Buffer.from(await response.arrayBuffer()).toString("base64"),
        ...(file.content_type ? { contentType: file.content_type } : {}),
        ...(file.content_id ? { contentId: file.content_id } : {})
      });
    }
    return { data: out, error: null, headers: listed.headers };
  }

  simulate(payload: Body) {
    return this.client.call<Row>("POST", "/emails/receiving/simulate", wire(payload));
  }
}

class EmailJobs extends Resource {
  list(page: Page & { emailId?: string; email_id?: string } = {}) {
    return this.client.call<List>("GET", `/email-jobs${query(page)}`);
  }

  get(id: string) {
    return this.client.call<Row>("GET", `/email-jobs/${seg(id)}`);
  }
}

export type SendResult = { id: string; sandbox: boolean; emails?: Array<{ id: string; to: string; sandbox: boolean }> };

class Emails extends Resource {
  readonly attachments = new EmailAttachments(this.client);
  readonly receiving = new Receiving(this.client);
  readonly jobs = new EmailJobs(this.client);

  async send(payload: SendOptions, options: { idempotencyKey?: string } = {}) {
    return this.client.call<SendResult>("POST", "/emails", wire(await content(payload)), options);
  }

  create(payload: SendOptions, options: { idempotencyKey?: string } = {}) {
    return this.send(payload, options);
  }

  get(id: string) {
    return this.client.call<EmailDetail>("GET", `/emails/${seg(id)}`);
  }

  list(page: Page & { status?: string; from?: string; to?: string; q?: string; api_key_id?: string } = {}) {
    return this.client.call<List<Email>>("GET", `/emails${query(page)}`);
  }

  update({ id, ...payload }: EmailUpdate) {
    return this.client.call<{ object: "email"; id: string }>("PATCH", `/emails/${seg(id)}`, wire(payload));
  }

  cancel(id: string) {
    return this.client.call<{ object: "email"; id: string }>("POST", `/emails/${seg(id)}/cancel`, {});
  }

  share(id: string, options: { expiresIn?: string } = {}) {
    return this.client.call<{ object: "email"; id: string; url: string }>("POST", `/emails/${seg(id)}/share`, wire(options));
  }

  metrics(options: MetricsOptions = {}) {
    return this.client.call<Row>("GET", `/emails/metrics${query(options)}`);
  }

  retry(id: string) {
    return this.client.call<{ job: Row }>("POST", `/emails/${seg(id)}/retry`, {});
  }

  insights(id: string) {
    return this.client.call<Record<string, unknown>>("GET", `/emails/${seg(id)}/insights`);
  }

  events(id: string, page: Page = {}) {
    return this.client.call<List>("GET", `/emails/${seg(id)}/events${query(page)}`);
  }
}

class Batch extends Resource {
  async send(
    payload: BatchOptions[] | { emails: BatchOptions[] },
    options: { idempotencyKey?: string; batchValidation?: "strict" | "permissive" } = {}
  ) {
    const emails = Array.isArray(payload) ? payload : payload.emails;
    const body = [];
    for (const email of emails) body.push(wire(await content(email)));
    return this.client.call<{ data: SendResult[]; errors?: Array<{ index: number; message: string }> }>(
      "POST",
      "/emails/batch",
      body,
      {
        idempotencyKey: options.idempotencyKey,
        headers: options.batchValidation ? { "x-batch-validation": options.batchValidation } : undefined
      }
    );
  }

  create(
    payload: BatchOptions[] | { emails: BatchOptions[] },
    options: { idempotencyKey?: string; batchValidation?: "strict" | "permissive" } = {}
  ) {
    return this.send(payload, options);
  }
}

class Domains extends Resource {
  create(payload: DomainCreate) {
    return this.client.call<Row>("POST", "/domains", wire(payload));
  }

  list(page: Page & { q?: string; status?: string; region?: string } = {}) {
    return this.client.call<List>("GET", `/domains${query(page)}`);
  }

  get(id: string) {
    return this.client.call<Row>("GET", `/domains/${seg(id)}`);
  }

  update({ id, ...payload }: DomainUpdate) {
    return this.client.call<Row>("PATCH", `/domains/${seg(id)}`, wire(payload));
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `/domains/${seg(id)}`);
  }

  verify(id: string) {
    return this.client.call<Row>("POST", `/domains/${seg(id)}/verify`, {});
  }

  doctor(id: string) {
    return this.client.call<Row>("GET", `/domains/${seg(id)}/doctor`);
  }

  publishRoute53(id: string) {
    return this.client.call<Row>("POST", `/domains/${seg(id)}/publish-route53`, {});
  }
}

class ApiKeys extends Resource {
  create(payload: ApiKeyCreate) {
    return this.client.call<{ id: string; object: "api_key"; token: string }>("POST", "/api-keys", wire(payload));
  }

  list(page: Page = {}) {
    return this.client.call<List>("GET", `/api-keys${query(page)}`);
  }

  get(id: string) {
    return this.client.call<Row>("GET", `/api-keys/${seg(id)}`);
  }

  update(id: string, payload: { name: string }) {
    return this.client.call<Row>("PATCH", `/api-keys/${seg(id)}`, wire(payload));
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `/api-keys/${seg(id)}`);
  }
}

class WebhookEvents extends Resource {
  list(webhookId: string, page: Page = {}) {
    return this.client.call<List>("GET", `/webhooks/${seg(webhookId)}/events${query(page)}`);
  }

  get(webhookId: string, eventId: string) {
    return this.client.call<Row>("GET", `/webhooks/${seg(webhookId)}/events/${seg(eventId)}`);
  }

  attempts(webhookId: string, eventId: string, page: Page = {}) {
    return this.client.call<List>("GET", `/webhooks/${seg(webhookId)}/events/${seg(eventId)}/attempts${query(page)}`);
  }

  replay(webhookId: string, eventId: string) {
    return this.client.call<Row>("POST", `/webhooks/${seg(webhookId)}/events/${seg(eventId)}/replay`, {});
  }
}

class Webhooks extends Resource {
  readonly events = new WebhookEvents(this.client);

  create(payload: WebhookCreate) {
    return this.client.call<Row>("POST", "/webhooks", wire(payload));
  }

  get(id: string) {
    return this.client.call<Row>("GET", `/webhooks/${seg(id)}`);
  }

  list(page: Page = {}) {
    return this.client.call<List>("GET", `/webhooks${query(page)}`);
  }

  update(id: string, payload: Partial<WebhookCreate>) {
    return this.client.call<Row>("PATCH", `/webhooks/${seg(id)}`, wire(payload));
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `/webhooks/${seg(id)}`);
  }

  rotateSigningSecret(id: string) {
    return this.client.call<Row>("POST", `/webhooks/${seg(id)}/signing-secret/rotate`, {});
  }

  test() {
    return this.client.call<Row>("POST", "/webhooks/test", {});
  }

  // Synchronous. Throws WebhookVerificationError on a bad signature or a stale timestamp.
  verify<T = unknown>(input: VerifyInput): T {
    return verifyWebhook<T>(input);
  }
}

class TemplateVersions extends Resource {
  list(idOrAlias: string) {
    return this.client.call<List>("GET", `/templates/${seg(idOrAlias)}/versions`);
  }

  async create(idOrAlias: string, payload: TemplateVersion) {
    return this.client.call<Row>("POST", `/templates/${seg(idOrAlias)}/versions`, wire(await content(payload)));
  }
}

class TemplateLibrary extends Resource {
  list() {
    return this.client.call<List>("GET", "/template-library");
  }

  automations() {
    return this.client.call<List<AutomationPreset>>("GET", "/template-library/automations");
  }

  automation(slug: string) {
    return this.client.call<AutomationPresetDetail>("GET", `/template-library/automations/${seg(slug)}`);
  }

  get(slug: string) {
    return this.client.call<Row>("GET", `/template-library/${seg(slug)}`);
  }

  install(slug: string, options: Body = {}) {
    return this.client.call<Row>("POST", `/template-library/${seg(slug)}/install`, wire(options));
  }
}

export type Chain<T> = Promise<Result<T>> & { publish(): Promise<Result<T>> };

class Templates extends Resource {
  readonly versions = new TemplateVersions(this.client);
  readonly library = new TemplateLibrary(this.client);

  // Returns a promise with .publish(), so templates.create(...).publish() creates and publishes.
  create(payload: TemplateCreate): Chain<Row> {
    const created = (async () => this.client.call<Row>("POST", "/templates", wire(await content(payload))))();
    return Object.assign(created, {
      publish: async (): Promise<Result<Row>> => {
        const result = await created;
        return result.error ? result : this.publish(result.data.id);
      }
    });
  }

  get(idOrAlias: string) {
    return this.client.call<Template>("GET", `/templates/${seg(idOrAlias)}`);
  }

  list(page: Page & { q?: string; status?: "draft" | "published" } = {}) {
    return this.client.call<List<Template>>("GET", `/templates${query(page)}`);
  }

  async update(idOrAlias: string, payload: TemplateUpdate) {
    return this.client.call<Row>("PATCH", `/templates/${seg(idOrAlias)}`, wire(await content(payload)));
  }

  remove(idOrAlias: string) {
    return this.client.call<Deleted>("DELETE", `/templates/${seg(idOrAlias)}`);
  }

  publish(idOrAlias: string, options: { versionId?: string } = {}) {
    return this.client.call<Row>("POST", `/templates/${seg(idOrAlias)}/publish`, wire(options));
  }

  duplicate(idOrAlias: string, options: { name?: string } = {}) {
    return this.client.call<Row>("POST", `/templates/${seg(idOrAlias)}/duplicate`, wire(options));
  }

  // `draft: true` renders the latest version. Without it the published version is rendered.
  render(idOrAlias: string, variables: Record<string, unknown> = {}, options: { draft?: boolean } = {}) {
    return this.client.call<{ rendered: { subject?: string; html?: string; text?: string } }>(
      "POST",
      `/templates/${seg(idOrAlias)}/render`,
      options.draft ? { variables, draft: true } : { variables }
    );
  }
}

// Each method takes the contact as id, contactId, or email.
class ContactSegments extends Resource {
  list({ id, contactId, email, ...page }: Ref & Page) {
    const ref = contactRef({ id, contactId, email });
    if (!ref) return missing<List>("contactId");
    return this.client.call<List>("GET", `/contacts/${ref}/segments${query(page)}`);
  }

  add({ segmentId, ...input }: Ref & { segmentId: string }) {
    const ref = contactRef(input);
    if (!ref) return missing<Row>("contactId");
    return this.client.call<Row>("POST", `/contacts/${ref}/segments/${seg(segmentId)}`, {});
  }

  remove({ segmentId, ...input }: Ref & { segmentId: string }) {
    const ref = contactRef(input);
    if (!ref) return missing<Deleted>("contactId");
    return this.client.call<Deleted>("DELETE", `/contacts/${ref}/segments/${seg(segmentId)}`);
  }
}

class ContactTopics extends Resource {
  list({ id, contactId, email, ...page }: Ref & Page) {
    const ref = contactRef({ id, contactId, email });
    if (!ref) return missing<List>("id");
    return this.client.call<List>("GET", `/contacts/${ref}/topics${query(page)}`);
  }

  update({ topics, ...input }: Ref & { topics: Array<{ id: string; subscription: "opt_in" | "opt_out" }> }) {
    const ref = contactRef(input);
    if (!ref) return missing<List>("id");
    return this.client.call<List>("PATCH", `/contacts/${ref}/topics`, { topics });
  }
}

class ContactImports extends Resource {
  create(input: ContactImport) {
    const form = new FormData();
    if (input.columnMap) form.append("column_map", JSON.stringify(input.columnMap));
    if (input.onConflict) form.append("on_conflict", input.onConflict);
    if (input.segments) form.append("segments", JSON.stringify(input.segments));
    if (input.topics) form.append("topics", JSON.stringify(input.topics));
    if (input.triggerAutomations !== undefined) form.append("trigger_automations", String(input.triggerAutomations));
    const file = typeof input.file === "string" ? new Blob([input.file], { type: "text/csv" }) : input.file;
    form.append("file", file, input.filename ?? "contacts.csv");
    return this.client.call<ContactImportResult>("POST", "/contacts/imports", form);
  }

  list(page: Page & { status?: string } = {}) {
    return this.client.call<List<ContactImportResult>>("GET", `/contacts/imports${query(page)}`);
  }

  get(id: string) {
    return this.client.call<ContactImportResult>("GET", `/contacts/imports/${seg(id)}`);
  }
  cancel(id: string) {
    return this.client.call<ContactImportResult>("DELETE", `/contacts/imports/${seg(id)}`);
  }
}

class Contacts extends Resource {
  readonly segments = new ContactSegments(this.client);
  readonly topics = new ContactTopics(this.client);
  readonly imports = new ContactImports(this.client);

  create(payload: ContactCreate) {
    return this.client.call<Row>("POST", "/contacts", wire(payload));
  }

  list(page: Page & { segmentId?: string; segment_id?: string; q?: string; subscribed?: boolean } = {}) {
    return this.client.call<List>("GET", `/contacts${query(page)}`);
  }

  stats() {
    return this.client.call<Record<string, unknown>>("GET", "/contacts/stats");
  }

  get(idOrEmail: string) {
    return this.client.call<Row>("GET", `/contacts/${seg(idOrEmail)}`);
  }

  update({ id, email, ...payload }: ContactUpdate) {
    const ref = contactRef({ id, email });
    if (!ref) return missing<Row>("id");
    return this.client.call<Row>("PATCH", `/contacts/${ref}`, wire(payload));
  }

  remove(idOrEmail: string) {
    return this.client.call<{ object: "contact"; contact: string; deleted: true }>("DELETE", `/contacts/${seg(idOrEmail)}`);
  }

  activity(idOrEmail: string, page: Page = {}) {
    return this.client.call<List<ContactActivity>>("GET", `/contacts/${seg(idOrEmail)}/activity${query(page)}`);
  }
}

class ContactProperties extends Resource {
  create(payload: ContactPropertyCreate) {
    return this.client.call<ContactProperty>("POST", "/contact-properties", wire(payload));
  }

  list(page: Page = {}) {
    return this.client.call<List<ContactProperty>>("GET", `/contact-properties${query(page)}`);
  }

  get(id: string) {
    return this.client.call<ContactProperty>("GET", `/contact-properties/${seg(id)}`);
  }

  update({ id, ...payload }: { id: string; fallbackValue?: PropertyValue }) {
    return this.client.call<ContactProperty>("PATCH", `/contact-properties/${seg(id)}`, wire(payload));
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `/contact-properties/${seg(id)}`);
  }
}

class Segments extends Resource {
  create(payload: { name: string; description?: string }) {
    return this.client.call<Row>("POST", "/segments", wire(payload));
  }

  list(page: Page = {}) {
    return this.client.call<List>("GET", `/segments${query(page)}`);
  }

  get(id: string) {
    return this.client.call<Row>("GET", `/segments/${seg(id)}`);
  }

  update(id: string, payload: { name?: string; description?: string }) {
    return this.client.call<Row>("PATCH", `/segments/${seg(id)}`, wire(payload));
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `/segments/${seg(id)}`);
  }

  contacts(id: string, page: Page = {}) {
    return this.client.call<List>("GET", `/segments/${seg(id)}/contacts${query(page)}`);
  }
}

class Topics extends Resource {
  create(payload: TopicCreate) {
    return this.client.call<Row>("POST", "/topics", wire(payload));
  }

  list(page: Page = {}) {
    return this.client.call<List>("GET", `/topics${query(page)}`);
  }

  get(id: string) {
    return this.client.call<Row>("GET", `/topics/${seg(id)}`);
  }

  update({ id, ...payload }: { id: string } & Partial<Omit<TopicCreate, "defaultSubscription">>) {
    return this.client.call<Row>("PATCH", `/topics/${seg(id)}`, wire(payload));
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `/topics/${seg(id)}`);
  }
}

class Suppressions extends Resource {
  add(payload: { email: string; reason?: string }) {
    return this.client.call<Row>("POST", "/suppressions", wire(payload));
  }

  list(page: Page & { origin?: "bounce" | "complaint" | "manual" } = {}) {
    return this.client.call<List>("GET", `/suppressions${query(page)}`);
  }

  get(idOrEmail: string) {
    return this.client.call<Row>("GET", `/suppressions/${seg(idOrEmail)}`);
  }

  remove(idOrEmail: string) {
    return this.client.call<Deleted>("DELETE", `/suppressions/${seg(idOrEmail)}`);
  }

  batchAdd(emails: string[]) {
    return this.client.call<List>("POST", "/suppressions/batch/add", { emails });
  }

  batchRemove(input: { emails: string[] } | { ids: string[] }) {
    return this.client.call<List>("POST", "/suppressions/batch/remove", input);
  }
}

class Broadcasts extends Resource {
  async create(payload: BroadcastCreate) {
    return this.client.call<Row>("POST", "/broadcasts", wire(await content(payload)));
  }

  send(id: string, options: { scheduledAt?: string } = {}) {
    return this.client.call<{ id: string }>("POST", `/broadcasts/${seg(id)}/send`, wire(options));
  }

  list(page: Page & { status?: string; segmentId?: string; q?: string } = {}) {
    return this.client.call<List>("GET", `/broadcasts${query(page)}`);
  }

  // Who a send would reach now: recipients, and how many are left out and why.
  audience(id: string) {
    return this.client.call<{ object: "broadcast_audience"; total: number; recipients: number; unsubscribed: number; suppressed: number; opted_out: number; no_first_name: number; no_last_name: number }>(
      "GET",
      `/broadcasts/${seg(id)}/audience`
    );
  }

  get(id: string) {
    return this.client.call<Row>("GET", `/broadcasts/${seg(id)}`);
  }

  async update(id: string, payload: Partial<BroadcastCreate>) {
    return this.client.call<Row>("PATCH", `/broadcasts/${seg(id)}`, wire(await content(payload)));
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `/broadcasts/${seg(id)}`);
  }

  cancel(id: string) {
    return this.client.call<Row>("POST", `/broadcasts/${seg(id)}/cancel`, {});
  }

  duplicate(id: string, options: { name?: string } = {}) {
    return this.client.call<Row>("POST", `/broadcasts/${seg(id)}/duplicate`, wire(options));
  }

  recipients(id: string, { type, ...rest }: { type: RecipientType; email?: string; bounceType?: string } & Page) {
    return this.client.call<List>("GET", `/broadcasts/${seg(id)}/recipients${query({ type, ...rest })}`);
  }

  clickedLinks(id: string, page: Page = {}) {
    return this.client.call<List>("GET", `/broadcasts/${seg(id)}/clicked-links${query(page)}`);
  }

  pause(id: string) {
    return this.client.call<Row>("POST", `/broadcasts/${seg(id)}/pause`, {});
  }

  resume(id: string) {
    return this.client.call<Row>("POST", `/broadcasts/${seg(id)}/resume`, {});
  }
}

class AutomationRuns extends Resource {
  list(automationId: string, page: Page & { status?: string; startDate?: string; endDate?: string } = {}) {
    return this.client.call<List<AutomationRun>>("GET", `/automations/${seg(automationId)}/runs${query(page)}`);
  }

  metrics(automationId: string, range: { startDate?: string; endDate?: string } = {}) {
    return this.client.call<Record<string, unknown>>("GET", `/automations/${seg(automationId)}/runs/metrics${query(range)}`);
  }

  get(automationId: string, runId: string) {
    return this.client.call<AutomationRunDetail>("GET", `/automations/${seg(automationId)}/runs/${seg(runId)}`);
  }
}

class Automations extends Resource {
  readonly runs = new AutomationRuns(this.client);
  /** Explicitly enroll current live contacts into an enabled, unpaused contact flow. */
  enroll(id: string, input: AutomationEnrollment, options: { idempotencyKey?: string } = {}) {
    return this.client.call<AutomationEnrollmentJob>("POST", `/automations/${seg(id)}/enroll`, wire(input), options);
  }
  getEnrollmentJob(id: string, jobId: string) {
    return this.client.call<AutomationEnrollmentJob>("GET", `/automations/${seg(id)}/enroll-jobs/${seg(jobId)}`);
  }
  /** Cancel between batches; runs already created are not cancelled. */
  cancelEnrollmentJob(id: string, jobId: string) {
    return this.client.call<AutomationEnrollmentJob>("DELETE", `/automations/${seg(id)}/enroll-jobs/${seg(jobId)}`);
  }

  create(payload: AutomationCreate) {
    return this.client.call<Automation>("POST", "/automations", wire(payload));
  }

  list(page: Page & { status?: AutomationStatus } = {}) {
    return this.client.call<List<Automation>>("GET", `/automations${query(page)}`);
  }

  get(id: string) {
    return this.client.call<Automation>("GET", `/automations/${seg(id)}`);
  }

  update(id: string, payload: AutomationUpdate) {
    return this.client.call<Automation>("PATCH", `/automations/${seg(id)}`, wire(payload));
  }

  /** Preview an ordinary update with the same validation, without saving any changes. */
  dryRun(id: string, payload: AutomationUpdate) {
    return this.client.call<AutomationDryRun>("PATCH", `/automations/${seg(id)}?dry_run=true`, wire(payload));
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `/automations/${seg(id)}`);
  }

  duplicate(id: string, options: { name?: string } = {}) {
    return this.client.call<Automation>("POST", `/automations/${seg(id)}/duplicate`, wire(options));
  }

  /** Reset only once enrollments for contacts whose active runs this stop actually cancels. */
  stop(id: string, options: { resetReentry?: boolean } = {}) {
    return this.client.call<Row>("POST", `/automations/${seg(id)}/stop`, wire(options));
  }
}

class FiredEvents extends Resource {
  list(page: Page = {}) {
    return this.client.call<List>("GET", `/fired-events${query(page)}`);
  }

  get(id: string) {
    return this.client.call<Row>("GET", `/fired-events/${seg(id)}`);
  }
}

class Events extends Resource {
  readonly fired = new FiredEvents(this.client);

  send(payload: EventSend) {
    return this.client.call<{ object: "event"; event: string }>("POST", "/events/send", wire(payload));
  }

  create(payload: { name: string; schema?: EventSchema }) {
    return this.client.call<Row>("POST", "/events", wire(payload));
  }

  get(idOrName: string) {
    return this.client.call<Row>("GET", `/events/${seg(idOrName)}`);
  }

  list(page: Page = {}) {
    return this.client.call<List>("GET", `/events${query(page)}`);
  }

  update(idOrName: string, payload: { schema: EventSchema }) {
    return this.client.call<Row>("PATCH", `/events/${seg(idOrName)}`, wire(payload));
  }

  remove(idOrName: string) {
    return this.client.call<Deleted>("DELETE", `/events/${seg(idOrName)}`);
  }
}

class Logs extends Resource {
  // from and to are the date range. The API reads them as start_date and end_date.
  list({ from, to, ...page }: Page & { status?: string; user_agent?: string; api_key_id?: string; from?: string; to?: string; q?: string; emailId?: string } = {}) {
    return this.client.call<List>("GET", `/logs${query({ ...page, start_date: from, end_date: to })}`);
  }

  get(id: string) {
    return this.client.call<Row>("GET", `/logs/${seg(id)}`);
  }

  export() {
    return this.client.call<{ exported_at: string; logs: Row[] }>("GET", "/logs/export");
  }
}

class Brand extends Resource {
  get() {
    return this.client.call<Row>("GET", "/brand");
  }

  update(payload: Body) {
    return this.client.call<Row>("PATCH", "/brand", wire(payload));
  }
}

export type TenantSettings = {
  object: "settings";
  import_trigger_automations: boolean;
  sandbox_domains: string[];
};

class Settings extends Resource {
  get() {
    return this.client.call<TenantSettings>("GET", "/settings");
  }

  update(payload: { importTriggerAutomations?: boolean; sandboxDomains?: string[] }) {
    return this.client.call<TenantSettings>("PATCH", "/settings", wire(payload));
  }
}

class Single extends Resource {
  constructor(
    client: Dispatch,
    private readonly path: string,
    private readonly auth = true
  ) {
    super(client);
  }

  get() {
    return this.client.call<Record<string, unknown>>("GET", this.path, undefined, { auth: this.auth });
  }
}

class Timeline extends Resource {
  list(page: Page = {}) {
    return this.client.call<List>("GET", `/timeline${query(page)}`);
  }
}

class AuditLogs extends Resource {
  list(page: Page & { action?: string } = {}) {
    return this.client.call<List>("GET", `/audit-logs${query(page)}`);
  }
}

class Members extends Resource {
  constructor(
    client: Dispatch,
    private readonly path: string
  ) {
    super(client);
  }

  list(page: Page = {}) {
    return this.client.call<List>("GET", `${this.path}${query(page)}`);
  }

  create(payload: Body) {
    return this.client.call<Row>("POST", this.path, wire(payload));
  }

  update(id: string, payload: Body) {
    return this.client.call<Row>("PATCH", `${this.path}/${seg(id)}`, wire(payload));
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `${this.path}/${seg(id)}`);
  }
}

class Memberships extends Resource {
  list(page: Page = {}) {
    return this.client.call<List>("GET", `/memberships${query(page)}`);
  }

  create(payload: { userId?: string; roleId?: string; user_id?: string; role_id?: string }) {
    return this.client.call<Row>("POST", "/memberships", wire(payload));
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `/memberships/${seg(id)}`);
  }
}

class Sessions extends Resource {
  list(page: Page = {}) {
    return this.client.call<List>("GET", `/sessions${query(page)}`);
  }

  // Signs a user in with their password. `api_key` in its place works only where the API has
  // ALLOW_PASSWORDLESS_SESSIONS on, for local development and tests.
  create(payload: { email: string; password: string } | { email: string; api_key: string }) {
    return this.client.call<Row>("POST", "/sessions", payload, { auth: false });
  }

  remove(id: string) {
    return this.client.call<Deleted>("DELETE", `/sessions/${seg(id)}`);
  }
}

class Links extends Resource {
  check(urls: string[]) {
    return this.client.call<{ object: "list"; data: Row[] }>("POST", "/links/check", { urls });
  }
}
