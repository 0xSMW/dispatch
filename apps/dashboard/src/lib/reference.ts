import { matchPath } from "react-router-dom";
import { docsBase } from "./docs";

// The API calls behind each dashboard page, for the in-app API reference drawer.
// One entry per route in main.tsx. Paths use the route's own params, so `:id` on /domains/:id
// becomes the domain on screen. `sdk` is the TypeScript SDK call; null where the SDK has none.

export type Call = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  body?: Record<string, unknown>;
  sdk: string | null;
};

export type Reference = { title: string; calls: Call[]; prompt: string };

const get = (path: string, summary: string, sdk: string | null): Call => ({ method: "GET", path, summary, sdk });
const post = (path: string, summary: string, sdk: string | null, body?: Record<string, unknown>): Call => ({ method: "POST", path, summary, sdk, body });
const patch = (path: string, summary: string, sdk: string | null, body?: Record<string, unknown>): Call => ({ method: "PATCH", path, summary, sdk, body });
const remove = (path: string, summary: string, sdk: string | null): Call => ({ method: "DELETE", path, summary, sdk });

const email = { from: "Acme <hello@acme.com>", to: ["ada@example.com"], subject: "Hello", html: "<p>Hello</p>" };
const segmentRule = { type: "rule", field: "contact.unsubscribed", operator: "eq", value: false };

