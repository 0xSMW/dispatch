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
  domain_id text,
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
  from_name text,
  reply_to jsonb not null default '[]',
  message_id text,
  topic_id text,
  broadcast_id text,
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

create table if not exists contact_properties (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  key text not null,
  type text not null default 'string' check (type in ('string', 'number')),
  fallback_value jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, key)
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
alter table emails add column if not exists from_name text;
alter table emails add column if not exists reply_to jsonb not null default '[]';
alter table emails add column if not exists message_id text;
alter table emails add column if not exists topic_id text;
alter table emails add column if not exists broadcast_id text;
alter table api_keys add column if not exists domain_id text;
alter table domains add column if not exists tls text not null default 'opportunistic';
alter table domains add column if not exists return_path text not null default 'send';
alter table domains add column if not exists tracking_subdomain text not null default 'links';
alter table domains add column if not exists sending text not null default 'enabled';
alter table domains add column if not exists receiving text not null default 'disabled';
alter table domains add column if not exists dkim_tokens jsonb not null default '[]';
alter table domains add column if not exists verify_started_at timestamptz;
alter table suppressions add column if not exists origin text not null default 'manual';
alter table suppressions add column if not exists source_id text;
update suppressions set origin = 'bounce' where reason = 'email.bounced' and origin = 'manual';
update suppressions set origin = 'complaint' where reason = 'email.complained' and origin = 'manual';
alter table received_emails add column if not exists message_id text;
alter table received_emails add column if not exists reply_to jsonb not null default '[]';
alter table received_emails add column if not exists authentication jsonb;
alter table received_emails add column if not exists raw_key text;
alter table received_attachments add column if not exists content_id text;
alter table domains add column if not exists open_tracking boolean not null default false;
alter table domains add column if not exists click_tracking boolean not null default false;
alter table domains add column if not exists updated_at timestamptz not null default now();
alter table emails add column if not exists html_tracked text;
alter table logs add column if not exists request_body jsonb;
alter table logs add column if not exists response_body jsonb;
alter table tenants add column if not exists brand jsonb not null default '{}';
alter table templates add column if not exists track boolean not null default true;
alter table template_versions add column if not exists source jsonb not null default '{}';
alter table template_versions add column if not exists from_address text;
alter table template_versions add column if not exists reply_to jsonb not null default '[]';
alter table template_versions alter column subject drop not null;
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
alter table webhooks add column if not exists previous_secret text;
alter table webhooks add column if not exists previous_secret_expires_at timestamptz;
alter table webhook_endpoint_health add column if not exists failing_since timestamptz;
alter table custom_events add column if not exists updated_at timestamptz not null default now();
alter table custom_events add column if not exists deleted_at timestamptz;
alter table broadcasts drop constraint if exists broadcasts_status_check;
alter table broadcasts add constraint broadcasts_status_check check (status in ('draft', 'sending', 'paused', 'sent', 'cancelled'));
alter table topics add column if not exists description text;
alter table topics add column if not exists visibility text not null default 'private';
alter table emails add column if not exists api_key_id text;
create index if not exists emails_tenant_api_key_idx on emails (tenant_id, api_key_id, created_at desc) where api_key_id is not null;
create index if not exists logs_tenant_api_key_idx on logs (tenant_id, api_key_id);
create table if not exists contact_imports (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'in_progress', 'completed', 'failed')),
  storage_key text not null,
  column_map jsonb not null default '{}',
  on_conflict text not null default 'upsert' check (on_conflict in ('upsert', 'skip')),
  segments jsonb not null default '[]',
  topics jsonb not null default '[]',
  counts jsonb not null default '{"total":0,"created":0,"updated":0,"skipped":0,"failed":0}',
  error text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists contact_imports_ready_idx on contact_imports (created_at, id) where status = 'queued';
create index if not exists contact_imports_tenant_created_idx on contact_imports (tenant_id, created_at desc);
alter table broadcasts add column if not exists reply_to jsonb not null default '[]';
alter table broadcasts add column if not exists preview_text text;
alter table broadcasts add column if not exists scheduled_at timestamptz;
alter table broadcasts add column if not exists from_name text;
alter table broadcasts add column if not exists request_id text;
alter table broadcasts drop constraint if exists broadcasts_status_check;
alter table broadcasts add constraint broadcasts_status_check
  check (status in ('draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled'));
