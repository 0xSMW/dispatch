import { webhookDeliveryStatus } from "@dispatchmail/core";

export type EmailRecipient = { email: string; kind: string };

export type EmailRow = {
  id: string;
  message_id?: string | null;
  from_email: string;
  from_name?: string | null;
  created_at: string | Date;
  subject: string;
  html?: string | null;
  text?: string | null;
  reply_to?: string[] | null;
  status: string;
  scheduled_at?: string | Date | null;
  tags?: Record<string, string> | null;
  recipients?: EmailRecipient[];
};

export function presentEmail(row: EmailRow) {
  const ofKind = (kind: string) =>
    (row.recipients ?? []).filter((recipient) => recipient.kind === kind).map((recipient) => recipient.email);
  return {
    object: "email" as const,
    id: row.id,
    message_id: row.message_id ?? null,
    to: ofKind("to"),
    from: row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email,
    created_at: row.created_at,
    subject: row.subject,
    html: row.html ?? null,
    text: row.text ?? null,
    bcc: ofKind("bcc"),
    cc: ofKind("cc"),
    reply_to: row.reply_to ?? [],
    last_event: lastEvent(row.status),
    scheduled_at: row.scheduled_at ?? null,
    tags: Object.entries(row.tags ?? {}).map(([name, value]) => ({ name, value })),
  };
}

export type DomainRecord = {
  record?: string;
  name: string;
  type: string;
  value: string;
  status?: string;
  ttl?: string;
  priority?: number;
};

export type DomainRow = {
  id: string;
  name: string;
  region: string;
  status: string;
  records?: DomainRecord[] | null;
  checked_at?: string | Date | null;
  created_at?: string | Date;
  return_path?: string | null;
  open_tracking?: boolean | null;
  click_tracking?: boolean | null;
  tracking_subdomain?: string | null;
  tls?: string | null;
  sending?: string | null;
  receiving?: string | null;
  dns_provider?: string | null;
};

export function presentDomain(row: DomainRow) {
  const suffix = `.${row.name}`;
  return {
    object: "domain" as const,
    id: row.id,
    name: row.name,
    status: row.status,
    created_at: row.created_at,
    region: row.region,
    custom_return_path: row.return_path ?? "send",
    open_tracking: Boolean(row.open_tracking),
    click_tracking: Boolean(row.click_tracking),
    tracking_subdomain: row.tracking_subdomain ?? "links",
    tls: row.tls ?? "opportunistic",
    capabilities: {
      sending: row.sending ?? "enabled",
      receiving: row.receiving ?? "disabled",
    },
    records: (row.records ?? []).map((record) => ({
      ...record,
      name: record.name === row.name ? "@" : record.name.endsWith(suffix) ? record.name.slice(0, -suffix.length) : record.name,
    })),
    checked_at: row.checked_at ?? null,
    // Where the domain's DNS is hosted, such as "Cloudflare". Null until the poller has read it.
    dns_provider: row.dns_provider ?? null,
  };
}

function lastEvent(status: string) {
  if (status === "cancelled") return "canceled";
  if (status === "submitted") return "sent";
  return status;
}

export type WebhookRecord = {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string | Date;
};

export function presentWebhook(row: WebhookRecord, signingSecret?: string) {
  const webhook = {
    object: "webhook" as const,
    id: row.id,
    endpoint: row.url,
    events: row.events,
    status: row.enabled ? ("enabled" as const) : ("disabled" as const),
    created_at: row.created_at,
  };
  return signingSecret ? { ...webhook, signing_secret: signingSecret } : webhook;
}

export function presentWebhookEvent(row: {
  id: string;
  type: string;
  created_at: string | Date;
  state: string;
  attempt: number;
}) {
  return {
    object: "webhook_event" as const,
    id: row.id,
    type: row.type,
    created_at: row.created_at,
    status: webhookDeliveryStatus({ state: row.state, attempt: Number(row.attempt) }),
  };
}

export function presentWebhookAttempt(row: {
  id: string;
  status: number | null;
  response: string | null;
  updated_at: string | Date | null;
}) {
  return {
    id: row.id,
    http_status_code: row.status,
    response: row.response,
    sent_at: row.updated_at,
  };
}