const pages: Record<string, Omit<Reference, "prompt">> = {
  "/goals": {
    title: "Goals",
    calls: [
      get("/goals?limit=40", "List goals", "dispatch.goals.list({ limit: 40 })"),
      post("/goals", "Create a retroactive event goal", 'dispatch.goals.create({ name: "Upgrade", target: { event: "upgraded" }, windowDays: 30 })',
        { name: "Upgrade", target: { event: "upgraded" }, window_days: 30 }),
      get("/goals/goal_123", "Retrieve a goal", 'dispatch.goals.get("goal_123")'),
      patch("/goals/goal_123", "Update a goal", 'dispatch.goals.update("goal_123", { eligibility: null })', { eligibility: null }),
      remove("/goals/goal_123", "Delete a goal", 'dispatch.goals.remove("goal_123")'),
      get("/goals/goal_123/metrics?broadcast_id=broadcast_123", "Conversions for historical first-send cohorts", 'dispatch.goals.metrics("goal_123", { broadcastId: "broadcast_123" })'),
    ],
  },
  "/setup": { title: "Setup", calls: [get("/setup", "Onboarding progress", "dispatch.setup.get()")] },

  "/emails": {
    title: "Emails",
    calls: [
      get("/emails?limit=40", "List sent emails. Filters: q, status, api_key_id, from, to.", "dispatch.emails.list({ limit: 40 })"),
      post("/emails", "Send an email", `dispatch.emails.send(${JSON.stringify(email)})`, email),
    ],
  },
  "/emails/:id": {
    title: "Email",
    calls: [
      get("/emails/:id", "Retrieve an email", 'dispatch.emails.get(":id")'),
      get("/emails/:id/events?limit=100", "Its delivery events", 'dispatch.emails.events(":id", { limit: 100 })'),
      get("/emails/:id/attachments", "Its attachments", 'dispatch.emails.attachments.list({ emailId: ":id" })'),
      get("/emails/:id/insights", "Deliverability checks", 'dispatch.emails.insights(":id")'),
      post("/emails/:id/share", "Create a share link", 'dispatch.emails.share(":id", { expiresIn: "24h" })', { expires_in: "24h" }),
      post("/emails/:id/cancel", "Cancel a scheduled email", 'dispatch.emails.cancel(":id")'),
    ],
  },
  "/emails/receiving": {
    title: "Received emails",
    calls: [
      get("/emails/receiving?limit=40", "List received emails. Filters: q, from, to.", "dispatch.emails.receiving.list({ limit: 40 })"),
      post("/emails/receiving/simulate", "Simulate an inbound email", 'dispatch.emails.receiving.simulate({ from: "sender@example.net", to: ["inbox@acme.com"], subject: "Hello", text: "Hello" })', {
        from: "sender@example.net",
        to: ["inbox@acme.com"],
        subject: "Hello",
        text: "Hello",
      }),
    ],
  },
  "/emails/receiving/:id": {
    title: "Received email",
    calls: [get("/emails/receiving/:id", "Retrieve a received email", 'dispatch.emails.receiving.get(":id")')],
  },
  "/emails/suppressions": {
    title: "Suppressions",
    calls: [
      get("/suppressions?limit=40", "List suppressed addresses. Filters: q, origin, from, to.", "dispatch.suppressions.list({ limit: 40 })"),
      post("/suppressions/batch/add", "Suppress up to 100 addresses", 'dispatch.suppressions.batchAdd(["ada@example.com"])', { emails: ["ada@example.com"] }),
      post("/suppressions/batch/remove", "Remove up to 100 addresses", 'dispatch.suppressions.batchRemove({ emails: ["ada@example.com"] })', { emails: ["ada@example.com"] }),
    ],
  },
  "/emails/send": { title: "Send", calls: [post("/emails", "Send an email", `dispatch.emails.send(${JSON.stringify(email)})`, email)] },

  "/broadcasts": {
    title: "Broadcasts",
    calls: [
      get("/broadcasts?limit=40", "List broadcasts. Filters: q, status, segment_id.", "dispatch.broadcasts.list({ limit: 40 })"),
      post("/broadcasts", "Create a draft", 'dispatch.broadcasts.create({ from: "Acme <news@acme.com>", segmentId: "seg_123", subject: "October update" })', {
        from: "Acme <news@acme.com>",
        segment_id: "seg_123",
        subject: "October update",
      }),
    ],
  },
  "/broadcasts/:id": {
    title: "Broadcast",
    calls: [
      get("/broadcasts/:id", "Retrieve a broadcast", 'dispatch.broadcasts.get(":id")'),
      get("/broadcasts/:id/recipients?type=opened", "Recipients by outcome", 'dispatch.broadcasts.recipients(":id", { type: "opened" })'),
      get("/broadcasts/:id/clicked-links", "Top clicked links", 'dispatch.broadcasts.clickedLinks(":id")'),
      get("/goals/goal_123/metrics?broadcast_id=:id", "Goal conversions for this broadcast", 'dispatch.goals.metrics("goal_123", { broadcastId: ":id" })'),
      post("/broadcasts/:id/cancel", "Cancel a scheduled broadcast", 'dispatch.broadcasts.cancel(":id")'),
    ],
  },
  "/broadcasts/:id/editor": {
    title: "Broadcast editor",
    calls: [
      patch("/broadcasts/:id", "Save the draft", 'dispatch.broadcasts.update(":id", { subject: "October update", html: "<p>Hi</p>" })', { subject: "October update", html: "<p>Hi</p>" }),
      get("/broadcasts/:id/audience", "Count who it will reach", 'dispatch.broadcasts.audience(":id")'),
      post("/links/check", "Check the links", 'dispatch.links.check(["https://acme.com"])', { urls: ["https://acme.com"] }),
      post("/broadcasts/:id/send", "Send now, or schedule", 'dispatch.broadcasts.send(":id", { scheduledAt: "in 1 hour" })', { scheduled_at: "in 1 hour" }),
    ],
  },

  "/automations": {
    title: "Automations",
    calls: [
      get("/automations?limit=40", "List automations. Filter: status.", "dispatch.automations.list({ limit: 40 })"),
      post("/automations", "Create an automation", 'dispatch.automations.create({ name: "Welcome", steps: [{ key: "trigger", type: "trigger", config: { type: "event", event_name: "user.created" } }], connections: [] })', {
        name: "Welcome",
        steps: [{ key: "trigger", type: "trigger", config: { type: "event", event_name: "user.created" } }],
        connections: [],
      }),
    ],
  },
  "/events": {
    title: "Events",
    calls: [
      get("/events", "List event definitions", "dispatch.events.list()"),
      post("/events/send", "Fire an event", 'dispatch.events.send({ event: "user.created", email: "ada@example.com" })', {
        event: "user.created",
        email: "ada@example.com",
      }),
      get("/fired-events?limit=20", "Recently fired events", "dispatch.events.fired.list({ limit: 20 })"),
    ],
  },
  "/automations/:id/editor": {
    title: "Automation",
    calls: [
      get("/automations/:id", "Retrieve an automation", 'dispatch.automations.get(":id")'),
      patch("/automations/:id", "Save steps, or start with status enabled", 'dispatch.automations.update(":id", { status: "enabled" })', { status: "enabled" }),
      get("/automations/:id/runs?limit=40", "List runs. Filters: status, start_date, end_date.", 'dispatch.automations.runs.list(":id", { limit: 40 })'),
      get("/automations/:id/runs/metrics", "Run counts by status and day", 'dispatch.automations.runs.metrics(":id")'),
      get("/goals/goal_123/metrics?automation_id=:id", "Goal conversions for this automation", 'dispatch.goals.metrics("goal_123", { automationId: ":id" })'),
      get("/automations/:id/steps/split_123/metrics", "Compare split variants; replace split_123 with the stored step key", 'dispatch.automations.splitMetrics(":id", "split_123")'),
      post("/automations/:id/steps/split_123/winner", "Requires an already paused automation and its current version; resume separately only after success", 'dispatch.automations.pickWinner(":id", "split_123", { variant: "variant_b", version: 1 })', { variant: "variant_b", version: 1 }),
    ],
  },

  "/templates": {
    title: "Templates",
    calls: [
      get("/templates?limit=100", "List templates. Filters: q, status.", "dispatch.templates.list({ limit: 100 })"),
      post("/templates", "Create a draft template", 'dispatch.templates.create({ name: "Welcome", html: "<p>Hi {{{NAME}}}</p>" })', { name: "Welcome", html: "<p>Hi {{{NAME}}}</p>" }),
    ],
  },
  "/templates/library": {
    title: "Template library",
    calls: [
      get("/template-library", "List the default templates", "dispatch.templates.library.list()"),
      get("/template-library/automations", "List lifecycle presets", "dispatch.templates.library.automations()"),
      get("/template-library/automations/onboarding-drip", "Preview a lifecycle preset", 'dispatch.templates.library.automation("onboarding-drip")'),
      post("/template-library/automations/onboarding-drip/install", "Install disabled, then review and enable", 'dispatch.templates.library.installAutomation("onboarding-drip", { from: "Acme <hello@acme.com>", topicId: "topic_123" })', { from: "Acme <hello@acme.com>", topic_id: "topic_123" }),
      post("/template-library/welcome/install", "Install one", 'dispatch.templates.library.install("welcome")'),
    ],
  },
  "/templates/:id": {
    title: "Template",
    calls: [
      get("/templates/:id", "Retrieve a template", 'dispatch.templates.get(":id")'),
      get("/templates/:id/versions", "List its versions", 'dispatch.templates.versions.list(":id")'),
      post("/templates/:id/publish", "Publish the latest version", 'dispatch.templates.publish(":id")'),
      patch("/templates/:id", "Turn tracking on or off", 'dispatch.templates.update(":id", { track: false })', { track: false }),
    ],
  },
  "/templates/:id/editor": {
    title: "Template editor",
    calls: [
      patch("/templates/:id", "Save the draft", 'dispatch.templates.update(":id", { subject: "Welcome", html: "<p>Hi</p>" })', { subject: "Welcome", html: "<p>Hi</p>" }),
      post("/templates/:id/render", "Render the draft on the server", 'dispatch.templates.render(":id", { NAME: "Ada" }, { draft: true })', { variables: { NAME: "Ada" }, draft: true }),
      post("/templates/:id/publish", "Publish", 'dispatch.templates.publish(":id")'),
    ],
  },

  "/audience": {
    title: "Contacts",
    calls: [
      get("/contacts?limit=40", "List contacts. Filters: q, subscribed, segment_id.", "dispatch.contacts.list({ limit: 40 })"),
      get("/contacts/stats", "Contact counts", "dispatch.contacts.stats()"),
      post("/contacts", "Add a contact", 'dispatch.contacts.create({ email: "ada@example.com", firstName: "Ada" })', { email: "ada@example.com", first_name: "Ada" }),
      remove("/contacts/contact_123", "Delete a contact", 'dispatch.contacts.remove("contact_123")'),
    ],
  },
  "/audience/contacts/:id": {
    title: "Contact",
    calls: [
      get("/contacts/:id", "Retrieve a contact", 'dispatch.contacts.get(":id")'),
      get("/contacts/:id/activity", "Its activity", 'dispatch.contacts.activity(":id")'),
      patch("/contacts/:id", "Update it", 'dispatch.contacts.update({ id: ":id", firstName: "Ada" })', { first_name: "Ada" }),
    ],
  },
  "/audience/properties": {
    title: "Contact properties",
    calls: [
      get("/contact-properties", "List properties", "dispatch.contactProperties.list()"),
      post("/contact-properties", "Add a property", 'dispatch.contactProperties.create({ key: "plan", type: "string" })', { key: "plan", type: "string" }),
    ],
  },
  "/audience/segments": {
    title: "Segments",
    calls: [
      get("/segments", "List segments", "dispatch.segments.list()"),
      post("/segments", "Create a segment", 'dispatch.segments.create({ name: "Customers" })', { name: "Customers" }),
      post("/segments/preview", "Preview a dynamic rule before saving it", `dispatch.segments.preview(${JSON.stringify(segmentRule)})`, { rule: segmentRule }),
      patch("/segments/segment_123", "Convert to a dynamic segment; manual membership writes then become unavailable", `dispatch.segments.update("segment_123", { rule: ${JSON.stringify(segmentRule)} })`, { rule: segmentRule }),
    ],
  },
  "/audience/topics": {
    title: "Topics",
    calls: [
      get("/topics", "List topics", "dispatch.topics.list()"),
      post("/topics", "Create a topic", 'dispatch.topics.create({ name: "Product news", defaultSubscription: "opt_in" })', {
        name: "Product news",
        default_subscription: "opt_in",
      }),
    ],
  },
  "/audience/forms": {
    title: "Signup forms",
    calls: [
      get("/forms?limit=40", "List signup forms", "dispatch.forms.list({ limit: 40 })"),
      post("/forms", "Create a double opt-in form with a live topic, verified sender and exact allowed origin", 'dispatch.forms.create({ name: "Newsletter", topicIds: ["topic_123"], fromEmail: "hello@acme.com", allowedOrigins: ["https://acme.com"] })',
        { name: "Newsletter", topic_ids: ["topic_123"], from_email: "hello@acme.com", allowed_origins: ["https://acme.com"] }),
      get("/forms/form_123", "Retrieve a form", 'dispatch.forms.get("form_123")'),
      patch("/forms/form_123", "Update allowed origins", 'dispatch.forms.update("form_123", { allowedOrigins: ["https://acme.com"] })', { allowed_origins: ["https://acme.com"] }),
      remove("/forms/form_123", "Delete a form", 'dispatch.forms.remove("form_123")'),
    ],
  },

  "/metrics": {
    title: "Metrics",
    calls: [
      get("/emails/metrics?dimensions=period", "Sent, delivered, bounced, and complained counts", 'dispatch.emails.metrics({ dimensions: ["period"] })'),
      get("/goals/goal_123/metrics", "Goal conversions across real-send cohorts; optionally scope by automation or broadcast", 'dispatch.goals.metrics("goal_123")'),
    ],
  },

  "/domains": {
    title: "Domains",
    calls: [
      get("/domains?limit=40", "List domains. Filters: q, status, region.", "dispatch.domains.list({ limit: 40 })"),
      remove("/domains/domain_123", "Delete a domain", 'dispatch.domains.remove("domain_123")'),
    ],
  },
  "/domains/add": {
    title: "Add domain",
    calls: [post("/domains", "Add a domain", 'dispatch.domains.create({ name: "send.acme.com", region: "us-east-1" })', { name: "send.acme.com", region: "us-east-1" })],
  },
  "/domains/:id": {
    title: "Domain",
    calls: [
      get("/domains/:id", "Retrieve a domain and its DNS records", 'dispatch.domains.get(":id")'),
      post("/domains/:id/verify", "Check DNS again", 'dispatch.domains.verify(":id")'),
      get("/domains/:id/doctor", "Compare each record with DNS", 'dispatch.domains.doctor(":id")'),
      patch("/domains/:id", "Change tracking and TLS", 'dispatch.domains.update({ id: ":id", openTracking: true })', { open_tracking: true }),
    ],
  },

  "/logs": {
    title: "Logs",
    calls: [
      get("/logs?limit=40", "List API requests. Filters: q, email_id, status, user_agent, api_key_id, start_date, end_date.", "dispatch.logs.list({ limit: 40 })"),
      get("/logs/export", "Export the last 1,000 requests", "dispatch.logs.export()"),
    ],
  },
  "/logs/:id": { title: "Log", calls: [get("/logs/:id", "Retrieve a request with its bodies", 'dispatch.logs.get(":id")')] },

  "/api-keys": {
    title: "API keys",
    calls: [
      get("/api-keys", "List keys", "dispatch.apiKeys.list()"),
      post("/api-keys", "Create a key", 'dispatch.apiKeys.create({ name: "Production", permission: "sending_access" })', {
        name: "Production",
        permission: "sending_access",
      }),
    ],
  },
  "/api-keys/:id": {
    title: "API key",
    calls: [
      get("/api-keys/:id", "Retrieve a key with its use count", 'dispatch.apiKeys.get(":id")'),
      remove("/api-keys/:id", "Remove it", 'dispatch.apiKeys.remove(":id")'),
    ],
  },

  "/webhooks": {
    title: "Webhooks",
    calls: [
      get("/webhooks", "List webhooks", "dispatch.webhooks.list()"),
      post("/webhooks", "Add a webhook", 'dispatch.webhooks.create({ endpoint: "https://acme.com/hooks", events: ["email.delivered"] })', {
        endpoint: "https://acme.com/hooks",
        events: ["email.delivered"],
      }),
    ],
  },
  "/webhooks/:id": {
    title: "Webhook",
    calls: [
      get("/webhooks/:id", "Retrieve a webhook", 'dispatch.webhooks.get(":id")'),
      get("/webhooks/:id/events", "List its deliveries", 'dispatch.webhooks.events.list(":id")'),
      post("/webhooks/:id/signing-secret/rotate", "Rotate the signing secret", 'dispatch.webhooks.rotateSigningSecret(":id")'),
    ],
  },

  "/settings/general": {
    title: "General settings",
    calls: [
      get("/settings", "Retrieve settings", "dispatch.settings.get()"),
      patch("/settings", "Update settings", "dispatch.settings.update({ importTriggerAutomations: false })", { import_trigger_automations: false }),
    ],
  },
  "/settings/integrations": {
    title: "Integrations",
    calls: [
      get("/integrations", "List credential-free integrations", "dispatch.integrations.list()"),
      post("/integrations", "Create an integration; save its URL once", 'dispatch.integrations.create({ provider: "webhook", name: "App", secret: "SIGNING_SECRET" })',
        { provider: "webhook", name: "App", secret: "SIGNING_SECRET" }),
      get("/integrations/integration_123/deliveries?limit=20", "Inspect body-free recent deliveries", 'dispatch.integrations.deliveries("integration_123", { limit: 20 })'),
      post("/integrations/integration_123/rotate", "Replace its URL token", 'dispatch.integrations.rotate("integration_123")', {}),
    ],
  },
  "/settings/usage": {
    title: "Usage",
    calls: [get("/usage", "Usage counters", "dispatch.usage.get()"), get("/system", "Sending quota and system state", "dispatch.system.get()")],
  },
  "/settings/team": {
    title: "Team",
    calls: [
      get("/memberships", "List members", "dispatch.memberships.list()"),
      get("/sessions", "List sessions", "dispatch.sessions.list()"),
      get("/audit-logs", "List audit logs. Filter: action.", "dispatch.auditLogs.list()"),
    ],
  },
  "/settings/smtp": { title: "SMTP", calls: [get("/system", "Relay host and ports", "dispatch.system.get()")] },
  "/settings/brand": {
    title: "Brand",
    calls: [get("/brand", "Retrieve the brand", "dispatch.brand.get()"), patch("/brand", "Update it", 'dispatch.brand.update({ product_name: "Acme" })', { product_name: "Acme" }),
      post("/brand/update-library", "Update unedited installed library copies; list skipped edits", "dispatch.brand.updateLibrary()")],
  },
  "/settings/unsubscribe-page": {
    title: "Unsubscribe page",
    calls: [get("/brand", "Logo and color", "dispatch.brand.get()"), get("/topics", "Topics on the page", "dispatch.topics.list()")],
  },
  "/settings/unsubscribe-page/edit": {
    title: "Unsubscribe page editor",
    calls: [get("/brand", "Page content and appearance", "dispatch.brand.get()"), patch("/brand", "Update page content", 'dispatch.brand.update({ unsubscribe_title: "Email preferences" })', { unsubscribe_title: "Email preferences" })],
  },
  "/timeline": { title: "Timeline", calls: [get("/timeline", "Recent activity across resources", "dispatch.timeline.list()")] },
};

