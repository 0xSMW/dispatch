import "dotenv/config";
import { connect } from "@dispatchmail/db";
import { Dispatch, type ErrorBody, type Result } from "@dispatchmail/sdk";
import { DEFAULT_API_URL, DEFAULT_DEV_API_KEY, poll } from "./helpers/index.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: tsx scripts/smoke.ts");
  console.log("Runs end-to-end smoke verification against Dispatch API.");
  process.exit(0);
}

const apiUrl = process.env.API_URL ?? DEFAULT_API_URL;
const apiKey = process.env.DISPATCH_API_KEY ?? DEFAULT_DEV_API_KEY;
const api = new Dispatch({ apiKey, baseUrl: apiUrl });

const health = await ok(api.health());
console.log("health", health);

const setup = await ok(api.setup.get());
console.log("setup", setup);
await deleteStaleFailingWebhooks();

const user = await ok(api.users.create({ email: `user-${Date.now()}@example.com`, name: "Smoke User" }));
const role = await ok(api.roles.create({ name: `smoke-role-${Date.now()}`, permissions: ["full"] }));
const membership = await ok(api.memberships.create({ userId: user.id, roleId: role.id }));
const session = await ok(api.sessions.create({ email: user.email, api_key: apiKey }));
const sessionClient = new Dispatch({ apiKey: session.token, baseUrl: apiUrl });
const me = await ok(sessionClient.me.get());
if (me.user?.email !== user.email) throw new Error("session did not authenticate user");
await ok(api.sessions.remove(session.id));
const auditLogs = await ok(api.auditLogs.list({ action: "POST /users", limit: 100 }));
if (!auditLogs.data.some((log: { action: string }) => log.action === "POST /users")) {
  throw new Error("audit log did not record user mutation");
}
await ok(api.memberships.remove(membership.id));
await ok(api.roles.remove(role.id));
await ok(api.users.remove(user.id));
console.log("identity lifecycle");

const smokeKey = await ok(api.apiKeys.create({ name: `smoke-send-${Date.now()}`, permission: "sending_access" }));
const keyClient = new Dispatch({ apiKey: smokeKey.token, baseUrl: apiUrl });
const keyAccepted = await ok(
  keyClient.emails.send(
    {
      from: "hello@example.com",
      to: "key-smoke@example.com",
      subject: "Key smoke",
      text: "Created key can send."
    },
    { idempotencyKey: `key-${Date.now()}` }
  )
);
const keyEmail = await waitFor(keyAccepted.id);
if (keyEmail.last_event !== "delivered") throw new Error(`key email ended ${keyEmail.last_event}`);
await ok(api.apiKeys.remove(smokeKey.id));
await expectStatus(
  keyClient.emails.send({
    from: "hello@example.com",
    to: "revoked-key@example.com",
    subject: "Revoked key",
    text: "should not send"
  }),
  403
);
console.log("key lifecycle");

const sent = await ok(
  api.emails.send(
    {
      from: "hello@example.com",
      to: "you@example.com",
      subject: "Dispatch smoke",
      text: "Local smoke test."
    },
    { idempotencyKey: `smoke-${Date.now()}` }
  )
);
console.log("accepted", sent.id);

const email = await waitFor(sent.id);
console.log("final", email.last_event);

if (email.last_event !== "delivered") {
  throw new Error(`unexpected email status ${email.last_event}`);
}

const idemKey = `idem-${Date.now()}`;
const idemBody = {
  from: "hello@example.com",
  to: "idem@example.com",
  subject: "Idempotency smoke",
  text: "same"
};
const first = await ok(api.emails.send(idemBody, { idempotencyKey: idemKey }));
const replay = await ok(api.emails.send(idemBody, { idempotencyKey: idemKey }));
if (first.id !== replay.id) throw new Error("idempotency replay returned a different email");
await expectStatus(api.emails.send({ ...idemBody, subject: "Different" }, { idempotencyKey: idemKey }), 409);
console.log("idempotency replay");

