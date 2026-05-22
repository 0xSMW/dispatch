import type { InboundInput, SendInput } from "@dispatch/core";

export type TemplateInput = {
  name: string;
  alias?: string;
  subject: string;
  html?: string;
  text?: string;
  variables?: string[];
};

export type ContactInput = {
  email: string;
  first_name?: string;
  last_name?: string;
  properties?: Record<string, unknown>;
  unsubscribed?: boolean;
};

export type SuppressionInput = {
  email: string;
  reason?: string;
};

export type TopicInput = {
  name: string;
  key?: string;
  default_status?: "subscribed" | "unsubscribed";
};

export type SegmentInput = {
  name: string;
  description?: string;
};

export type BroadcastInput = {
  name: string;
  from: string;
  subject?: string;
  html?: string;
  text?: string;
  template?: string;
  variables?: Record<string, unknown>;
  topic_id?: string;
  segment_id?: string;
};

export type CustomEventInput = {
  name: string;
  email?: string;
  data?: Record<string, unknown>;
};

export type AutomationInput = {
  name: string;
  trigger: string;
  steps: Array<
    | { type: "send_email"; from: string; to?: string; template: string; variables?: Record<string, unknown> }
    | { type: "update_contact"; email?: string; properties?: Record<string, unknown>; unsubscribed?: boolean }
    | { type: "add_to_segment"; segment_id: string; email?: string }
    | { type: "delay"; seconds: number }
    | { type: "wait"; event: string; timeout_seconds?: number }
  >;
};

export type ClientOptions = {
  apiKey: string;
  baseUrl?: string;
  userAgent?: string;
};