create index if not exists broadcasts_due_idx on broadcasts (scheduled_at) where status in ('sending', 'scheduled');
alter table broadcast_recipients add column if not exists error text;
alter table broadcast_recipients add column if not exists unsubscribed_at timestamptz;
create index if not exists broadcast_recipients_queued_idx on broadcast_recipients (broadcast_id, created_at, id) where status = 'queued';
alter table automations add column if not exists connections jsonb not null default '[]';
alter table automation_runs add column if not exists next_step_key text;
alter table automation_steps add column if not exists step_key text;
alter table automation_steps add column if not exists started_at timestamptz;
alter table automation_steps add column if not exists completed_at timestamptz;
create index if not exists contact_properties_tenant_created_idx
  on contact_properties (tenant_id, created_at desc) where deleted_at is null;

create index if not exists emails_tenant_created_idx on emails (tenant_id, created_at desc);
create index if not exists emails_broadcast_idx on emails (tenant_id, broadcast_id) where broadcast_id is not null;
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

-- Addresses are matched without regard to case when a send is checked against suppressions and topics.
create index if not exists suppressions_tenant_lower_email_idx on suppressions (tenant_id, lower(email)) where removed_at is null;
create index if not exists contacts_tenant_lower_email_idx on contacts (tenant_id, lower(email)) where deleted_at is null;

-- A deleted template, topic, or segment must not block a new one with the same name.
alter table templates drop constraint if exists templates_tenant_id_name_key;
create unique index if not exists templates_tenant_name_idx on templates (tenant_id, name) where deleted_at is null;
alter table topics drop constraint if exists topics_tenant_id_key_key;
create unique index if not exists topics_tenant_key_idx on topics (tenant_id, key) where deleted_at is null;
alter table segments drop constraint if exists segments_tenant_id_name_key;
create unique index if not exists segments_tenant_name_idx on segments (tenant_id, name) where deleted_at is null;

-- What resumed a paused automation run: an event, or the timeout. Read by the worker that runs it.
alter table automation_runs add column if not exists resume_data jsonb;
create index if not exists automation_runs_ready_idx on automation_runs (created_at, id) where state in ('ready', 'running');
alter table automations drop constraint if exists automations_tenant_id_name_key;
create unique index if not exists automations_tenant_name_idx on automations (tenant_id, name) where deleted_at is null;

alter table broadcasts add column if not exists failures integer not null default 0;
alter table broadcasts add column if not exists error text;
create index if not exists send_jobs_email_idx on send_jobs (email_id);

-- The worker reclaims work a crashed process left in the running state.
create index if not exists send_jobs_running_idx on send_jobs (locked_at) where state = 'running';
create index if not exists webhook_attempts_running_idx on webhook_attempts (updated_at) where state = 'running';

-- Who made an API key, when it was made from the dashboard. A key made with another key has none.
alter table api_keys add column if not exists created_by text references users(id) on delete set null;
-- Where the domain's DNS is hosted, read from its NS records by the verification poller.
alter table domains add column if not exists dns_provider text;

-- A restarted import skips the rows an earlier worker already committed.
alter table contact_imports add column if not exists row_offset integer not null default 0;

-- Usage counters page on a time that never moves. updated_at changes with every increment.
alter table usage_counters add column if not exists created_at timestamptz not null default now();

-- One contact per mailbox. Addresses are lowercased on write now, but rows written earlier can
-- differ only by case. Each statement below does nothing once the rows are merged.
-- The row that stays is the live one, or the oldest when several are live.
-- 1. An opt-out on any copy carries over, so nobody is resubscribed by the merge.
update contacts c set unsubscribed_at = d.unsubscribed_at
from (
  select tenant_id, lower(email) as mailbox, min(unsubscribed_at) as unsubscribed_at
  from contacts group by tenant_id, lower(email) having count(*) > 1
) d
where c.tenant_id = d.tenant_id and lower(c.email) = d.mailbox
  and c.unsubscribed_at is null and d.unsubscribed_at is not null;
-- 2. Segment memberships move to the row that stays.
insert into segment_contacts (id, tenant_id, segment_id, contact_id)
select 'member_' || md5(sc.id || k.id), sc.tenant_id, sc.segment_id, k.id
from segment_contacts sc
join contacts c on c.id = sc.contact_id
join (
  select distinct on (tenant_id, lower(email)) id, tenant_id, lower(email) as mailbox
  from contacts
  order by tenant_id, lower(email), (deleted_at is not null), created_at, id
) k on k.tenant_id = c.tenant_id and k.mailbox = lower(c.email)
where k.id <> c.id
on conflict (tenant_id, segment_id, contact_id) do nothing;
-- 3. Topic choices move too. Where the copies disagree, the opt-out wins.
insert into topic_subscriptions (id, tenant_id, topic_id, contact_id, status)
select distinct on (s.tenant_id, s.topic_id, k.id) 'topicsub_' || md5(s.id || k.id), s.tenant_id, s.topic_id, k.id, s.status
from topic_subscriptions s
join contacts c on c.id = s.contact_id
join (
  select distinct on (tenant_id, lower(email)) id, tenant_id, lower(email) as mailbox
  from contacts
  order by tenant_id, lower(email), (deleted_at is not null), created_at, id
) k on k.tenant_id = c.tenant_id and k.mailbox = lower(c.email)
where k.id <> c.id
order by s.tenant_id, s.topic_id, k.id, (s.status = 'unsubscribed') desc
on conflict (tenant_id, topic_id, contact_id) do update set status = 'unsubscribed', updated_at = now()
  where excluded.status = 'unsubscribed';
