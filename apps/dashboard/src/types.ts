// Response shapes from the API. Single resources come back flat with `object`,
// lists as `List<T>`, deletes as `Deleted`. Timestamps are ISO 8601 strings.

export type List<T> = {
  object: "list";
  has_more: boolean;
  data: T[];
};

export type Deleted = {
  object: string;
  id: string;
  deleted: true;
};

// Emails

export type Tag = { name: string; value: string };

export type EmailRecipient = {
  id?: string;
  email: string;
  kind: "to" | "cc" | "bcc";
  status: string;
  sandbox: boolean;
  created_at?: string;
};

export type Email = {
  object: "email";
  id: string;
  sandbox: boolean;
  recipients?: EmailRecipient[];
  message_id: string | null;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  last_event: string;
  scheduled_at: string | null;
  tags: Tag[];
  created_at: string;
};

export type Attachment = {
  id: string;
  filename: string;
  content_type: string;
  content_disposition?: string;
  size: number;
  content_id?: string | null;
  download_url?: string;
  expires_at?: string;
  created_at: string;
};

export type EmailEvent = {
  id: string;
  request_id?: string | null;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
};

export type EmailJob = {
  id: string;
  email_id: string;
  subject: string;
  state: string;
  attempts: number;
  available_at: string | null;
  error: string | null;
  created_at: string;
};

export type ReceivedEmail = {
  object?: "email";
  id: string;
  message_id?: string | null;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[] | null;
  subject: string;
  created_at: string;
};

export type ReceivedEmailDetail = ReceivedEmail & {
  request_id?: string | null;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  authentication?: Record<string, unknown> | null;
  received_for?: string[];
  recipients?: Array<{ id: string; email: string; kind: string; created_at: string }>;
  attachments?: Attachment[];
  raw?: { download_url: string; expires_at: string } | null;
};

export type SentBatch = { data: Array<{ id: string }>; errors?: Array<{ index: number; message: string }> };

export type Metrics = {
  object: "metrics";
  start_date: string;
  end_date: string;
  metrics: string[];
  dimensions: string[];
  granularity: string;
  totals: Record<string, number>;
  data: Array<Record<string, string | number>>;
};

// Domains

export type DomainRecord = {
  record?: string;
  name: string;
  type: string;
  value: string;
  status?: string;
  ttl?: string;
  priority?: number;
};

export type Domain = {
  object: "domain";
  id: string;
  name: string;
  status: string;
  region: string;
  created_at: string;
  custom_return_path: string;
  open_tracking: boolean;
  click_tracking: boolean;
  tracking_subdomain: string;
  tls: "opportunistic" | "enforced";
  capabilities: { sending: "enabled" | "disabled"; receiving: "enabled" | "disabled" };
  records: DomainRecord[];
  checked_at: string | null;
  /** Where the domain's DNS is hosted, such as "Cloudflare". Null until the verification poller has read it. */
  dns_provider?: string | null;
};

// API keys

export type ApiKey = {
  object?: "api_key";
  id: string;
  name: string;
  /** Masked prefix, such as "re_abc...". */
  token?: string;
  permission?: "full_access" | "sending_access";
  domain_id?: string | null;
  created_at: string;
  last_used_at?: string | null;
  /** The user who made the key in the dashboard, and their email. Null for a key made with another key. */
  created_by?: string | null;
  creator?: string | null;
};

export type CreatedApiKey = {
  object: "api_key";
  id: string;
  token: string;
};

// Webhooks

export type Webhook = {
  object: "webhook";
  id: string;
  endpoint: string;
  events: string[];
  status: "enabled" | "disabled";
  created_at: string;
  signing_secret?: string;
};

export type WebhookEvent = {
  object: "webhook_event";
  id: string;
  type: string;
  status: "success" | "pending" | "attempting" | "failed" | string;
  created_at: string;
};

export type WebhookEventDetail = WebhookEvent & {
  payload: Record<string, unknown>;
  next_attempt_at: string | null;
};

