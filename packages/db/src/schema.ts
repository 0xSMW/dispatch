export const schema = `
create table if not exists tenants (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  email text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deactivated_at timestamptz,
  unique (tenant_id, email)
);

create table if not exists roles (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  permissions jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, name)
);

create table if not exists memberships (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role_id text not null references roles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  unique (tenant_id, user_id)
);

create table if not exists sessions (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists api_keys (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  prefix text not null unique,
  hash text not null,
  scope text not null check (scope in ('full', 'send')),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists domains (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  region text not null,
  status text not null default 'pending',
  records jsonb not null default '[]',
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, name)
);

create table if not exists emails (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  request_id text not null,
  idempotency_key text,
  from_email text not null,
  subject text not null,
  html text,
  text text,
  template_id text,
  template_version_id text,
  headers jsonb not null default '{}',
  tags jsonb not null default '{}',
  status text not null default 'queued',
  scheduled_at timestamptz,
  provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists email_recipients (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  email_id text not null references emails(id) on delete cascade,
  email text not null,
  kind text not null check (kind in ('to', 'cc', 'bcc')),
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists email_attachments (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  email_id text not null references emails(id) on delete cascade,
  filename text not null,
  content_type text not null,
  content_id text,
  disposition text not null default 'attachment' check (disposition in ('attachment', 'inline')),
  size_bytes integer not null,
  content_hash text not null,
  storage_key text not null,
  created_at timestamptz not null default now()
);

create table if not exists tracking_tokens (
  token text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  email_id text not null references emails(id) on delete cascade,
  recipient_id text references email_recipients(id) on delete set null,
  kind text not null check (kind in ('open', 'click')),
  url text,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create table if not exists received_emails (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  request_id text not null,
  from_email text not null,
  subject text not null,
  html text,
  text text,
  headers jsonb not null default '{}',
  raw jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists received_recipients (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  received_email_id text not null references received_emails(id) on delete cascade,
  email text not null,
  kind text not null default 'to' check (kind in ('to', 'cc', 'bcc')),
  created_at timestamptz not null default now()
);

create table if not exists received_attachments (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  received_email_id text not null references received_emails(id) on delete cascade,
  filename text not null,
  content_type text not null,
  size_bytes integer not null,
  content_hash text not null,
  storage_key text not null,
  created_at timestamptz not null default now()
);

create table if not exists send_jobs (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  email_id text not null references emails(id) on delete cascade,
  request_id text not null,
  state text not null default 'ready',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists email_events (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  request_id text,
  email_id text references emails(id) on delete cascade,
  recipient_id text references email_recipients(id) on delete set null,
  type text not null,
  provider_event_id text unique,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists idempotency_keys (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  key text not null,
  request_hash text not null,
  response_json jsonb,
  state text not null check (state in ('running', 'done')),
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table if not exists suppressions (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  email text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (tenant_id, email)
);

create table if not exists templates (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  alias text,
  published_version_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, name)
);

create table if not exists template_versions (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  template_id text not null references templates(id) on delete cascade,
  subject text not null,
  html text,
  text text,
  variables jsonb not null default '[]',
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create table if not exists contacts (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  email text not null,
  first_name text,
  last_name text,
  properties jsonb not null default '{}',
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, email)
);

create table if not exists topics (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  key text not null,
  default_status text not null default 'subscribed' check (default_status in ('subscribed', 'unsubscribed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, key)
);

create table if not exists topic_subscriptions (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  topic_id text not null references topics(id) on delete cascade,
  contact_id text not null references contacts(id) on delete cascade,
  status text not null check (status in ('subscribed', 'unsubscribed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, topic_id, contact_id)
);

create table if not exists segments (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, name)
);

create table if not exists segment_contacts (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  segment_id text not null references segments(id) on delete cascade,
  contact_id text not null references contacts(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (tenant_id, segment_id, contact_id)
);

create table if not exists broadcasts (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  from_email text not null,
  subject text,
  html text,
  text text,
  template_id text,
  template_version_id text,
  variables jsonb not null default '{}',
  topic_id text references topics(id) on delete set null,
  segment_id text references segments(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'cancelled')),
  recipient_count integer not null default 0,
  sent_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  deleted_at timestamptz
);

create table if not exists broadcast_recipients (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  broadcast_id text not null references broadcasts(id) on delete cascade,
  contact_id text not null references contacts(id) on delete cascade,
  email_id text references emails(id) on delete set null,
  email text not null,
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, broadcast_id, contact_id)
);

create table if not exists custom_events (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  request_id text not null,
  name text not null,
  email text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists automations (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  trigger text not null,
  steps jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, name)
);

create table if not exists automation_runs (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  automation_id text not null references automations(id) on delete cascade,
  event_id text not null references custom_events(id) on delete cascade,
  state text not null default 'ready' check (state in ('ready', 'running', 'waiting', 'done', 'failed', 'stopped')),
  next_step_index integer not null default 0,
  resume_at timestamptz,
  wait_event text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists automation_steps (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  run_id text not null references automation_runs(id) on delete cascade,
  step_index integer not null,
  type text not null,
  state text not null default 'done' check (state in ('waiting', 'done', 'failed')),
  data jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now()
);

alter table automation_runs add column if not exists next_step_index integer not null default 0;
alter table automation_runs add column if not exists resume_at timestamptz;
alter table automation_runs add column if not exists wait_event text;
alter table automation_runs drop constraint if exists automation_runs_state_check;
alter table automation_runs add constraint automation_runs_state_check check (state in ('ready', 'running', 'waiting', 'done', 'failed', 'stopped'));
alter table automation_steps drop constraint if exists automation_steps_state_check;
alter table automation_steps add constraint automation_steps_state_check check (state in ('waiting', 'done', 'failed'));

create table if not exists webhooks (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  url text not null,
  events jsonb not null,
  secret text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists webhook_attempts (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  request_id text,
  webhook_id text not null references webhooks(id) on delete cascade,
  event_id text not null references email_events(id) on delete cascade,
  state text not null,
  attempt integer not null default 1,
  available_at timestamptz not null default now(),
  status integer,
  latency_ms integer,
  error text,
  response text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists webhook_replays (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  webhook_id text not null references webhooks(id) on delete cascade,
  event_id text not null references email_events(id) on delete cascade,
  attempt_id text references webhook_attempts(id) on delete set null,
  request_id text,
  created_at timestamptz not null default now()
);

create table if not exists webhook_endpoint_health (
  webhook_id text primary key references webhooks(id) on delete cascade,
  tenant_id text not null references tenants(id) on delete cascade,
  state text not null default 'healthy' check (state in ('healthy', 'retrying', 'failing', 'disabled')),
  consecutive_failures integer not null default 0,
  last_status integer,
  last_error text,
  checked_at timestamptz not null default now()
);

create table if not exists provider_events_raw (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  provider text not null,
  provider_event_id text not null,
  event_id text references email_events(id) on delete set null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (tenant_id, provider, provider_event_id)
);

create table if not exists event_dedupe_keys (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  key text not null,
  event_id text references email_events(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table if not exists event_schemas (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  schema jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, name)
);

create table if not exists usage_counters (
  id text primary key,
  tenant_id text references tenants(id) on delete cascade,
  name text not null,
  period text not null,
  value bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (tenant_id, name, period)
);

create table if not exists quota_limits (
  id text primary key,
  tenant_id text references tenants(id) on delete cascade,
  name text not null,
  value bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists rate_limit_overrides (
  id text primary key,
  tenant_id text references tenants(id) on delete cascade,
  route text not null,
  requests_per_second integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, route)
);

create table if not exists logs (
  id text primary key,
  tenant_id text references tenants(id) on delete cascade,
  request_id text not null,
  user_agent text,
  method text not null,
  path text not null,
  status integer not null,
  latency_ms integer not null,
  api_key_id text,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  request_id text,
  actor_user_id text references users(id) on delete set null,
  api_key_id text,
  session_id text references sessions(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table webhook_attempts add column if not exists attempt integer not null default 1;
alter table webhook_attempts add column if not exists available_at timestamptz not null default now();
alter table webhook_attempts add column if not exists updated_at timestamptz not null default now();
alter table logs add column if not exists user_agent text;
alter table emails add column if not exists scheduled_at timestamptz;
alter table emails add column if not exists template_id text;
alter table emails add column if not exists template_version_id text;
alter table email_attachments add column if not exists content_id text;
alter table email_attachments add column if not exists disposition text not null default 'attachment';
alter table email_attachments add column if not exists content_hash text not null default '';
alter table email_attachments add column if not exists storage_key text not null default '';
alter table received_attachments add column if not exists content_hash text not null default '';
alter table received_attachments add column if not exists storage_key text not null default '';
alter table received_recipients add column if not exists kind text not null default 'to';
alter table email_events add column if not exists request_id text;
alter table webhook_attempts add column if not exists request_id text;
alter table broadcasts add column if not exists sent_count integer not null default 0;
alter table custom_events add column if not exists updated_at timestamptz not null default now();
alter table custom_events add column if not exists deleted_at timestamptz;
alter table broadcasts drop constraint if exists broadcasts_status_check;
alter table broadcasts add constraint broadcasts_status_check check (status in ('draft', 'sending', 'paused', 'sent', 'cancelled'));

create index if not exists emails_tenant_created_idx on emails (tenant_id, created_at desc);
create index if not exists emails_tenant_status_idx on emails (tenant_id, status, created_at desc);
create index if not exists recipients_email_idx on email_recipients (email_id);
create index if not exists recipients_tenant_status_idx on email_recipients (tenant_id, status, created_at desc);
create index if not exists attachments_email_idx on email_attachments (email_id);
create index if not exists tracking_tokens_email_idx on tracking_tokens (email_id);
create index if not exists received_emails_tenant_created_idx on received_emails (tenant_id, created_at desc);
create index if not exists received_recipients_received_idx on received_recipients (received_email_id);
create index if not exists received_attachments_received_idx on received_attachments (received_email_id);
create index if not exists send_jobs_ready_idx on send_jobs (available_at, id) where state = 'ready';
create index if not exists events_email_idx on email_events (email_id, created_at asc);
create index if not exists events_tenant_created_idx on email_events (tenant_id, created_at desc);
create index if not exists users_tenant_created_idx on users (tenant_id, created_at desc) where deactivated_at is null;
create index if not exists roles_tenant_created_idx on roles (tenant_id, created_at desc) where deleted_at is null;
create index if not exists memberships_tenant_created_idx on memberships (tenant_id, created_at desc) where disabled_at is null;
create index if not exists sessions_tenant_created_idx on sessions (tenant_id, created_at desc) where revoked_at is null;
create index if not exists idempotency_expires_idx on idempotency_keys (expires_at);
create unique index if not exists templates_tenant_alias_idx on templates (tenant_id, alias) where alias is not null and deleted_at is null;
create index if not exists templates_tenant_created_idx on templates (tenant_id, created_at desc) where deleted_at is null;
create index if not exists template_versions_template_created_idx on template_versions (template_id, created_at desc);
create index if not exists contacts_tenant_created_idx on contacts (tenant_id, created_at desc) where deleted_at is null;
create index if not exists contacts_tenant_email_idx on contacts (tenant_id, email) where deleted_at is null;
create index if not exists topics_tenant_created_idx on topics (tenant_id, created_at desc) where deleted_at is null;
create index if not exists topic_subscriptions_topic_idx on topic_subscriptions (topic_id, status);
create index if not exists segments_tenant_created_idx on segments (tenant_id, created_at desc) where deleted_at is null;
create index if not exists segment_contacts_segment_idx on segment_contacts (segment_id);
create index if not exists broadcasts_tenant_created_idx on broadcasts (tenant_id, created_at desc) where deleted_at is null;
create index if not exists broadcast_recipients_broadcast_idx on broadcast_recipients (broadcast_id, status);
create index if not exists custom_events_tenant_created_idx on custom_events (tenant_id, created_at desc);
create index if not exists custom_events_tenant_name_idx on custom_events (tenant_id, name, created_at desc);
create index if not exists automations_tenant_trigger_idx on automations (tenant_id, trigger) where deleted_at is null and enabled = true;
create index if not exists automation_runs_automation_idx on automation_runs (automation_id, created_at desc);
create index if not exists automation_runs_waiting_idx on automation_runs (resume_at, id) where state = 'waiting' and resume_at is not null;
create index if not exists automation_runs_wait_event_idx on automation_runs (tenant_id, wait_event) where state = 'waiting' and wait_event is not null;
create index if not exists suppressions_tenant_created_idx on suppressions (tenant_id, created_at desc) where removed_at is null;
create index if not exists webhooks_tenant_enabled_idx on webhooks (tenant_id, enabled);
create index if not exists webhooks_events_idx on webhooks using gin (events);
create index if not exists webhook_attempts_webhook_idx on webhook_attempts (webhook_id, created_at desc);
create index if not exists webhook_attempts_ready_idx on webhook_attempts (available_at, id) where state = 'queued';
create index if not exists webhook_replays_webhook_idx on webhook_replays (webhook_id, created_at desc);
create index if not exists webhook_health_tenant_idx on webhook_endpoint_health (tenant_id, state);
create index if not exists provider_events_tenant_created_idx on provider_events_raw (tenant_id, created_at desc);
create index if not exists event_schemas_tenant_created_idx on event_schemas (tenant_id, created_at desc) where deleted_at is null;
create index if not exists usage_counters_tenant_name_idx on usage_counters (tenant_id, name, period);
create index if not exists logs_tenant_created_idx on logs (tenant_id, created_at desc);
create index if not exists audit_logs_tenant_created_idx on audit_logs (tenant_id, created_at desc);
`;