// Canonical page prompts. Public guides can reuse these words without adding deployment secrets.
const goals: Record<string, string> = {
  Goals: "Help me define retroactive event or contact-state goals and compare real-send conversion cohorts. Explain current eligibility and retained-history limits.",
  Setup: "Help me complete Dispatch setup: verify a sending domain, create an API key, and send a first transactional email.",
  Emails: "Help me send and inspect transactional email with Dispatch.",
  Email: "Help me inspect an email's delivery events, attachments, and deliverability checks.",
  "Received emails": "Help me list received emails and test inbound email handling with Dispatch.",
  "Received email": "Help me inspect a received email with Dispatch.",
  Suppressions: "Help me inspect suppressed addresses and explain the effects before changing a suppression.",
  Send: "Help me send a transactional email with Dispatch without requiring contacts, topics, or automations.",
  Broadcasts: "Help me draft a marketing broadcast for a segment and topic in Dispatch.",
  Broadcast: "Help me inspect a broadcast's recipients and clicked links in Dispatch.",
  "Broadcast editor": "Help me review a broadcast's content, links, and audience before scheduling it.",
  Automations: "Help me review Dispatch lifecycle presets and draft a disabled automation using the shipped API.",
  Events: "Help me define and send an app event in Dispatch, including the fields its automation needs.",
  Automation: "Help me inspect an automation's graph, runs, goal conversions and split variants. Explain pause, resume and stop, and require the current paused version before selecting a split winner.",
  Templates: "Help me create a reusable Dispatch email template and declare its required variables and optional fallbacks.",
  "Template library": "Help me choose and install a Dispatch lifecycle preset with a verified sender. Newsletter welcome requires a live tenant topic at installation; other Marketing presets may install disabled without one. Review reused emails and the disabled automation before enabling.",
  Template: "Help me inspect a Dispatch template's versions, variables, tracking, and Transactional or Marketing kind.",
  "Template editor": "Help me edit and render a Dispatch template draft with test variables before publishing it.",
  Contacts: "Help me add and inspect Dispatch contacts while preserving their consent preferences.",
  Contact: "Help me inspect a contact's activity and update only the fields I approve.",
  "Contact properties": "Help me declare typed contact properties in Dispatch for my app-owned state.",
  Segments: "Help me organize contacts in static or rule-based dynamic Dispatch segments. Preview the supported typed rule and explain that dynamic membership is read-only before converting.",
  Topics: "Help me configure Dispatch marketing topics and explain opt-in and opt-out behavior.",
  "Signup forms": "Help me configure a Dispatch signup form with live topics, a verified sender, exact allowed origins and scanner-safe double opt-in confirmation. Preserve consent and never put an API key in the public form.",
  Metrics: "Help me read Dispatch email metrics, excluding sandbox activity from real engagement.",
  Domains: "Help me inspect sending domains and their verification status in Dispatch.",
  "Add domain": "Help me add a Dispatch sending domain and explain the DNS records I need to publish.",
  Domain: "Help me inspect a Dispatch domain's DNS records, verification checks, tracking, and TLS settings.",
  Logs: "Help me inspect Dispatch API request logs and identify a failed request without exposing secrets.",
  Log: "Help me diagnose a Dispatch API request from its status and redacted request and response bodies.",
  "API keys": "Help me choose a least-privilege Dispatch API key and explain how to store it in an environment variable.",
  "API key": "Help me review a Dispatch API key's usage and explain revocation before removing it.",
  Webhooks: "Help me configure an outgoing Dispatch webhook for the events my app needs and verify its signatures.",
  Webhook: "Help me inspect Dispatch webhook deliveries and explain signing-secret rotation before making changes.",
  Integrations: "Help me inspect Dispatch inbound integrations and body-free deliveries, explain provider signatures and one-time URL rotation, and preserve consent and deleted contacts.",
  "General settings": "Help me review Dispatch import-trigger defaults and sandbox domains before changing settings.",
  Usage: "Help me inspect Dispatch usage counters and sending quota.",
  Team: "Help me inspect Dispatch memberships, sessions, and audit logs with my current permissions.",
  SMTP: "Help me find Dispatch SMTP relay settings and send transactional email without lifecycle setup.",
  Brand: "Help me review Dispatch brand values and safe theme tokens. Explain that saving does not rewrite installed emails; explicitly update library templates only after approval and preserve edited copies.",
  "Unsubscribe page editor": "Help me customize Dispatch preference and success page content and appearance, preview changes, and save only the intended page overrides.",
  "Unsubscribe page": "Help me review Dispatch unsubscribe-page branding and marketing topics while preserving recipient consent.",
  Timeline: "Help me inspect recent Dispatch activity across resources.",
};