const batchKey = `batch-${Date.now()}`;
const batchBody = [
  {
    from: "hello@example.com",
    to: "batch-one@example.com",
    subject: "Batch smoke one",
    text: "first"
  },
  {
    from: "hello@example.com",
    to: "batch-two@example.com",
    subject: "Batch smoke two",
    text: "second"
  }
];
const batch = await ok(api.batch.send(batchBody, { idempotencyKey: batchKey }));
if (batch.data.length !== 2) throw new Error(`expected 2 batch emails, got ${batch.data.length}`);
const batchReplay = await ok(api.batch.send(batchBody, { idempotencyKey: batchKey }));
if (batchReplay.data.map((item: { id: string }) => item.id).join(",") !== batch.data.map((item: { id: string }) => item.id).join(",")) {
  throw new Error("batch idempotency replay returned different emails");
}
for (const item of batch.data as Array<{ id: string }>) {
  const batchEmail = await waitFor(item.id);
  if (batchEmail.last_event !== "delivered") throw new Error(`batch email ended ${batchEmail.last_event}`);
}
console.log("batch delivered");

const templateAlias = `welcome-${Date.now()}`;
const template = await ok(
  api.templates
    .create({
      name: `Welcome ${Date.now()}`,
      alias: templateAlias,
      subject: "Welcome {{name}}",
      text: "Hello {{name}}, welcome to Dispatch.",
      variables: ["name"]
    })
    .publish()
);
const rendered = await ok(api.templates.render(template.id, { name: "Ada" }));
if (rendered.rendered.subject !== "Welcome Ada") throw new Error("template render failed");
const templated = await ok(
  api.emails.send(
    {
      from: "hello@example.com",
      to: "template@example.com",
      template: { id: templateAlias, variables: { name: "Ada" } }
    },
    { idempotencyKey: `template-${Date.now()}` }
  )
);
const templatedEmail = await waitFor(templated.id);
if (templatedEmail.last_event !== "delivered") throw new Error(`templated email ended ${templatedEmail.last_event}`);
console.log("template delivered");

const automationSegment = await ok(api.segments.create({ name: `Automation list ${Date.now()}` }));
const automation = await ok(
  api.automations.create({
    name: `Welcome flow ${Date.now()}`,
    status: "enabled",
    trigger: "user.signed_up",
    steps: [
      { type: "update_contact", properties: { source: "automation" } },
      { type: "add_to_segment", segment_id: automationSegment.id },
      { type: "send_email", from: "hello@example.com", template: templateAlias }
    ]
  })
);
const automationEmail = `automation-${Date.now()}@example.com`;
await ok(api.events.send({ event: "user.signed_up", email: automationEmail, payload: { name: "Grace" } }));
const automationRun = await waitForRun(automation.id, "completed");
if (automationRun.steps.length !== 3) throw new Error("automation steps were not recorded");
const sendStep = automationRun.steps.find((step: { type: string }) => step.type === "send_email");
if (!sendStep?.output?.email_id) throw new Error("automation send step did not create an email");
const automationEmailRecord = await waitFor(sendStep.output.email_id);
if (automationEmailRecord.last_event !== "delivered") throw new Error(`automation email ended ${automationEmailRecord.last_event}`);
const automationContacts = await ok(api.segments.contacts(automationSegment.id));
if (!automationContacts.data.some((contact: { email: string }) => contact.email === automationEmail)) {
  throw new Error("automation did not add contact to segment");
}
const definitionName = `smoke.edit.${Date.now()}`;
await ok(api.events.create({ name: definitionName, schema: { state: "string" } }));
const patchedEvent = await ok(api.events.update(definitionName, { schema: { state: "number" } }));
if (patchedEvent.schema?.state !== "number") throw new Error("event definition update failed");
await ok(api.events.remove(definitionName));

const delayed = await ok(
  api.automations.create({
    name: `Delayed flow ${Date.now()}`,
    status: "enabled",
    trigger: "user.delayed",
    steps: [
      { type: "delay", seconds: 1 },
      { type: "send_email", from: "hello@example.com", template: templateAlias }
    ]
  })
);
await ok(api.events.send({ event: "user.delayed", email: `delayed-${Date.now()}@example.com`, payload: { name: "Lin" } }));
const delayedRun = await waitForRun(delayed.id, "completed");
const delayedSend = delayedRun.steps.find((step: { type: string }) => step.type === "send_email");
if (!delayedSend?.output?.email_id) throw new Error("delayed automation send step did not create an email");
const delayedEmail = await waitFor(delayedSend.output.email_id);
if (delayedEmail.last_event !== "delivered") throw new Error(`delayed automation email ended ${delayedEmail.last_event}`);