export class Dispatch {
  private apiKey: string;
  private baseUrl: string;
  private userAgent: string;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "http://localhost:3100";
    this.userAgent = options.userAgent ?? "dispatch-js/0.1.0";
  }

  setup() {
    return this.request("/v1/setup", { auth: false });
  }

  session(input: { email: string; api_key: string }) {
    return this.request("/v1/sessions", { method: "POST", body: input, auth: false });
  }

  me() {
    return this.request("/v1/me");
  }

  users() {
    return this.request("/v1/users");
  }

  createUser(input: { email: string; name: string }) {
    return this.request("/v1/users", { method: "POST", body: input });
  }

  roles() {
    return this.request("/v1/roles");
  }

  createRole(input: { name: string; permissions?: string[] }) {
    return this.request("/v1/roles", { method: "POST", body: input });
  }

  memberships() {
    return this.request("/v1/memberships");
  }

  createMembership(input: { user_id: string; role_id: string }) {
    return this.request("/v1/memberships", { method: "POST", body: input });
  }

  sessions() {
    return this.request("/v1/sessions");
  }

  auditLogs() {
    return this.request("/v1/audit-logs");
  }

  keys() {
    return this.request("/v1/api-keys");
  }

  createKey(input: { name: string; scope?: "full" | "send" }) {
    return this.request("/v1/api-keys", { method: "POST", body: input });
  }

  deleteKey(id: string) {
    return this.request(`/v1/api-keys/${id}`, { method: "DELETE" });
  }

  domains() {
    return this.request("/v1/domains");
  }

  createDomain(input: { name: string; region?: string }) {
    return this.request("/v1/domains", { method: "POST", body: input });
  }

  verifyDomain(id: string) {
    return this.request(`/v1/domains/${id}/verify`, { method: "POST" });
  }

  doctorDomain(id: string) {
    return this.request(`/v1/domains/${id}/doctor`);
  }

  templates() {
    return this.request("/v1/templates");
  }

  createTemplate(input: TemplateInput) {
    return this.request("/v1/templates", { method: "POST", body: input });
  }

  renderTemplate(id: string, variables: Record<string, unknown>) {
    return this.request(`/v1/templates/${id}/render`, { method: "POST", body: { variables } });
  }

  contacts() {
    return this.request("/v1/contacts");
  }

  createContact(input: ContactInput) {
    return this.request("/v1/contacts", { method: "POST", body: input });
  }

  suppressions() {
    return this.request("/v1/suppressions");
  }

  suppress(input: SuppressionInput) {
    return this.request("/v1/suppressions", { method: "POST", body: input });
  }

  unsuppress(id: string) {
    return this.request(`/v1/suppressions/${id}`, { method: "DELETE" });
  }

  topics() {
    return this.request("/v1/topics");
  }

  createTopic(input: TopicInput) {
    return this.request("/v1/topics", { method: "POST", body: input });
  }

  subscribe(topicId: string, input: { email: string; status?: "subscribed" | "unsubscribed" }) {
    return this.request(`/v1/topics/${topicId}/subscriptions`, { method: "POST", body: input });
  }

  topicSubscriptions(topicId: string) {
    return this.request(`/v1/topics/${topicId}/subscriptions`);
  }

  segments() {
    return this.request("/v1/segments");
  }

  createSegment(input: SegmentInput) {
    return this.request("/v1/segments", { method: "POST", body: input });
  }

  addSegmentContact(segmentId: string, input: { email: string }) {
    return this.request(`/v1/segments/${segmentId}/contacts`, { method: "POST", body: input });
  }

  removeSegmentContact(segmentId: string, contactId: string) {
    return this.request(`/v1/segments/${segmentId}/contacts/${contactId}`, { method: "DELETE" });
  }

  segmentContacts(segmentId: string) {
    return this.request(`/v1/segments/${segmentId}/contacts`);
  }

  broadcasts() {
    return this.request("/v1/broadcasts");
  }

  createBroadcast(input: BroadcastInput) {
    return this.request("/v1/broadcasts", { method: "POST", body: input });
  }

  broadcast(id: string) {
    return this.request(`/v1/broadcasts/${id}`);
  }

  sendBroadcast(id: string) {
    return this.request(`/v1/broadcasts/${id}/send`, { method: "POST" });
  }

  pauseBroadcast(id: string) {
    return this.request(`/v1/broadcasts/${id}/pause`, { method: "POST" });
  }

  resumeBroadcast(id: string) {
    return this.request(`/v1/broadcasts/${id}/resume`, { method: "POST" });
  }

  cancelBroadcast(id: string) {
    return this.request(`/v1/broadcasts/${id}/cancel`, { method: "POST" });
  }

  cloneBroadcast(id: string, input: { name?: string } = {}) {
    return this.request(`/v1/broadcasts/${id}/clone`, { method: "POST", body: input });
  }

  events() {
    return this.request("/v1/events");
  }

  createEvent(input: CustomEventInput) {
    return this.request("/v1/events", { method: "POST", body: input });
  }

  event(id: string) {
    return this.request(`/v1/events/${id}`);
  }

  updateEvent(id: string, input: Partial<CustomEventInput>) {
    return this.request(`/v1/events/${id}`, { method: "PATCH", body: input });
  }

  deleteEvent(id: string) {
    return this.request(`/v1/events/${id}`, { method: "DELETE" });
  }

  automations() {
    return this.request("/v1/automations");
  }

  createAutomation(input: AutomationInput) {
    return this.request("/v1/automations", { method: "POST", body: input });
  }

  automation(id: string) {
    return this.request(`/v1/automations/${id}`);
  }

  automationRuns(id: string) {
    return this.request(`/v1/automations/${id}/runs`);
  }

  automationRun(id: string) {
    return this.request(`/v1/automation-runs/${id}`);
  }

  stopAutomation(id: string) {
    return this.request(`/v1/automations/${id}/stop`, { method: "POST" });
  }

  send(input: SendInput, idempotencyKey?: string) {
    return this.request("/v1/emails", {
      method: "POST",
      body: input,
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined
    });
  }

  batch(emails: SendInput[], idempotencyKey?: string) {
    return this.request("/v1/emails/batch", {
      method: "POST",
      body: { emails },
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined
    });
  }

  emails() {
    return this.request("/v1/emails");
  }

  email(id: string) {
    return this.request(`/v1/emails/${id}`);
  }

  updateEmail(id: string, input: Partial<Pick<SendInput, "subject" | "html" | "text" | "headers" | "tags" | "scheduled_at">>) {
    return this.request(`/v1/emails/${id}`, { method: "PATCH", body: input });
  }

  retryEmail(id: string) {
    return this.request(`/v1/emails/${id}/retry`, { method: "POST" });
  }

  emailJobs() {
    return this.request("/v1/email-jobs");
  }

  emailJob(id: string) {
    return this.request(`/v1/email-jobs/${id}`);
  }

  emailAttachments(id: string) {
    return this.request(`/v1/emails/${id}/attachments`);
  }

  emailAttachment(id: string, attachmentId: string) {
    return this.request(`/v1/emails/${id}/attachments/${attachmentId}`);
  }

  emailEvents(id: string) {
    return this.request(`/v1/emails/${id}/events`);
  }

  receivedEmails() {
    return this.request("/v1/received-emails");
  }

  receivedEmail(id: string) {
    return this.request(`/v1/received-emails/${id}`);
  }

  simulateReceivedEmail(input: InboundInput) {
    return this.request("/v1/received-emails/simulate", { method: "POST", body: input });
  }

  receivedAttachments(id: string) {
    return this.request(`/v1/received-emails/${id}/attachments`);
  }

  receivedAttachment(id: string, attachmentId: string) {
    return this.request(`/v1/received-emails/${id}/attachments/${attachmentId}`);
  }

  webhooks() {
    return this.request("/v1/webhooks");
  }

  createWebhook(input: { url: string; events: string[] }) {
    return this.request("/v1/webhooks", { method: "POST", body: input });
  }

  webhookAttempts(id: string) {
    return this.request(`/v1/webhooks/${id}/attempts`);
  }

  replayWebhook(id: string, input: { event_id?: string; attempt_id?: string } = {}) {
    return this.request(`/v1/webhooks/${id}/replay`, { method: "POST", body: input });
  }

  testWebhook() {
    return this.request("/v1/webhooks/test", { method: "POST" });
  }

  logs() {
    return this.request("/v1/logs");
  }

  timeline() {
    return this.request("/v1/timeline");
  }

  usage() {
    return this.request("/v1/usage");
  }

  system() {
    return this.request("/v1/system");
  }

  private async request(path: string, options: { method?: string; body?: unknown; headers?: HeadersInit; auth?: boolean } = {}) {
    const headers = new Headers(options.headers);
    headers.set("user-agent", this.userAgent);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.auth !== false) headers.set("authorization", `Bearer ${this.apiKey}`);

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const message = json?.message ?? response.statusText;
      throw new Error(`${response.status} ${message}`);
    }
    return json;
  }
}