-- 4. Broadcast history moves too, so the record of what each person was sent survives. Where
-- both copies were sent the same broadcast, the kept row's record stays and the other goes
-- with its contact in step 5.
update broadcast_recipients br set contact_id = k.id
from contacts c
join (
  select distinct on (tenant_id, lower(email)) id, tenant_id, lower(email) as mailbox
  from contacts
  order by tenant_id, lower(email), (deleted_at is not null), created_at, id
) k on k.tenant_id = c.tenant_id and k.mailbox = lower(c.email)
where br.contact_id = c.id and k.id <> c.id
  and not exists (
    select 1 from broadcast_recipients kept
    where kept.tenant_id = br.tenant_id and kept.broadcast_id = br.broadcast_id and kept.contact_id = k.id
  );
-- 5. The extra rows go, then every address is lowercased and the rule is enforced.
delete from contacts c using (
  select distinct on (tenant_id, lower(email)) id, tenant_id, lower(email) as mailbox
  from contacts
  order by tenant_id, lower(email), (deleted_at is not null), created_at, id
) k
where k.tenant_id = c.tenant_id and k.mailbox = lower(c.email) and k.id <> c.id;
update contacts set email = lower(email) where email <> lower(email);
create unique index if not exists contacts_tenant_mailbox_key on contacts (tenant_id, lower(email));

-- Email and password sign-in, and the Viewer role.
-- A scrypt hash with its parameters ("scrypt$N$r$p$salt$hash"). Null means the user has no
-- password yet and cannot sign in with one.
alter table users add column if not exists password_hash text;
-- Every tenant has two roles: Admin with full access and Viewer, which can only read. Tenants
-- were created with a full-access role named "owner". It becomes Admin.
update roles r set name = 'Admin', updated_at = now()
where r.name = 'owner' and r.permissions = '["full"]'::jsonb
  and not exists (select 1 from roles a where a.tenant_id = r.tenant_id and a.name = 'Admin');
-- A tenant gets its Viewer once. A role this statement made, any role named Viewer, or any
-- read-only role, live or deleted, means the tenant has had one, so a Viewer an admin renamed or
-- deleted is not made again. With no conflict target, every unique index arbitrates and a
-- clash is skipped, never raised.
insert into roles (id, tenant_id, name, permissions)
select 'role_' || md5(t.id || ':viewer'), t.id, 'Viewer', '["read"]'::jsonb
from tenants t
where not exists (
  select 1 from roles r
  where r.tenant_id = t.id
    and (r.id = 'role_' || md5(t.id || ':viewer') or r.name = 'Viewer' or r.permissions = '["read"]'::jsonb)
)
on conflict do nothing;

-- Tenant settings.
alter table tenants add column if not exists settings jsonb not null default '{}';

-- Recipient links for marketing mail.
alter table emails add column if not exists contact_id text;

-- Automation email attribution. Old messages have no recoverable step key.
alter table emails add column if not exists automation_id text;
alter table emails add column if not exists automation_step text;
update emails e set automation_id = a.id
from automations a, automation_runs r
where e.automation_id is null
  and e.created_at < '2026-10-04T00:00:00Z'::timestamptz
  and e.tags ? 'automation_run_id'
  and a.tenant_id = e.tenant_id and a.id = e.tags->>'automation_id'
  and r.tenant_id = e.tenant_id and r.id = e.tags->>'automation_run_id' and r.automation_id = a.id;

-- Contact event history, also used by lifecycle attribution.
create index if not exists custom_events_tenant_email_created_idx
  on custom_events (tenant_id, lower(email), created_at desc);

-- Shared, expiring counters and bounded workflow coordination.
create table if not exists counters (
  key text primary key,
  value bigint not null check (value >= 0),
  expires_at timestamptz not null,
  window_id text not null
);
create index if not exists counters_expires_at_idx on counters (expires_at);
create table if not exists worker_leases (
  name text primary key,
  owner text not null,
  expires_at timestamptz not null
);
create table if not exists send_slots (
  region text primary key,
  available_at timestamptz not null
);