const waited = await ok(
  api.automations.create({
    name: `Wait flow ${Date.now()}`,
    status: "enabled",
    trigger: "cart.started",
    steps: [
      { type: "wait", event: "cart.completed", timeout_seconds: 5 },
      { type: "send_email", from: "hello@example.com", template: templateAlias }
    ]
  })
);
const waitEmail = `wait-${Date.now()}@example.com`;
await ok(api.events.send({ event: "cart.started", email: waitEmail, payload: { name: "Mina" } }));
const waitStart = await waitForRun(waited.id, "running");
await ok(api.events.send({ event: "cart.completed", email: waitEmail, payload: { total: 42 } }));
const waitedRun = await waitForRun(waited.id, "completed");
if (waitedRun.id !== waitStart.id) throw new Error("wait automation was not resumed");
const waitedSend = waitedRun.steps.find((step: { type: string }) => step.type === "send_email");
if (!waitedSend?.output?.email_id) throw new Error("wait automation send step did not create an email");
const waitedEmail = await waitFor(waitedSend.output.email_id);
if (waitedEmail.last_event !== "delivered") throw new Error(`wait automation email ended ${waitedEmail.last_event}`);

const stopped = await ok(
  api.automations.create({
    name: `Stop flow ${Date.now()}`,
    status: "enabled",
    trigger: "stop.started",
    steps: [{ type: "wait", event: "stop.finished", timeout_seconds: 60 }]
  })
);
await ok(api.events.send({ event: "stop.started", email: `stop-${Date.now()}@example.com`, payload: {} }));
const stoppedStart = await waitForRun(stopped.id, "running");
await ok(api.automations.stop(stopped.id));
const stoppedRun = await ok(api.automations.runs.get(stopped.id, stoppedStart.id));
if (stoppedRun.status !== "cancelled") throw new Error(`automation stop failed: ${stoppedRun.status}`);

for (const flow of [automation, delayed, waited, stopped]) {
  await ok(api.automations.update(flow.id, { status: "disabled" }));
  await ok(api.automations.remove(flow.id));
}
console.log("automation run");

const attachmentContent = Buffer.from("Hello from a local attachment.").toString("base64");
const attached = await ok(
  api.emails.send(
    {
      from: "hello@example.com",
      to: "attachment@example.com",
      subject: "Attachment smoke",
      text: "See attached.",
      attachments: [{ filename: "hello.txt", content: attachmentContent, contentType: "text/plain", disposition: "attachment" }]
    },
    { idempotencyKey: `attachment-${Date.now()}` }
  )
);
const attachedEmail = await waitFor(attached.id);
if (attachedEmail.last_event !== "delivered") throw new Error(`attachment email ended ${attachedEmail.last_event}`);
const attachments = await ok(api.emails.attachments.list({ emailId: attached.id }));
if (attachments.data.length !== 1) throw new Error("expected one sent attachment");
const attachment = await ok(api.emails.attachments.get({ emailId: attached.id, id: attachments.data[0].id }));
const downloaded = await fetch(attachment.download_url);
if (Buffer.from(await downloaded.arrayBuffer()).toString("base64") !== attachmentContent) {
  throw new Error("sent attachment content mismatch");
}
await expectStatus(
  api.batch.send([
    {
      from: "hello@example.com",
      to: "batch-attachment@example.com",
      subject: "Batch attachment",
      text: "should fail",
      attachments: [{ filename: "no.txt", content: attachmentContent }]
    } as never
  ]),
  400
);
console.log("attachment stored");