export const references: Record<string, Reference> = Object.fromEntries(
  Object.entries(pages).map(([path, page]) => [path, {
    ...page,
    prompt: `${goals[page.title]} Use the public documentation for my running Dispatch version and only shipped endpoints and SDK methods. Read DISPATCH_API_URL and DISPATCH_API_KEY from my environment; never print or embed the key. Respect my current permissions and ask for confirmation before sending email, publishing, deleting, or changing live configuration.`,
  }]),
);

const llmDocuments = import.meta.glob<string>(
  ["../../../../docs/llms.txt", "../../../../docs/llms-full.txt"],
  { query: "?url", import: "default", eager: true },
);

/** No link is advertised until that public output is present in this dashboard build. */
export function llmsLinks(documents = llmDocuments, configured?: string): Array<{ label: string; href: string }> {
  return ["llms.txt", "llms-full.txt"]
    .filter((name) => Boolean(documents[`../../../../docs/${name}`]?.trim()))
    .map((name) => ({ label: name, href: `${docsBase(configured)}${name}` }));
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The reference for a location, with route params such as `:id` filled in. Null for a page with none. */
export function referenceFor(pathname: string): Reference | null {
  if (pathname === "/automations/events") pathname = "/events";
  for (const [pattern, reference] of Object.entries(references)) {
    const match = matchPath(pattern, pathname);
    if (!match) continue;
    // Static routes such as /emails/receiving also match /emails/:id. Prefer the static one.
    if (pattern.includes(":") && Object.keys(references).some((other) => !other.includes(":") && matchPath(other, pathname))) continue;
    const fill = (text: string, encode: (value: string) => string) => text.replace(/:([a-z_]+)/g, (whole, name: string) =>
      match.params[name] === undefined ? whole : encode(decode(match.params[name]!)),
    );
    return {
      ...reference,
      calls: reference.calls.map((call) => ({
        ...call,
        path: fill(call.path, encodeURIComponent),
        sdk: call.sdk ? fill(call.sdk, (value) => JSON.stringify(value).slice(1, -1)) : null,
      })),
    };
  }
  return null;
}

/** A curl command for one call. The key comes from the environment, never from the dashboard. */
export function curl(call: Call, apiUrl: string) {
  const url = `${apiUrl.replace(/\/+$/, "")}${call.path}`.replace(/[\\$`"]/g, "\\$&");
  const lines = [`curl -X ${call.method} "${url}"`, '  -H "Authorization: Bearer $DISPATCH_API_KEY"'];
  if (call.body) {
    lines.push('  -H "Content-Type: application/json"');
    lines.push(`  -d '${JSON.stringify(call.body).replaceAll("'", "'\\''")}'`);
  }
  return lines.join(" \\\n");
}

/** A TypeScript SDK snippet for one call. */
export function sdk(call: Call, apiUrl: string) {
  if (!call.sdk) return null;
  return [
    'import { Dispatch } from "@dispatchmail/sdk";',
    "",
    `const dispatch = new Dispatch({ apiKey: process.env.DISPATCH_API_KEY, baseUrl: ${JSON.stringify(apiUrl)} });`,
    `const { data, error } = await ${call.sdk};`,
  ].join("\n");
}

type Arguments = "none" | "query" | "id" | "body" | "idBody" | "idQuery" | "send" | "share" | "publish" | "links" | "event" | "recipients" | "schedule" | "emails" | "unsuppress" | "render" | "install" | "integration" | "goal" | "form" | "rule" | "stepQuery" | "winner";
type FlatCall = [python: string | null, go: string | null, args: Arguments];

// These clients are flat, not translations of the TypeScript namespace. Null means unsupported.
const flatCalls: Record<string, FlatCall> = {
  "GET /goals": ["goals", "Goals", "query"],
  "POST /goals": ["create_goal", "CreateGoal", "goal"],
  "GET /goals/:id": ["goal", "Goal", "id"],
  "PATCH /goals/:id": ["update_goal", "UpdateGoal", "idBody"],
  "DELETE /goals/:id": ["delete_goal", "DeleteGoal", "id"],
  "GET /goals/:id/metrics": ["goal_metrics", "GoalMetrics", "idQuery"],
  "POST /brand/update-library": ["update_library_templates", "UpdateLibraryTemplates", "none"],
  "GET /setup": ["setup", "Setup", "none"],
  "GET /emails": ["emails", "Emails", "query"],
  "POST /emails": ["send", "Send", "send"],
  "GET /emails/receiving": ["received_emails", "ReceivedEmails", "query"],
  "POST /emails/receiving/simulate": ["simulate_received_email", "SimulateReceivedEmail", "body"],
  "GET /emails/receiving/:id": ["received_email", "ReceivedEmail", "id"],
  "GET /emails/:id": ["email", "Email", "id"],
  "GET /emails/:id/events": ["email_events", "EmailEvents", "idQuery"],
  "GET /emails/:id/attachments": ["email_attachments", "EmailAttachments", "idQuery"],
  "POST /emails/:id/share": ["share_email", "ShareEmail", "share"],
  "POST /emails/:id/cancel": ["cancel_email", "CancelEmail", "id"],
  "GET /suppressions": ["suppressions", "Suppressions", "query"],
  "POST /suppressions/batch/add": ["suppress_batch", "SuppressBatch", "emails"],
  "POST /suppressions/batch/remove": ["unsuppress_batch", "UnsuppressBatch", "unsuppress"],
  "GET /broadcasts": ["broadcasts", "Broadcasts", "query"],
  "POST /broadcasts": ["create_broadcast", "CreateBroadcast", "body"],
  "GET /broadcasts/:id": ["broadcast", "Broadcast", "id"],
  "GET /broadcasts/:id/recipients": ["broadcast_recipients", "BroadcastRecipients", "recipients"],
  "GET /broadcasts/:id/clicked-links": ["broadcast_clicked_links", "BroadcastClickedLinks", "idQuery"],
  "POST /broadcasts/:id/cancel": ["cancel_broadcast", "CancelBroadcast", "id"],
  "PATCH /broadcasts/:id": ["update_broadcast", "UpdateBroadcast", "idBody"],
  "GET /broadcasts/:id/audience": ["broadcast_audience", "BroadcastAudience", "id"],
  "POST /broadcasts/:id/send": ["send_broadcast", "SendBroadcast", "schedule"],
  "POST /links/check": ["check_links", "CheckLinks", "links"],
  "GET /automations": ["automations", "Automations", "query"],
  "POST /automations": ["create_automation", "CreateAutomation", "body"],
  "GET /automations/:id": ["automation", "Automation", "id"],
  "PATCH /automations/:id": ["update_automation", "UpdateAutomation", "idBody"],
  "GET /automations/:id/runs": ["automation_runs", "AutomationRuns", "idQuery"],
  "GET /automations/:id/runs/metrics": ["automation_run_metrics", "AutomationRunMetrics", "idQuery"],
  "GET /automations/:id/steps/:key/metrics": ["automation_split_metrics", "AutomationSplitMetrics", "stepQuery"],
  "POST /automations/:id/steps/:key/winner": ["pick_automation_winner", "PickAutomationWinner", "winner"],
  "GET /events": ["events", "Events", "query"],
  "POST /events/send": ["send_event", "SendEvent", "event"],
  "GET /fired-events": ["fired_events", "FiredEvents", "query"],
  "GET /templates": ["templates", "Templates", "query"],
  "POST /templates": ["create_template", "CreateTemplate", "body"],
  "GET /templates/:id": ["template", "Template", "id"],
  "GET /templates/:id/versions": ["template_versions", "TemplateVersions", "id"],
  "POST /templates/:id/publish": ["publish_template", "PublishTemplate", "publish"],
  "PATCH /templates/:id": ["update_template", "UpdateTemplate", "idBody"],
  "POST /templates/:id/render": ["render_template", "RenderTemplate", "render"],
  "GET /template-library": ["template_library", "TemplateLibrary", "none"],
  "GET /template-library/automations": ["template_library_automations", "TemplateLibraryAutomations", "none"],
  "GET /template-library/automations/:slug": ["template_library_automation", "TemplateLibraryAutomation", "id"],
  "POST /template-library/:slug/install": ["install_template", "InstallTemplate", "id"],
  "POST /template-library/automations/:slug/install": ["template_library_install_automation", "TemplateLibraryInstallAutomation", "install"],
  "GET /contacts": ["contacts", "Contacts", "query"],
  "POST /contacts": ["create_contact", "CreateContact", "body"],
  "GET /contacts/stats": [null, null, "none"],
  "GET /contacts/:id": ["contact", "Contact", "id"],
  "DELETE /contacts/:id": ["delete_contact", "DeleteContact", "id"],
  "GET /contacts/:id/activity": ["contact_activity", "ContactActivity", "idQuery"],
  "PATCH /contacts/:id": ["update_contact", "UpdateContact", "idBody"],
  "GET /contact-properties": ["contact_properties", "ContactProperties", "query"],
  "POST /contact-properties": ["create_contact_property", "CreateContactProperty", "body"],
  "GET /segments": ["segments", "Segments", "query"],
  "POST /segments": ["create_segment", "CreateSegment", "body"],
  "POST /segments/preview": ["preview_segment", "PreviewSegment", "rule"],
  "PATCH /segments/:id": ["update_segment", "UpdateSegment", "idBody"],
  "GET /topics": ["topics", "Topics", "query"],
  "POST /topics": ["create_topic", "CreateTopic", "body"],
  "GET /forms": ["forms", "Forms", "query"],
  "POST /forms": ["create_form", "CreateForm", "form"],
  "GET /forms/:id": ["form", "Form", "id"],
  "PATCH /forms/:id": ["update_form", "UpdateForm", "idBody"],
  "DELETE /forms/:id": ["delete_form", "DeleteForm", "id"],
  "GET /emails/metrics": ["email_metrics", "EmailMetrics", "query"],
  "GET /domains": ["domains", "Domains", "query"],
  "DELETE /domains/:id": ["delete_domain", "DeleteDomain", "id"],
  "POST /domains": ["create_domain", "CreateDomain", "body"],
  "GET /domains/:id": ["domain", "Domain", "id"],
  "POST /domains/:id/verify": ["verify_domain", "VerifyDomain", "id"],
  "GET /domains/:id/doctor": ["doctor_domain", "DoctorDomain", "id"],
  "PATCH /domains/:id": ["update_domain", "UpdateDomain", "idBody"],
  "GET /logs": ["logs", "Logs", "query"],
  "GET /logs/export": ["logs_export", "LogsExport", "none"],
  "GET /logs/:id": ["log", "Log", "id"],
  "GET /api-keys": ["api_keys", "APIKeys", "query"],
  "POST /api-keys": ["create_api_key", "CreateAPIKey", "body"],
  "DELETE /api-keys/:id": ["delete_api_key", "DeleteAPIKey", "id"],
  "GET /webhooks": ["webhooks", "Webhooks", "query"],
  "POST /webhooks": ["create_webhook", "CreateWebhook", "body"],
  "GET /webhooks/:id": ["webhook", "Webhook", "id"],
  "GET /webhooks/:id/events": ["webhook_events", "WebhookEvents", "idQuery"],
  "POST /webhooks/:id/signing-secret/rotate": ["rotate_webhook_secret", "RotateWebhookSecret", "id"],
  "GET /integrations": ["integrations", "Integrations", "query"],
  "POST /integrations": ["create_integration", "CreateIntegration", "integration"],
  "GET /integrations/:id": ["integration", "Integration", "id"],
  "PATCH /integrations/:id": ["update_integration", "UpdateIntegration", "idBody"],
  "DELETE /integrations/:id": ["delete_integration", "DeleteIntegration", "id"],
  "POST /integrations/:id/rotate": ["rotate_integration", "RotateIntegration", "id"],
  "GET /integrations/:id/deliveries": ["integration_deliveries", "IntegrationDeliveries", "idQuery"],
  "GET /settings": ["settings", "Settings", "none"],
  "PATCH /settings": ["update_settings", "UpdateSettings", "body"],
  "GET /usage": ["usage", "Usage", "none"],
  "GET /system": ["system", "System", "none"],
  "GET /memberships": ["memberships", "Memberships", "query"],
  "GET /sessions": ["sessions", "Sessions", "query"],
  "GET /audit-logs": ["audit_logs", "AuditLogs", "query"],
  "GET /brand": ["brand", "Brand", "none"],
  "PATCH /brand": ["update_brand", "UpdateBrand", "body"],
  "GET /timeline": ["timeline", "Timeline", "query"],
};

function literal(value: unknown, language: "python" | "go"): string {
  if (value === null) return language === "python" ? "None" : "nil";
  if (typeof value === "boolean") return language === "python" ? (value ? "True" : "False") : String(value);
  if (Array.isArray(value)) return `${language === "go" ? "[]any{" : "["}${value.map((item) => literal(item, language)).join(", ")}${language === "go" ? "}" : "]"}`;
  if (typeof value === "object") return `${language === "go" ? "dispatch.Map{" : "{"}${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${JSON.stringify(key)}: ${literal(item, language)}`).join(", ")}}`;
  return JSON.stringify(value);
}

function flatCall(call: Call, language: "python" | "go"): string | null {
  const [path, search] = call.path.split("?");
  // Static endpoints such as /contacts/stats must never become a get-contact call.
  const bindings = Object.entries(flatCalls).sort(([a], [b]) => Number(a.includes(":")) - Number(b.includes(":")));
  for (const [route, [py, go, args]] of bindings) {
    const [method, pattern] = route.split(" ");
    const match = method === call.method ? matchPath(pattern!, path!) : null;
    if (!match) continue;
    const name = language === "python" ? py : go;
    if (!name || (args === "render" && call.body?.draft === true)) return null;
    const body = call.body ?? {};
    const value = (input: unknown) => literal(input, language);
    const id = value(decode(match.params.id ?? match.params.slug ?? ""));
    const query = new URLSearchParams(search);
    const queryArgs = () => language === "python"
      ? [...query].map(([key, item]) => `${key}=${value(/^\d+$/.test(item) ? Number(item) : item)}`).join(", ")
      : `url.Values{${[...query].map(([key, item]) => `${JSON.stringify(key)}: {${JSON.stringify(item)}}`).join(", ")}}`;
    const strings = (items: unknown) => language === "python" ? value(items) : `[]string{${(items as string[]).map((item) => JSON.stringify(item)).join(", ")}}`;
    let input: string;
    switch (args) {
      case "none": input = ""; break;
      case "query": input = queryArgs(); break;
      case "id": input = id; break;
      case "body": input = value(body); break;
      case "goal": input = language === "python" ? value(body)
        : `dispatch.GoalInput{Name: ${value(body.name)}, Target: ${value(body.target)}, WindowDays: ${value(body.window_days ?? 30)}}`;
        break;
      case "integration": input = language === "python" ? value(body)
        : `dispatch.IntegrationInput{Provider: ${value(body.provider)}, Name: ${value(body.name)}, Secret: ${value(body.secret)}${body.slug ? `, Slug: ${value(body.slug)}` : ""}}`;
        break;
      case "form": input = language === "python" ? value(body)
        : `dispatch.FormInput{Name: ${value(body.name)}, TopicIDs: ${strings(body.topic_ids)}, FromEmail: ${value(body.from_email)}, AllowedOrigins: ${strings(body.allowed_origins)}}`;
        break;
      case "rule": {
        const rule = body.rule as Record<string, unknown>;
        input = language === "python" ? value(rule)
          : `dispatch.Rule{Type: ${value(rule.type)}, Field: ${value(rule.field)}, Operator: ${value(rule.operator)}, Value: ${value(rule.value)}}`;
        break;
      }
      case "idBody": input = `${id}, ${value(body)}`; break;
      case "install": input = language === "python"
        ? `${id}, **${value(body)}`
        : `${id}, dispatch.AutomationInstallInput{${Object.entries(body).map(([key, item]) => `${({ from: "From", topic_id: "TopicID", name: "Name" } as Record<string, string>)[key]}: ${value(item)}`).join(", ")}}`;
        break;
      case "idQuery": input = `${id}${query.size || language === "go" ? `, ${queryArgs()}` : ""}`; break;
      case "stepQuery": input = `${id}, ${value(decode(match.params.key!))}${query.size || language === "go" ? `, ${queryArgs()}` : ""}`; break;
      case "winner": input = `${id}, ${value(decode(match.params.key!))}, ${value(body.variant)}, ${value(body.version)}`; break;
      case "send": input = `${value(body)}${language === "go" ? ', ""' : ""}`; break;
      case "share": input = `${id}, ${value(body.expires_in ?? "")}`; break;
      case "publish": input = `${id}${language === "go" ? ', ""' : ""}`; break;
      case "links": input = strings(body.urls); break;
      case "emails": input = strings(body.emails); break;
      case "unsuppress": input = language === "python" ? `emails=${strings(body.emails)}` : `${strings(body.emails)}, nil`; break;
      case "schedule": input = `${id}, ${value(body.scheduled_at ?? "")}`; break;
      case "render": input = `${id}, ${value(body.variables ?? {})}`; break;
      case "recipients": {
        const type = value(query.get("type"));
        query.delete("type");
        input = `${id}, ${type}${query.size ? `, ${queryArgs()}` : ""}`;
        break;
      }
      case "event": input = language === "python"
        ? `${value(body.event)}, email=${value(body.email)}`
        : `dispatch.EventInput{Event: ${value(body.event)}, Email: ${value(body.email)}}`;
        break;
    }
    return `client.${name}(${input})`;
  }
  return null;
}

/** Python's SDK uses snake_case dictionaries and keyword query arguments. */
export function python(call: Call, apiUrl: string): string | null {
  const expression = flatCall(call, "python");
  if (!expression) return null;
  return [
    "import os",
    "from dispatch import Dispatch",
    "",
    `client = Dispatch(api_key=os.environ["DISPATCH_API_KEY"], base_url=${JSON.stringify(apiUrl)})`,
    `data = ${expression}`,
  ].join("\n");
}

/** A complete Go program, using the SDK's flat methods and required arguments. */
export function go(call: Call, apiUrl: string): string | null {
  const expression = flatCall(call, "go");
  if (!expression) return null;
  return [
    "package main",
    "",
    "import (",
    '  "fmt"',
    ...(expression.includes("url.Values") ? ['  "net/url"'] : []),
    '  "os"',
    '  dispatch "github.com/dispatch/dispatch-go"',
    ")",
    "",
    "func main() {",
    '  client := dispatch.New(os.Getenv("DISPATCH_API_KEY"))',
    `  client.BaseURL = ${JSON.stringify(apiUrl)}`,
    `  data, err := ${expression}`,
    "  if err != nil {",
    "    panic(err)",
    "  }",
    "  fmt.Println(data)",
    "}",
  ].join("\n");
}