-- Sandbox attribution is stored separately from delivery status, including mixed recipients.
alter table emails add column if not exists sandbox boolean not null default false;
alter table email_recipients add column if not exists sandbox boolean not null default false;

-- Boolean and ISO date contact property definitions.
alter table contact_properties drop constraint if exists contact_properties_type_check;
alter table contact_properties add constraint contact_properties_type_check
  check (type in ('string', 'number', 'boolean', 'date'));

-- Contact trigger namespaces and transactional transition history.
alter table automations add column if not exists trigger_type text not null default 'event';
alter table automations drop constraint if exists automations_trigger_type_check;
alter table automations add constraint automations_trigger_type_check
  check (trigger_type in ('event', 'contact_created', 'contact_updated', 'topic_subscribed', 'segment_added'));
create index if not exists automations_tenant_trigger_type_idx
  on automations (tenant_id, trigger_type, trigger) where deleted_at is null and enabled;
alter table automations add column if not exists reentry text not null default 'every_time';
alter table automations drop constraint if exists automations_reentry_check;
alter table automations add constraint automations_reentry_check check (reentry in ('once', 'every_time'));
create table if not exists automation_enrollments (
  tenant_id text not null references tenants(id) on delete cascade,
  automation_id text not null references automations(id) on delete cascade,
  contact_id text not null,
  created_at timestamptz not null default now(),
  primary key (automation_id, contact_id)
);
create table if not exists contact_changes (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  contact_id text not null,
  field text not null,
  from_value jsonb,
  to_value jsonb,
  request_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists contact_changes_tenant_contact_created_idx
  on contact_changes (tenant_id, contact_id, created_at);

-- Imports persist their resolved opt-in, and their runs are marked for bulk claiming.
alter table contact_imports add column if not exists trigger_automations boolean not null default false;
alter table automation_runs add column if not exists priority text not null default 'normal';
alter table automation_runs drop constraint if exists automation_runs_priority_check;
alter table automation_runs add constraint automation_runs_priority_check check (priority in ('normal', 'bulk'));
-- Keep enrollment identity stable if a contact changes its email before cancellation.
alter table automation_runs add column if not exists contact_id text;
-- Explicit enrollment pages commit their receipts, cursor, progress and runs together.
create table if not exists automation_enrollment_jobs (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  automation_id text not null references automations(id) on delete cascade,
  segment_id text,
  status text not null default 'queued' check (status in ('queued', 'in_progress', 'completed', 'failed', 'cancelled')),
  counts jsonb not null default '{"total":0,"processed":0,"enrolled":0,"skipped":0,"failed":0}',
  cursor text,
  idempotency_key text,
  input_hash text not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, automation_id, idempotency_key)
);
create table if not exists automation_enrollment_job_contacts (
  job_id text not null references automation_enrollment_jobs(id) on delete cascade,
  contact_id text not null,
  primary key (job_id, contact_id)
);
create index if not exists automation_enrollment_jobs_ready_idx on automation_enrollment_jobs (updated_at, id)
  where status in ('queued', 'in_progress');
create index if not exists contacts_enrollment_idx on contacts (tenant_id, id) where deleted_at is null;
create index if not exists contact_changes_created_idx on contact_changes (created_at, id);
alter table contact_imports drop constraint if exists contact_imports_status_check;
alter table contact_imports add constraint contact_imports_status_check
  check (status in ('queued', 'in_progress', 'completed', 'failed', 'cancelled'));
alter table contact_imports add column if not exists claim_version integer not null default 0;

-- Pausing holds execution without changing runs, waits or contact/event history.
alter table automations add column if not exists paused_at timestamptz;
alter table automations add column if not exists version integer not null default 0;
alter table automations drop constraint if exists automations_pause_check;
alter table automations add constraint automations_pause_check check (enabled or paused_at is null);
create index if not exists automations_active_trigger_idx on automations (tenant_id, trigger_type, trigger)
  where deleted_at is null and enabled and paused_at is null;

-- Keys are permanent type reservations, including writes by future installers.
alter table automations add column if not exists used_keys jsonb not null default '{}';
create or replace function automation_keys(steps jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(
    coalesce(step->>'key', 'step_' || ordinal::text),
    case step->>'type' when 'wait' then 'wait_for_event' when 'update_contact' then 'contact_update' else step->>'type' end
  ), '{}'::jsonb) || case when not exists (select 1 from jsonb_array_elements(steps) s where s ? 'key')
    then '{"trigger":"trigger"}'::jsonb else '{}'::jsonb end
  from jsonb_array_elements(steps) with ordinality s(step, ordinal)