// Unsubscribed means unsubscribed from broadcasts. Transactional sends still go out.
const contactEmail = `unsubscribed-${Date.now()}@example.com`;
const contact = await ok(
  api.contacts.create({
    email: contactEmail,
    firstName: "Unsubscribed",
    properties: { source: "smoke" },
    unsubscribed: true
  })
);
const transactional = await ok(
  api.emails.send({
    from: "hello@example.com",
    to: contactEmail,
    subject: "Transactional",
    text: "still sends"
  })
);
const transactionalEmail = await waitFor(transactional.id);
if (transactionalEmail.last_event !== "delivered") throw new Error(`unsubscribed contact transactional email ended ${transactionalEmail.last_event}`);
await ok(api.contacts.remove(contact.id));
console.log("unsubscribed contact still gets transactional mail");

// A suppressed recipient is skipped, not rejected, and fires email.suppressed.
const suppressionEmail = `suppressed-${Date.now()}@example.com`;
await ok(api.suppressions.add({ email: suppressionEmail, reason: "smoke" }));
const suppressedSend = await ok(
  api.emails.send({
    from: "hello@example.com",
    to: suppressionEmail,
    subject: "Suppressed",
    text: "should not send"
  })
);
await waitForEvent(suppressedSend.id, "email.suppressed");
await ok(api.suppressions.remove(suppressionEmail));
console.log("manual suppression");

const topic = await ok(
  api.topics.create({
    name: `Updates ${Date.now()}`.slice(0, 50),
    defaultSubscription: "opt_out"
  })
);
const segment = await ok(api.segments.create({ name: `Launch list ${Date.now()}` }));
const broadcastEmail = `broadcast-${Date.now()}@example.com`;
const skippedEmail = `broadcast-skip-${Date.now()}@example.com`;
await ok(api.contacts.create({ email: broadcastEmail, properties: { plan: "pro" } }));
await ok(api.contacts.create({ email: skippedEmail, properties: { plan: "free" } }));
await ok(api.contacts.segments.add({ email: broadcastEmail, segmentId: segment.id }));
await ok(api.contacts.segments.add({ email: skippedEmail, segmentId: segment.id }));
await ok(api.contacts.topics.update({ email: broadcastEmail, topics: [{ id: topic.id, subscription: "opt_in" }] }));
const broadcast = await ok(
  api.broadcasts.create({
    name: `Broadcast ${Date.now()}`,
    from: "hello@example.com",
    subject: "Broadcast smoke",
    text: "Local broadcast.",
    topicId: topic.id,
    segmentId: segment.id
  })
);
await ok(api.broadcasts.send(broadcast.id));
const broadcastRecipient = await poll(
  async () => {
    const recipients = await ok(api.broadcasts.recipients(broadcast.id, { type: "sent" }));
    return recipients.data.find((recipient: { email: string }) => recipient.email === broadcastEmail);
  },
  { timeoutMs: 10_000, message: "broadcast recipient was not sent" }
);
const broadcastDetail = await ok(api.broadcasts.get(broadcast.id));
if (broadcastDetail.status !== "sent") throw new Error(`unexpected broadcast status ${broadcastDetail.status}`);
if (!broadcastRecipient.email_id) throw new Error("broadcast recipient has no email");
const broadcastedEmail = await waitFor(broadcastRecipient.email_id);
if (broadcastedEmail.last_event !== "delivered") throw new Error(`broadcast email ended ${broadcastedEmail.last_event}`);
await ok(api.contacts.segments.remove({ email: skippedEmail, segmentId: segment.id }));
const afterRemove = await ok(api.segments.contacts(segment.id));
if (afterRemove.data.some((member: { email: string }) => member.email === skippedEmail)) throw new Error("segment removal failed");
const duplicated = await ok(api.broadcasts.duplicate(broadcast.id, { name: `Broadcast copy ${Date.now()}` }));
await ok(api.broadcasts.remove(duplicated.id));
console.log("broadcast sent");