export type WebhookAttempt = {
  id: string;
  http_status_code: number | null;
  response: string | null;
  sent_at: string | null;
};

// Templates

export type TemplateVariable = string | { key: string; type?: string; fallback_value?: string | number | null };

export type Template = {
  object: "template";
  id: string;
  name: string;
  alias: string | null;
  from: string | null;
  reply_to: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  variables: TemplateVariable[];
  status: "draft" | "published";
  published_at: string | null;
  /** The version sends use. Null until the first publish. */
  published_version_id?: string | null;
  current_version_id: string | null;
  has_unpublished_versions: boolean;
  /** Open and click tracking for emails sent with this template. */
  track?: boolean;
  created_at: string;
  updated_at: string;
  /** Where the latest version came from. */
  source?: TemplateSource | null;
};

export type TemplateSource = { kind?: string; path?: string; slug?: string; version?: string };

export type TemplateVersion = {
  id: string;
  from: string | null;
  reply_to: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  variables: TemplateVariable[];
  created_at: string;
  published_at: string | null;
  source?: TemplateSource | null;
};

export type Rendered = { subject?: string; html?: string | null; text?: string | null };

export type LibraryTemplate = {
  slug: string;
  name: string;
  category: string;
  kind: "transactional" | "marketing";
  track: boolean;
  subject: string;
  description: string;
  variables: Array<{ key: string; type?: string; fallback_value?: string | number | null }>;
  sample: Record<string, unknown>;
  preview?: string;
};

/** `GET /template-library/:slug`: the summary plus the entry rendered with the tenant's brand and sample values. */
export type LibraryDetail = Omit<LibraryTemplate, "preview"> & {
  rendered?: Rendered;
  preview?: Rendered | string;
};

export type Brand = Record<string, unknown>;

// Audience

export type Contact = {
  object: "contact";
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  unsubscribed: boolean;
  properties: Record<string, { value: unknown; type: string }>;
  created_at: string;
  updated_at: string;
  /** On list rows only. */
  segments?: Array<{ id: string; name: string }>;
};

export type PropertyType = "string" | "number" | "boolean" | "date";

export type ContactProperty = {
  object: "contact_property";
  id: string;
  key: string;
  type: PropertyType;
  fallback_value: string | number | boolean | null;
  created_at: string;
  updated_at: string;
};

export type Topic = {
  object: "topic";
  id: string;
  name: string;
  key: string;
  description: string | null;
  visibility: "public" | "private";
  default_subscription: "opt_in" | "opt_out";
  created_at: string;
  updated_at: string;
};

export type TopicSubscription = {
  id: string;
  contact_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: "subscribed" | "unsubscribed";
  subscription: "opt_in" | "opt_out";
  created_at: string;
  updated_at: string;
};

export type Segment = {
  object: "segment";
  id: string;
  name: string;
  contacts?: number;
  created_at: string;
  updated_at: string;
};

export type SegmentContact = {
  object: "contact";
  id: string;
  contact_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
};

export type Suppression = {
  object: "suppression";
  id: string;
  email: string;
  reason: string;
  origin: "manual" | "bounce" | "complaint" | string;
  source_id: string | null;
  created_at: string;
};

// Broadcasts

export type Broadcast = {
  object?: "broadcast";
  id: string;
  name: string;
  from: string;
  reply_to?: string[];
  subject: string | null;
  preview_text?: string | null;
  topic_id: string | null;
  segment_id: string | null;
  status: string;
  recipient_count?: number;
  sent_count?: number;
  scheduled_at?: string | null;
  sent_at?: string | null;
  created_at: string;
  updated_at?: string;
};

export type BroadcastDetail = Broadcast & {
  html?: string | null;
  text?: string | null;
  variables?: Record<string, unknown>;
  paused?: boolean;
  template_id?: string | null;
};