$$;
update automations set used_keys = automation_keys(steps) where used_keys = '{}'::jsonb;
create or replace function reserve_automation_keys() returns trigger language plpgsql as $$
declare
  history jsonb;
  entry record;
begin
  history := case when TG_OP = 'UPDATE' then OLD.used_keys else '{}'::jsonb end;
  for entry in select * from jsonb_each_text(automation_keys(NEW.steps)) loop
    if history ? entry.key and history->>entry.key <> entry.value then
      raise exception 'Step key % was already used for %. Use a new key for %.',
        entry.key, history->>entry.key, entry.value using errcode = '23514';
    end if;
  end loop;
  NEW.used_keys := history || automation_keys(NEW.steps);
  return NEW;
end
$$;
drop trigger if exists automations_reserve_keys on automations;
create trigger automations_reserve_keys before insert or update of steps, used_keys on automations
  for each row execute function reserve_automation_keys();

-- Waiting rows own their matching config. Only old waiting rows are backfilled once.
update automation_steps s set data = coalesce(s.data, '{}'::jsonb) || jsonb_build_object('wait_config', coalesce((
  select case when step ? 'key' then coalesce(step->'config', '{}'::jsonb) else step - 'type' end
  from jsonb_array_elements(a.steps) with ordinality e(step, ordinal)
  where (s.step_key is not null and coalesce(step->>'key', 'step_' || ordinal::text) = s.step_key)
    or (s.step_key is null and not (step ? 'key') and ordinal = s.step_index + 1)
  limit 1
), '{}'::jsonb))
from automation_runs r join automations a on a.tenant_id = r.tenant_id and a.id = r.automation_id
where s.tenant_id = r.tenant_id and s.run_id = r.id and s.state = 'waiting'
  and not (coalesce(s.data, '{}'::jsonb) ? 'wait_config');

-- Explicit flow exits and durable, fresh-state following filters.
alter table automation_runs add column if not exists exit_reason text;
alter table automation_runs add column if not exists guards jsonb not null default '[]';
alter table automation_runs drop constraint if exists automation_runs_exit_reason_check;
alter table automation_runs add constraint automation_runs_exit_reason_check
  check (exit_reason in ('completed', 'exit', 'filter', 'stopped', 'stranded'));
alter table automation_runs drop constraint if exists automation_runs_guards_check;
alter table automation_runs add constraint automation_runs_guards_check check (jsonb_typeof(guards) = 'array');
update automation_runs set exit_reason = case
  when state = 'done' then 'completed'
  when error = 'Its next step was removed or changed while the automation was paused' then 'stranded'
  else 'stopped' end
where exit_reason is null and state in ('done', 'stopped');

-- Persist legacy send intent in bounded batches. Explicit Marketing without a topic stays so.
do $$
declare changed integer;
begin
  loop
    with batch as (
      select id from automations a where exists (
        select 1 from jsonb_array_elements(a.steps) s
        where s->>'type' = 'send_email'
          and not (case when s ? 'key' then coalesce(s->'config', '{}') else s end ? 'kind')
      ) order by id limit 500
    )
    update automations a set steps = (
      select jsonb_agg(case
        when s->>'type' <> 'send_email' then s
        when s ? 'key' then jsonb_set(s, '{config}', coalesce(s->'config', '{}') ||
          jsonb_build_object('kind', coalesce(s->'config'->>'kind',
            case when nullif(s->'config'->>'topic_id', '') is null then 'transactional' else 'marketing' end)))
        else s || jsonb_build_object('kind', coalesce(s->>'kind',
          case when nullif(s->>'topic_id', '') is null then 'transactional' else 'marketing' end))
        end order by ordinal)
      from jsonb_array_elements(a.steps) with ordinality e(s, ordinal)
    ) from batch where a.id = batch.id;
    get diagnostics changed = row_count;
    exit when changed = 0;
  end loop;
end $$;
-- Immutable enrollment depth. Old rows have no reliable original provenance:
-- caller payloads and edited trigger kinds cannot safely supply a backfill.
-- Leave those rows explicitly unknown rather than trusting a legacy @ name.
alter table automation_runs add column if not exists depth integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'automation_runs'::regclass
    and conname = 'automation_runs_depth_check') then
    alter table automation_runs add constraint automation_runs_depth_check check (depth between 0 and 4);
  end if;
end $$;
`;