const scheduled = await ok(
  api.emails.send(
    {
      from: "hello@example.com",
      to: "scheduled@example.com",
      subject: "Scheduled smoke",
      text: "later",
      scheduledAt: new Date(Date.now() + 2_000).toISOString()
    },
    { idempotencyKey: `scheduled-${Date.now()}` }
  )
);
const scheduledDetail = await ok(api.emails.get(scheduled.id));
if (scheduledDetail.last_event !== "scheduled") throw new Error(`expected scheduled status, got ${scheduledDetail.last_event}`);
await ok(
  api.emails.update({
    id: scheduled.id,
    subject: "Scheduled smoke updated",
    text: "sooner",
    scheduledAt: new Date(Date.now() + 1_000).toISOString()
  })
);
const updatedSchedule = await ok(api.emails.get(scheduled.id));
if (updatedSchedule.subject !== "Scheduled smoke updated") throw new Error("scheduled email update failed");
const scheduledEmail = await waitFor(scheduled.id);
if (scheduledEmail.last_event !== "delivered") throw new Error(`scheduled email ended ${scheduledEmail.last_event}`);
const jobs = await ok(api.emails.jobs.list({ email_id: scheduled.id }));
if (!jobs.data.some((job: { email_id: string }) => job.email_id === scheduled.id)) throw new Error("email job list missing scheduled job");
console.log("scheduled delivered");

const flowWebhook = await ok(
  api.webhooks.create({
    endpoint: "http://localhost:8787/webhooks",
    events: ["email.received", "email.opened", "email.clicked"]
  })
);

const tracked = await ok(
  api.emails.send(
    {
      from: "hello@example.com",
      to: "tracked@example.com",
      subject: "Tracking smoke",
      html: '<html><body><a href="https://example.com/docs">Docs</a></body></html>'
    },
    { idempotencyKey: `tracking-${Date.now()}` }
  )
);
const trackedEmail = await waitFor(tracked.id);
if (trackedEmail.last_event !== "delivered") throw new Error(`tracking email ended ${trackedEmail.last_event}`);
// The API returns the HTML the caller sent. The tracked copy is only in the message that went
// out, so the tokens are read from the database, which a smoke run already needs.
if (String(trackedEmail.html).includes("/click/")) throw new Error("GET /emails/:id returned the tracked HTML");
const smokeDb = connect();
const tokens = await smokeDb.query<{ token: string; kind: string }>(
  "select token, kind from tracking_tokens where email_id = $1",
  [tracked.id]
);
await smokeDb.end();
const openToken = tokens.rows.find((row) => row.kind === "open")?.token;
const clickToken = tokens.rows.find((row) => row.kind === "click")?.token;
if (!openToken || !clickToken) throw new Error("tracking tokens were not stored for the email");
const openUrl = `${apiUrl}/open/${openToken}.gif`;
const clickUrl = `${apiUrl}/click/${clickToken}`;
const openResponse = await fetch(openUrl);
if (openResponse.status !== 200) throw new Error(`expected open pixel 200, got ${openResponse.status}`);
const clickResponse = await fetch(clickUrl, { redirect: "manual" });
if (![301, 302, 303, 307, 308].includes(clickResponse.status)) throw new Error(`expected click redirect, got ${clickResponse.status}`);
await waitForEvent(tracked.id, "email.opened");
await waitForEvent(tracked.id, "email.clicked");
console.log("tracking events");

const receivedContent = Buffer.from("Hello inbound attachment.").toString("base64");
const received = await ok(
  api.emails.receiving.simulate({
    from: "sender@example.net",
    to: "inbound@example.com",
    subject: "Inbound smoke",
    text: "Received locally.",
    headers: { "x-smoke": "true" },
    attachments: [{ filename: "inbound.txt", content: receivedContent, content_type: "text/plain" }]
  })
);
const receivedDetail = await ok(api.emails.receiving.get(received.id));
if (receivedDetail.attachments.length !== 1) throw new Error("expected one received attachment");
const receivedAttachments = await ok(api.emails.receiving.attachments.list({ emailId: received.id }));
if (receivedAttachments.data.length !== 1) throw new Error("expected received attachment list");
const receivedAttachment = await ok(api.emails.receiving.attachments.get({ emailId: received.id, id: receivedAttachments.data[0].id }));
const receivedDownload = await fetch(receivedAttachment.download_url);
if (Buffer.from(await receivedDownload.arrayBuffer()).toString("base64") !== receivedContent) {
  throw new Error("received attachment content mismatch");
}
await waitForAttemptCount(flowWebhook.id, 3);
await ok(api.webhooks.remove(flowWebhook.id));
console.log("received email stored");