/** `GET /broadcasts/:id/audience`: who the saved segment and topic reach. `recipients` is the number sent to. */
export type BroadcastAudience = {
  object: "broadcast_audience";
  total: number;
  recipients: number;
  unsubscribed: number;
  suppressed: number;
  opted_out: number;
  /** Recipients with no first name, or no last name. They see a blank where the content prints it. */
  no_first_name: number;
  no_last_name: number;
};

export type LinkCheck = { object: "link"; url: string; ok: boolean; status: number | null; message: string };

export type BroadcastRecipient = {
  id: string;
  email: string;
  status: string;
  email_id?: string | null;
  contact_id?: string | null;
  created_at: string;
};

export type ClickedLink = { id?: string; url: string; clicks: number; unique_clicks: number };

// Automations and events

export type RunCounts = { running: number; completed: number; failed: number; cancelled: number };

/** `GET /automations/:id/runs/metrics`: run totals by status, and per day. */
export type RunMetrics = {
  object?: "automation_run_metrics";
  total: number;
  totals: RunCounts;
  data: Array<RunCounts & { date: string }>;
};

export type AutomationStep = { type: string; key?: string; config?: Record<string, unknown>; [field: string]: unknown };

export type Automation = {
  object?: "automation";
  id: string;
  name: string;
  trigger?: string | null;
  trigger_config?: import("./views/automations/graph").TriggerConfig;
  reentry?: "once" | "every_time";
  status?: "enabled" | "disabled";
  enabled?: boolean;
  steps: AutomationStep[];
  connections?: Array<{ from: string; to: string; type?: string }>;
  /** Present on list rows from `GET /automations`, which omit `steps` and `connections`. */
  run_count?: number;
  created_at: string;
  updated_at?: string;
};

export type AutomationRun = {
  object?: "automation_run";
  id: string;
  automation_id?: string;
  event_id?: string;
  event_name?: string;
  email?: string | null;
  status?: string;
  state?: string;
  error?: string | null;
  created_at: string;
  updated_at?: string;
  event?: { id: string; name: string; email: string | null; payload?: Record<string, unknown> };
};

export type AutomationRunDetail = AutomationRun & {
  event_data?: Record<string, unknown>;
  steps?: Array<{
    id?: string;
    key?: string;
    step_index?: number;
    type: string;
    status?: string;
    state?: string;
    output?: unknown;
    data?: Record<string, unknown>;
    error?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    created_at?: string;
  }>;
};

/** A fired event, from `GET /fired-events`. */
export type FiredEvent = {
  object?: "fired_event";
  id: string;
  request_id?: string | null;
  name: string;
  email?: string | null;
  data?: Record<string, unknown>;
  /** The API's name for the fired event's body. */
  payload?: Record<string, unknown>;
  created_at: string;
};

/** An event definition, from `GET /events`. */
export type EventDefinition = {
  object?: "event";
  id: string;
  name: string;
  schema: Record<string, "string" | "number" | "boolean" | "date">;
  created_at: string;
  updated_at?: string;
};

// Logs, timeline, system

export type Log = {
  object: "log";
  id: string;
  created_at: string;
  endpoint: string;
  method: string;
  response_status: number;
  user_agent: string | null;
};

export type LogDetail = Log & {
  request_body: unknown;
  response_body: unknown;
};

export type TimelineItem = {
  kind: string;
  id: string;
  request_id?: string | null;
  name: string;
  summary: string;
  created_at: string;
};

export type System = {
  ok: boolean;
  provider: string;
  worker: { backlog: Record<string, number>; concurrency: number };
  webhooks: Record<string, unknown>;
  automations: Record<string, number>;
  logs: { count: number; last_seen_at: string };
  /** The provider's sending limits. Null when they could not be read. */
  sending?: Sending | null;
  /** Where the SMTP relay listens. `host` is null when the operator did not set SMTP_HOST. */
  smtp?: { host: string | null; port: number; tls_port: number } | null;
};

export type Sending = { region: string; max_24_hour: number; max_per_second: number; sent_24_hour: number; sandbox: boolean };

