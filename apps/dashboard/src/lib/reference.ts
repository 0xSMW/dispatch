import { matchPath } from "react-router-dom";

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

export type Reference = { title: string; calls: Call[] };

const get = (path: string, summary: string, sdk: string | null): Call => ({ method: "GET", path, summary, sdk });
const post = (path: string, summary: string, sdk: string | null, body?: Record<string, unknown>): Call => ({ method: "POST", path, summary, sdk, body });
const patch = (path: string, summary: string, sdk: string | null, body?: Record<string, unknown>): Call => ({ method: "PATCH", path, summary, sdk, body });
const remove = (path: string, summary: string, sdk: string | null): Call => ({ method: "DELETE", path, summary, sdk });

const email = { from: "Acme <hello@acme.com>", to: ["ada@example.com"], subject: "Hello", html: "<p>Hello</p>" };

export const references: Record<string, Reference> = {
  "/setup": { title: "Setup", calls: [get("/setup", "Onboarding progress", "dispatch.setup.get()")] },

  "/emails": {
    title: "Emails",
    calls: [
      get("/emails?limit=40", "List sent emails. Filters: q, status, api_key_id, from, to.", "dispatch.emails.list({ limit: 40 })"),
      post("/emails", "Send an email", "dispatch.emails.send({ from, to, subject, html })", email),
    ],
  },
  "/emails/:id": {
    title: "Email",
    calls: [
      get("/emails/:id", "Retrieve an email", 'dispatch.emails.get(":id")'),
      get("/emails/:id/events?limit=100", "Its delivery events", 'dispatch.emails.events(":id", { limit: 100 })'),
      get("/emails/:id/attachments", "Its attachments", 'dispatch.emails.attachments.list({ emailId: ":id" })'),
      get("/emails/:id/insights", "Deliverability checks", null),
      post("/emails/:id/share", "Create a share link", 'dispatch.emails.share(":id", { expiresIn: "24h" })', { expires_in: "24h" }),
      post("/emails/:id/cancel", "Cancel a scheduled email", 'dispatch.emails.cancel(":id")'),
    ],
  },
  "/emails/receiving": {
    title: "Received emails",
    calls: [
      get("/emails/receiving?limit=40", "List received emails. Filters: q, from, to.", "dispatch.emails.receiving.list({ limit: 40 })"),
      post("/emails/receiving/simulate", "Simulate an inbound email", "dispatch.emails.receiving.simulate({ from, to, subject, text })", {
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
  "/emails/send": { title: "Send", calls: [post("/emails", "Send an email", "dispatch.emails.send({ from, to, subject, html })", email)] },

  "/broadcasts": {
    title: "Broadcasts",
    calls: [
      get("/broadcasts?limit=40", "List broadcasts. Filters: q, status, segment_id.", "dispatch.broadcasts.list({ limit: 40 })"),
      post("/broadcasts", "Create a draft", "dispatch.broadcasts.create({ from, segmentId, subject })", {
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
      post("/broadcasts/:id/cancel", "Cancel a scheduled broadcast", 'dispatch.broadcasts.cancel(":id")'),
    ],
  },
  "/broadcasts/:id/editor": {
    title: "Broadcast editor",
    calls: [
      patch("/broadcasts/:id", "Save the draft", 'dispatch.broadcasts.update(":id", { subject, html })', { subject: "October update", html: "<p>Hi</p>" }),
      get("/broadcasts/:id/audience", "Count who it will reach", null),
      post("/links/check", "Check the links", 'dispatch.links.check(["https://acme.com"])', { urls: ["https://acme.com"] }),
      post("/broadcasts/:id/send", "Send now, or schedule", 'dispatch.broadcasts.send(":id", { scheduledAt: "in 1 hour" })', { scheduled_at: "in 1 hour" }),
    ],
  },

  "/automations": {
    title: "Automations",
    calls: [
      get("/automations?limit=40", "List automations. Filter: status.", "dispatch.automations.list({ limit: 40 })"),
      post("/automations", "Create an automation", "dispatch.automations.create({ name, steps, connections })", {
        name: "Welcome",
        steps: [{ key: "trigger", type: "trigger", config: { event_name: "user.created" } }],
        connections: [],
      }),
    ],
  },
  "/automations/events": {
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
      get("/automations/:id/runs/metrics", "Run counts by status and day", null),
    ],
  },

  "/templates": {
    title: "Templates",
    calls: [
      get("/templates?limit=100", "List templates. Filters: q, status.", "dispatch.templates.list({ limit: 100 })"),
      post("/templates", "Create a draft template", 'dispatch.templates.create({ name: "Welcome", html })', { name: "Welcome", html: "<p>Hi {{{NAME}}}</p>" }),
    ],
  },
  "/templates/library": {
    title: "Template library",
    calls: [
      get("/template-library", "List the default templates", "dispatch.templates.library.list()"),
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
      patch("/templates/:id", "Save the draft", 'dispatch.templates.update(":id", { subject, html })', { subject: "Welcome", html: "<p>Hi</p>" }),
      post("/templates/:id/render", "Render the draft on the server", null, { variables: { NAME: "Ada" }, draft: true }),
      post("/templates/:id/publish", "Publish", 'dispatch.templates.publish(":id")'),
    ],
  },

  "/audience": {
    title: "Contacts",
    calls: [
      get("/contacts?limit=40", "List contacts. Filters: q, subscribed, segment_id.", "dispatch.contacts.list({ limit: 40 })"),
      get("/contacts/stats", "Contact counts", null),
      post("/contacts", "Add a contact", 'dispatch.contacts.create({ email: "ada@example.com" })', { email: "ada@example.com", first_name: "Ada" }),
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

  "/metrics": {
    title: "Metrics",
    calls: [get("/emails/metrics?dimensions=period", "Sent, delivered, bounced, and complained counts", 'dispatch.emails.metrics({ dimensions: ["period"] })')],
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
      get("/api-keys/:id", "Retrieve a key with its use count", null),
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
    calls: [get("/brand", "Retrieve the brand", "dispatch.brand.get()"), patch("/brand", "Update it", 'dispatch.brand.update({ product_name: "Acme" })', { product_name: "Acme" })],
  },
  "/settings/unsubscribe-page": {
    title: "Unsubscribe page",
    calls: [get("/brand", "Logo and color", "dispatch.brand.get()"), get("/topics", "Topics on the page", "dispatch.topics.list()")],
  },
  "/timeline": { title: "Timeline", calls: [get("/timeline", "Recent activity across resources", "dispatch.timeline.list()")] },
};

/** The reference for a location, with route params such as `:id` filled in. Null for a page with none. */
export function referenceFor(pathname: string): Reference | null {
  for (const [pattern, reference] of Object.entries(references)) {
    const match = matchPath(pattern, pathname);
    if (!match) continue;
    // Static routes such as /emails/receiving also match /emails/:id. Prefer the static one.
    if (pattern.includes(":") && Object.keys(references).some((other) => !other.includes(":") && matchPath(other, pathname))) continue;
    const fill = (text: string) => text.replace(/:([a-z_]+)/g, (whole, name: string) => match.params[name] ?? whole);
    return { title: reference.title, calls: reference.calls.map((call) => ({ ...call, path: fill(call.path), sdk: call.sdk ? fill(call.sdk) : null })) };
  }
  return null;
}

/** A curl command for one call. The key comes from the environment, never from the dashboard. */
export function curl(call: Call, apiUrl: string) {
  const lines = [`curl -X ${call.method} "${apiUrl}${call.path}"`, '  -H "Authorization: Bearer $DISPATCH_API_KEY"'];
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
    `const dispatch = new Dispatch({ apiKey: process.env.DISPATCH_API_KEY, baseUrl: "${apiUrl}" });`,
    `const { data, error } = await ${call.sdk};`,
  ].join("\n");
}