const webhooks = await ok(api.webhooks.list());
const receiver = webhooks.data.find((webhook: { endpoint: string }) => webhook.endpoint.includes("localhost:8787")) ?? webhooks.data[0];
if (receiver) {
  await waitForSentWebhook(receiver.id);
}

const failing = await ok(
  api.webhooks.create({
    endpoint: "http://localhost:9/webhooks",
    events: ["email.sent"]
  })
);
await ok(api.webhooks.test());
await waitForRetry(failing.id);
await ok(api.webhooks.remove(failing.id));
const system = await ok(api.system.get());
if (!system.ok || !system.worker) throw new Error("system health missing worker state");
const timeline = await ok(api.timeline.list());
if (!timeline.data.some((item: { kind: string }) => item.kind === "email_event")) throw new Error("timeline missing email events");
const usage = await ok(api.usage.get());
console.log("usage", usage);
console.log("ops visible");

// Unwraps a Result, failing the smoke run on an API error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T>(pending: Promise<Result<T>>): Promise<any> {
  const result = await pending;
  if (result.error) throw new Error(`${result.error.name} (${result.error.statusCode}): ${result.error.message}`);
  return result.data;
}

async function waitFor(id: string) {
  return poll(
    async () => {
      const email = await ok(api.emails.get(id));
      if (["delivered", "bounced", "complained", "failed"].includes(email.last_event)) return email;
    },
    { timeoutMs: 10_000, message: "email did not leave queued state" }
  );
}

async function waitForRetry(webhookId: string) {
  await poll(
    async () => {
      const events = await ok(api.webhooks.events.list(webhookId));
      const retrying = events.data.find((event: { status: string }) => event.status === "attempting" || event.status === "failed");
      if (retrying) {
        console.log("webhook retry queued");
        return true;
      }
    },
    { message: "webhook retry was not queued" }
  );
}

async function waitForSentWebhook(webhookId: string) {
  await poll(
    async () => {
      const events = await ok(api.webhooks.events.list(webhookId));
      const sentAttempt = events.data.find((event: { status: string }) => event.status === "success");
      if (sentAttempt) {
        console.log("webhook", sentAttempt.status);
        return true;
      }
    },
    { message: "no sent webhook attempt found" }
  );
}

async function waitForEvent(emailId: string, type: string) {
  await poll(
    async () => {
      const events = await ok(api.emails.events(emailId));
      return events.data.some((event: { type: string }) => event.type === type);
    },
    { message: `event ${type} not found` }
  );
}

// Waits for the automation's newest run to reach a status, then returns the run with its steps.
async function waitForRun(automationId: string, status: "running" | "completed") {
  return poll(
    async () => {
      const runs = await ok(api.automations.runs.list(automationId, { limit: 1 }));
      const latest = runs.data[0];
      if (!latest) return undefined;
      if (latest.status === "failed") throw new Error(`automation run failed: ${latest.error}`);
      if (latest.status === status) return ok(api.automations.runs.get(automationId, latest.id));
    },
    { timeoutMs: 10_000, message: `automation run did not reach ${status}` }
  );
}

async function waitForAttemptCount(webhookId: string, count: number) {
  await poll(
    async () => {
      const events = await ok(api.webhooks.events.list(webhookId));
      return events.data.length >= count;
    },
    { message: `webhook did not record ${count} attempts` }
  );
}

async function deleteStaleFailingWebhooks() {
  const webhooks = await ok(api.webhooks.list({ limit: 100 }));
  for (const webhook of webhooks.data as Array<{ id: string; endpoint: string }>) {
    if (webhook.endpoint.includes("localhost:9/")) await ok(api.webhooks.remove(webhook.id));
  }
}

async function expectStatus<T>(pending: Promise<Result<T>>, expectedStatus: number): Promise<ErrorBody> {
  const result = await pending;
  if (!result.error) throw new Error(`expected status ${expectedStatus}, but call succeeded`);
  if (result.error.statusCode !== expectedStatus) {
    throw new Error(`expected status ${expectedStatus}, got ${result.error.statusCode} ${result.error.name}`);
  }
  return result.error;
}