export type UsageCounter = {
  id: string;
  name: string;
  period: string;
  value: string;
  updated_at: string;
};

// Identity

export type User = {
  object?: "user";
  id: string;
  email: string;
  name: string;
  created_at: string;
  updated_at?: string;
  deactivated_at?: string | null;
};

export type Role = {
  object?: "role";
  id: string;
  name: string;
  permissions: string[];
  created_at: string;
};

export type Membership = {
  object?: "membership";
  id: string;
  user_id: string;
  email: string;
  name: string;
  role_id: string;
  role: string;
  created_at: string;
};

export type SessionRow = {
  object?: "session";
  id: string;
  user_id: string;
  email: string;
  expires_at: string;
  last_used_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
};

export type AuditLog = {
  id: string;
  request_id?: string | null;
  actor_email?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  data?: Record<string, unknown>;
  created_at: string;
};

export type Setup = {
  tenant: { id: string; name: string } | null;
  domain: { id: string; name: string; status: string } | null;
  api_key: { id: string; name: string; prefix: string; scope: string } | null;
  user: { id: string; email: string; name: string } | null;
};

// Audience extras

export type ContactStats = { object: "contact_stats"; all: number; subscribed: number; unsubscribed: number };

export type ContactActivity = {
  object: "contact_activity";
  id: string;
  /** Contact, subscription, email, fired-event, or automation-run activity. */
  type: string;
  resource_id: string | null;
  label: string | null;
  email_id: string | null;
  automation_id?: string | null;
  run_id?: string | null;
  created_at: string;
};

export type ContactSegment = { object: "segment"; id: string; name: string; created_at: string };

/** `explicit` is false when the contact made no choice and `subscription` is the topic's default. */
export type ContactTopic = { id: string; name: string; key: string; subscription: "opt_in" | "opt_out"; explicit?: boolean };

export type ImportCounts = { total: number; created: number; updated: number; skipped: number; failed: number };

export type ContactImport = {
  object: "contact_import";
  id: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  counts: ImportCounts;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

// Brand and public pages

export type BrandSettings = {
  object: "brand";
  product_name?: string;
  product_url?: string;
  logo_url?: string | null;
  color?: string;
  support_email?: string;
  support_url?: string | null;
  company_name?: string;
  company_address?: string;
  privacy_url?: string | null;
  /** The public unsubscribe page's heading and the line under it. Null or absent means the default. */
  unsubscribe_title?: string | null;
  unsubscribe_description?: string | null;
  text_color: string;
};

export type Preferences = {
  object: "unsubscribe";
  email: string;
  unsubscribed: boolean;
  topics: Array<{ id: string; name: string; description: string | null; subscription: "opt_in" | "opt_out" }>;
  brand: { product_name: string; logo_url: string | null; color: string; text_color: string; title?: string | null; description?: string | null };
};

export type SharedEmail = {
  subject: string;
  from: string;
  to: string[];
  created_at: string;
  html: string | null;
  text: string | null;
};

// Operations pages (emails, domains, keys, webhooks, logs)

export type ApiKeyDetail = ApiKey & {
  object: "api_key";
  token: string;
  permission: "full_access" | "sending_access";
  domain_id: string | null;
  total_uses: number;
};

/** One result of `GET /domains/:id/doctor`. `name` is fully qualified. */
export type DomainCheck = {
  name: string;
  type: string;
  record: string;
  expected: string;
  found: string | null;
  status: "ok" | "mismatch" | "missing";
  message: string;
};

export type DomainDoctor = { domain: string; checks: DomainCheck[] };

export type Route53Publish = {
  hosted_zone_id: string;
  changes: number;
  skipped: Array<{ name: string; type: string; record: string; reason: string }>;
};

export type Insight = { id: string; title: string; detail: string };

export type EmailInsights = {
  object: "email_insights";
  email_id: string;
  needs_attention: Insight[];
  possible_improvements: Insight[];
  doing_great: Insight[];
};

export type ShareLink = { object: "email"; id: string; url: string };
