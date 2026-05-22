import "dotenv/config";

const apiUrl = process.env.API_URL ?? "http://localhost:3100";
const apiKey = process.env.DISPATCH_API_KEY ?? "sk_local_dispatch_dev_key_change_before_deploy";

const headers = {
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json"
};
const authHeaders = {
  authorization: `Bearer ${apiKey}`
};

const health = await get("/health", false);
console.log("health", health);

const setup = await get("/v1/setup", false);
console.log("setup", setup);
await deleteStaleFailingWebhooks();

const user = await post("/v1/users", { email: `user-${Date.now()}@example.com`, name: "Smoke User" });
const role = await post("/v1/roles", { name: `smoke-role-${Date.now()}`, permissions: ["full"] });
const membership = await post("/v1/memberships", { user_id: user.user.id, role_id: role.role.id });
const session = await post("/v1/sessions", { email: user.user.email, api_key: apiKey }, {}, false);
const me = await getAs(session.session.token, "/v1/me");
if (me.user.email !== user.user.email) throw new Error("session did not authenticate user");
await del(`/v1/sessions/${session.session.id}`);
const auditLogs = await get("/v1/audit-logs?action=%2Fv1%2Fusers&limit=100");
if (!auditLogs.data.some((log: { action: string }) => log.action.includes("/v1/users"))) {
  throw new Error("audit log did not record user mutation");
}
await del(`/v1/memberships/${membership.membership.id}`);
await del(`/v1/roles/${role.role.id}`);
await del(`/v1/users/${user.user.id}`);
console.log("identity lifecycle");

const smokeKey = await post("/v1/api-keys", { name: `smoke-send-${Date.now()}`, scope: "send" });
const keyAccepted = await postAs(
  smokeKey.api_key.secret,
  "/v1/emails",
  {
    from: "hello@example.com",
    to: "key-smoke@example.com",
    subject: "Key smoke",
    text: "Created key can send."
  },
  { "idempotency-key": `key-${Date.now()}` }
);
const keyEmail = await waitFor(keyAccepted.email.id);
if (keyEmail.status !== "delivered") throw new Error(`key email ended ${keyEmail.status}`);
await del(`/v1/api-keys/${smokeKey.api_key.id}`);
const revokedKey = await rawPostAs(smokeKey.api_key.secret, "/v1/emails", {
  from: "hello@example.com",
  to: "revoked-key@example.com",
  subject: "Revoked key",
  text: "should not send"
});
if (revokedKey.status !== 401) throw new Error(`expected revoked key 401, got ${revokedKey.status}`);
console.log("key lifecycle");

const sent = await post(
  "/v1/emails",
  {
    from: "hello@example.com",
    to: "you@example.com",
    subject: "Dispatch smoke",
    text: "Local smoke test."
  },
  { "idempotency-key": `smoke-${Date.now()}` }
);
console.log("accepted", sent.email.id);

const email = await waitFor(sent.email.id);
console.log("final", email.status);

if (email.status !== "delivered") {
  throw new Error(`unexpected email status ${email.status}`);
}

const idemKey = `idem-${Date.now()}`;
const idemBody = {
  from: "hello@example.com",
  to: "idem@example.com",
  subject: "Idempotency smoke",
  text: "same"
};
const first = await post("/v1/emails", idemBody, { "idempotency-key": idemKey });
const replay = await post("/v1/emails", idemBody, { "idempotency-key": idemKey });
if (first.email.id !== replay.email.id) throw new Error("idempotency replay returned a different email");
const conflict = await rawPost("/v1/emails", { ...idemBody, subject: "Different" }, { "idempotency-key": idemKey });
if (conflict.status !== 409) throw new Error(`expected idempotency conflict, got ${conflict.status}`);
console.log("idempotency replay");

const batchKey = `batch-${Date.now()}`;
const batchBody = {
  emails: [
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
  ]
};
const batch = await post("/v1/emails/batch", batchBody, { "idempotency-key": batchKey });
if (batch.data.length !== 2) throw new Error(`expected 2 batch emails, got ${batch.data.length}`);
const batchReplay = await post("/v1/emails/batch", batchBody, { "idempotency-key": batchKey });
if (batchReplay.data.map((email: { id: string }) => email.id).join(",") !== batch.data.map((email: { id: string }) => email.id).join(",")) {
  throw new Error("batch idempotency replay returned different emails");
}
for (const item of batch.data as Array<{ id: string }>) {
  const batchEmail = await waitFor(item.id);
  if (batchEmail.status !== "delivered") throw new Error(`batch email ended ${batchEmail.status}`);
}
console.log("batch delivered");

const templateAlias = `welcome-${Date.now()}`;
const template = await post("/v1/templates", {
  name: `Welcome ${Date.now()}`,
  alias: templateAlias,
  subject: "Welcome {{name}}",
  text: "Hello {{name}}, welcome to Dispatch.",
  variables: ["name"]
});
const rendered = await post(`/v1/templates/${template.template.id}/render`, { variables: { name: "Ada" } });
if (rendered.rendered.subject !== "Welcome Ada") throw new Error("template render failed");
const templated = await post(
  "/v1/emails",
  {
    from: "hello@example.com",
    to: "template@example.com",
    template: templateAlias,
    variables: { name: "Ada" }
  },
  { "idempotency-key": `template-${Date.now()}` }
);
const templatedEmail = await waitFor(templated.email.id);
if (templatedEmail.status !== "delivered") throw new Error(`templated email ended ${templatedEmail.status}`);
console.log("template delivered");

const automationSegment = await post("/v1/segments", {
  name: `Automation list ${Date.now()}`
});
const automation = await post("/v1/automations", {
  name: `Welcome flow ${Date.now()}`,
  trigger: "user.signed_up",
  steps: [
    { type: "update_contact", properties: { source: "automation" } },
    { type: "add_to_segment", segment_id: automationSegment.segment.id },
    { type: "send_email", from: "hello@example.com", template: templateAlias }
  ]
});
const automationEmail = `automation-${Date.now()}@example.com`;
const customEvent = await post("/v1/events", {
  name: "user.signed_up",
  email: automationEmail,
  data: { name: "Grace" }
});
if (customEvent.runs.length !== 1 || customEvent.runs[0].state !== "done") {
  throw new Error(`unexpected automation runs ${JSON.stringify(customEvent.runs)}`);
}
const automationRun = await get(`/v1/automation-runs/${customEvent.runs[0].id}`);
if (automationRun.run.steps.length !== 3) throw new Error("automation steps were not recorded");
const sendStep = automationRun.run.steps.find((step: { type: string }) => step.type === "send_email");
if (!sendStep?.data?.email_id) throw new Error("automation send step did not create an email");
const automationEmailRecord = await waitFor(sendStep.data.email_id);
if (automationEmailRecord.status !== "delivered") throw new Error(`automation email ended ${automationEmailRecord.status}`);
const automationContacts = await get(`/v1/segments/${automationSegment.segment.id}/contacts`);
if (!automationContacts.data.some((contact: { email: string }) => contact.email === automationEmail)) {
  throw new Error("automation did not add contact to segment");
}
const editedEvent = await post("/v1/events", {
  name: `smoke.edit.${Date.now()}`,
  email: `event-${Date.now()}@example.com`,
  data: { state: "draft" }
});
const patchedEvent = await patch(`/v1/events/${editedEvent.event.id}`, { data: { state: "patched" } });
if (patchedEvent.event.data.state !== "patched") throw new Error("event update failed");
await del(`/v1/events/${editedEvent.event.id}`);

const delayed = await post("/v1/automations", {
  name: `Delayed flow ${Date.now()}`,
  trigger: "user.delayed",
  steps: [
    { type: "delay", seconds: 1 },
    { type: "send_email", from: "hello@example.com", template: templateAlias }
  ]
});
const delayedEvent = await post("/v1/events", {
  name: "user.delayed",
  email: `delayed-${Date.now()}@example.com`,
  data: { name: "Lin" }
});
if (delayedEvent.runs.length !== 1 || delayedEvent.runs[0].state !== "waiting") {
  throw new Error(`unexpected delayed automation state ${JSON.stringify(delayedEvent.runs)}`);
}
const delayedRun = await waitForRun(delayedEvent.runs[0].id);
const delayedSend = delayedRun.steps.find((step: { type: string }) => step.type === "send_email");
if (!delayedSend?.data?.email_id) throw new Error("delayed automation send step did not create an email");
const delayedEmail = await waitFor(delayedSend.data.email_id);
if (delayedEmail.status !== "delivered") throw new Error(`delayed automation email ended ${delayedEmail.status}`);

const waited = await post("/v1/automations", {
  name: `Wait flow ${Date.now()}`,
  trigger: "cart.started",
  steps: [
    { type: "wait", event: "cart.completed", timeout_seconds: 5 },
    { type: "send_email", from: "hello@example.com", template: templateAlias }
  ]
});
const waitEmail = `wait-${Date.now()}@example.com`;
const waitStart = await post("/v1/events", {
  name: "cart.started",
  email: waitEmail,
  data: { name: "Mina" }
});
if (waitStart.runs.length !== 1 || waitStart.runs[0].state !== "waiting") {
  throw new Error(`unexpected wait automation state ${JSON.stringify(waitStart.runs)}`);
}
const waitResume = await post("/v1/events", {
  name: "cart.completed",
  email: waitEmail,
  data: { total: 42 }
});
if (!waitResume.resumed_runs.some((run: { id: string }) => run.id === waitStart.runs[0].id)) {
  throw new Error(`wait automation was not resumed ${JSON.stringify(waitResume.resumed_runs)}`);
}
const waitedRun = await waitForRun(waitStart.runs[0].id);
const waitedSend = waitedRun.steps.find((step: { type: string }) => step.type === "send_email");
if (!waitedSend?.data?.email_id) throw new Error("wait automation send step did not create an email");
const waitedEmail = await waitFor(waitedSend.data.email_id);
if (waitedEmail.status !== "delivered") throw new Error(`wait automation email ended ${waitedEmail.status}`);

const stopped = await post("/v1/automations", {
  name: `Stop flow ${Date.now()}`,
  trigger: "stop.started",
  steps: [{ type: "wait", event: "stop.finished", timeout_seconds: 60 }]
});
const stoppedEvent = await post("/v1/events", {
  name: "stop.started",
  email: `stop-${Date.now()}@example.com`,
  data: {}
});
if (stoppedEvent.runs[0].state !== "waiting") throw new Error("stop flow did not wait");
await post(`/v1/automations/${stopped.automation.id}/stop`, {});
const stoppedRun = await get(`/v1/automation-runs/${stoppedEvent.runs[0].id}`);
if (stoppedRun.run.state !== "stopped") throw new Error(`automation stop failed: ${stoppedRun.run.state}`);

await del(`/v1/automations/${automation.automation.id}`);
await del(`/v1/automations/${delayed.automation.id}`);
await del(`/v1/automations/${waited.automation.id}`);
await del(`/v1/automations/${stopped.automation.id}`);
console.log("automation run");

const attachmentContent = Buffer.from("Hello from a local attachment.").toString("base64");
const attached = await post(
  "/v1/emails",
  {
    from: "hello@example.com",
    to: "attachment@example.com",
    subject: "Attachment smoke",
    text: "See attached.",
    attachments: [{ filename: "hello.txt", content: attachmentContent, content_type: "text/plain" }]
  },
  { "idempotency-key": `attachment-${Date.now()}` }
);
const attachedEmail = await waitFor(attached.email.id);
if (attachedEmail.status !== "delivered") throw new Error(`attachment email ended ${attachedEmail.status}`);
const attachments = await get(`/v1/emails/${attached.email.id}/attachments`);
if (attachments.data.length !== 1) throw new Error("expected one sent attachment");
const attachment = await get(`/v1/emails/${attached.email.id}/attachments/${attachments.data[0].id}`);
if (attachment.attachment.content !== attachmentContent) throw new Error("sent attachment content mismatch");
const batchAttachment = await rawPost("/v1/emails/batch", {
  emails: [
    {
      from: "hello@example.com",
      to: "batch-attachment@example.com",
      subject: "Batch attachment",
      text: "should fail",
      attachments: [{ filename: "no.txt", content: attachmentContent }]
    }
  ]
});
if (batchAttachment.status !== 400) throw new Error(`expected batch attachment rejection, got ${batchAttachment.status}`);
console.log("attachment stored");

const contactEmail = `blocked-${Date.now()}@example.com`;
const contact = await post("/v1/contacts", {
  email: contactEmail,
  first_name: "Blocked",
  properties: { source: "smoke" },
  unsubscribed: true
});
const unsubscribed = await rawPost("/v1/emails", {
  from: "hello@example.com",
  to: contactEmail,
  subject: "Blocked",
  text: "should not send"
});
if (unsubscribed.status !== 400 || unsubscribed.json?.name !== "suppressed") {
  throw new Error(`expected unsubscribed contact suppression, got ${unsubscribed.status}`);
}
await del(`/v1/contacts/${contact.contact.id}`);
console.log("contact suppressed");

const suppressionEmail = `suppressed-${Date.now()}@example.com`;
const suppression = await post("/v1/suppressions", { email: suppressionEmail, reason: "smoke" });
const suppressed = await rawPost("/v1/emails", {
  from: "hello@example.com",
  to: suppressionEmail,
  subject: "Suppressed",
  text: "should not send"
});
if (suppressed.status !== 400 || suppressed.json?.name !== "suppressed") {
  throw new Error(`expected manual suppression, got ${suppressed.status}`);
}
await del(`/v1/suppressions/${suppression.suppression.id}`);
console.log("manual suppression");

const topic = await post("/v1/topics", {
  name: `Product updates ${Date.now()}`,
  default_status: "unsubscribed"
});
const segment = await post("/v1/segments", {
  name: `Launch list ${Date.now()}`
});
const broadcastEmail = `broadcast-${Date.now()}@example.com`;
const skippedEmail = `broadcast-skip-${Date.now()}@example.com`;
await post("/v1/contacts", { email: broadcastEmail, properties: { plan: "pro" } });
await post("/v1/contacts", { email: skippedEmail, properties: { plan: "free" } });
await post(`/v1/segments/${segment.segment.id}/contacts`, { email: broadcastEmail });
await post(`/v1/segments/${segment.segment.id}/contacts`, { email: skippedEmail });
await post(`/v1/topics/${topic.topic.id}/subscriptions`, { email: broadcastEmail, status: "subscribed" });
const broadcast = await post("/v1/broadcasts", {
  name: `Broadcast ${Date.now()}`,
  from: "hello@example.com",
  subject: "Broadcast smoke",
  text: "Local broadcast.",
  topic_id: topic.topic.id,
  segment_id: segment.segment.id
});
const sentBroadcast = await post(`/v1/broadcasts/${broadcast.broadcast.id}/send`, {});
if (sentBroadcast.broadcast.status !== "sent" || sentBroadcast.broadcast.recipient_count !== 1 || sentBroadcast.broadcast.sent_count !== 1) {
  throw new Error(`unexpected broadcast result ${JSON.stringify(sentBroadcast.broadcast)}`);
}
const broadcastDetail = await get(`/v1/broadcasts/${broadcast.broadcast.id}`);
const broadcastRecipient = broadcastDetail.broadcast.recipients[0];
if (!broadcastRecipient?.email_id || broadcastRecipient.email !== broadcastEmail) throw new Error("broadcast recipient snapshot failed");
const broadcastedEmail = await waitFor(broadcastRecipient.email_id);
if (broadcastedEmail.status !== "delivered") throw new Error(`broadcast email ended ${broadcastedEmail.status}`);
const segmentMembers = await get(`/v1/segments/${segment.segment.id}/contacts`);
const skippedMember = segmentMembers.data.find((member: { email: string }) => member.email === skippedEmail);
if (skippedMember) {
  await del(`/v1/segments/${segment.segment.id}/contacts/${skippedMember.id}`);
  const afterRemove = await get(`/v1/segments/${segment.segment.id}/contacts`);
  if (afterRemove.data.some((member: { email: string }) => member.email === skippedEmail)) throw new Error("segment removal failed");
}
const clonedBroadcast = await post(`/v1/broadcasts/${broadcast.broadcast.id}/clone`, { name: `Broadcast clone ${Date.now()}` });
await post(`/v1/broadcasts/${clonedBroadcast.broadcast.id}/cancel`, {});
console.log("broadcast sent");

const scheduled = await post(
  "/v1/emails",
  {
    from: "hello@example.com",
    to: "scheduled@example.com",
    subject: "Scheduled smoke",
    text: "later",
    scheduled_at: new Date(Date.now() + 2_000).toISOString()
  },
  { "idempotency-key": `scheduled-${Date.now()}` }
);
if (scheduled.email.status !== "scheduled") throw new Error(`expected scheduled status, got ${scheduled.email.status}`);
const updatedSchedule = await patch(`/v1/emails/${scheduled.email.id}`, {
  subject: "Scheduled smoke updated",
  text: "sooner",
  scheduled_at: new Date(Date.now() + 1_000).toISOString()
});
if (updatedSchedule.email.subject !== "Scheduled smoke updated") throw new Error("scheduled email update failed");
const scheduledEmail = await waitFor(scheduled.email.id);
if (scheduledEmail.status !== "delivered") throw new Error(`scheduled email ended ${scheduledEmail.status}`);
const jobs = await get(`/v1/email-jobs?email_id=${scheduled.email.id}`);
if (!jobs.data.some((job: { email_id: string }) => job.email_id === scheduled.email.id)) throw new Error("email job list missing scheduled job");
console.log("scheduled delivered");

const flowWebhook = await post("/v1/webhooks", {
  url: "http://localhost:8787/webhooks",
  events: ["email.received", "email.opened", "email.clicked"]
});

const tracked = await post(
  "/v1/emails",
  {
    from: "hello@example.com",
    to: "tracked@example.com",
    subject: "Tracking smoke",
    html: '<html><body><a href="https://example.com/docs">Docs</a></body></html>'
  },
  { "idempotency-key": `tracking-${Date.now()}` }
);
const trackedEmail = await waitFor(tracked.email.id);
if (trackedEmail.status !== "delivered") throw new Error(`tracking email ended ${trackedEmail.status}`);
const trackedDetail = await get(`/v1/emails/${tracked.email.id}`);
const trackedHtml = String(trackedDetail.email.html);
const openUrl = trackedHtml.match(/https?:\/\/[^"']+\/open\/[^"']+\.gif/)?.[0];
const clickUrl = trackedHtml.match(/https?:\/\/[^"']+\/click\/[^"']+/)?.[0];
if (!openUrl || !clickUrl) throw new Error("tracking URLs were not written into HTML");
const openResponse = await rawGet(openUrl);
if (openResponse.status !== 200) throw new Error(`expected open pixel 200, got ${openResponse.status}`);
const clickResponse = await rawGet(clickUrl, { redirect: "manual" });
if (![301, 302, 303, 307, 308].includes(clickResponse.status)) throw new Error(`expected click redirect, got ${clickResponse.status}`);
await waitForEvent(tracked.email.id, "email.opened");
await waitForEvent(tracked.email.id, "email.clicked");
console.log("tracking events");

const receivedContent = Buffer.from("Hello inbound attachment.").toString("base64");
const received = await post("/v1/received-emails/simulate", {
  from: "sender@example.net",
  to: "inbound@example.com",
  subject: "Inbound smoke",
  text: "Received locally.",
  headers: { "x-smoke": "true" },
  attachments: [{ filename: "inbound.txt", content: receivedContent, content_type: "text/plain" }]
});
const receivedDetail = await get(`/v1/received-emails/${received.received_email.id}`);
if (receivedDetail.received_email.attachments.length !== 1) throw new Error("expected one received attachment");
const receivedAttachments = await get(`/v1/received-emails/${received.received_email.id}/attachments`);
if (receivedAttachments.data.length !== 1) throw new Error("expected received attachment list");
const receivedAttachment = await get(
  `/v1/received-emails/${received.received_email.id}/attachments/${receivedAttachments.data[0].id}`
);
if (receivedAttachment.attachment.content !== receivedContent) throw new Error("received attachment content mismatch");
await waitForAttemptCount(flowWebhook.webhook.id, 3);
await del(`/v1/webhooks/${flowWebhook.webhook.id}`);
console.log("received email stored");

const webhooks = await get("/v1/webhooks");
const receiver = webhooks.data.find((webhook: { url: string }) => webhook.url.includes("localhost:8787")) ?? webhooks.data[0];
if (receiver) {
  await waitForSentWebhook(receiver.id);
}

const failing = await post("/v1/webhooks", {
  url: "http://localhost:9/webhooks",
  events: ["email.sent"]
});
await post("/v1/webhooks/test", {});
await waitForRetry(failing.webhook.id);
await del(`/v1/webhooks/${failing.webhook.id}`);
const system = await get("/v1/system");
if (!system.ok || !system.worker) throw new Error("system health missing worker state");
const timeline = await get("/v1/timeline");
if (!timeline.data.some((item: { kind: string }) => item.kind === "email_event")) throw new Error("timeline missing email events");
const usage = await get("/v1/usage");
if (!usage.data.some((counter: { name: string }) => counter.name === "api_requests")) throw new Error("usage counters missing API requests");
console.log("ops visible");

async function waitFor(id: string) {
  return poll("email did not leave queued state", async () => {
    const response = await get(`/v1/emails/${id}`);
    if (["delivered", "bounced", "complained", "failed"].includes(response.email.status)) return response.email;
  }, 10_000);
}

async function waitForRetry(webhookId: string) {
  await poll("webhook retry was not queued", async () => {
    const attempts = await get(`/v1/webhooks/${webhookId}/attempts`);
    const failed = attempts.data.find((attempt: { state: string }) => attempt.state === "failed");
    const retry = attempts.data.find((attempt: { state: string; attempt: number }) => attempt.state === "queued" && attempt.attempt > 1);
    if (failed && retry) {
      console.log("webhook retry queued");
      return true;
    }
  });
}

async function waitForSentWebhook(webhookId: string) {
  await poll("no sent webhook attempt found", async () => {
    const attempts = await get(`/v1/webhooks/${webhookId}/attempts`);
    const sentAttempt = attempts.data.find((attempt: { state: string }) => attempt.state === "sent");
    if (sentAttempt) {
      console.log("webhook", sentAttempt.state);
      return true;
    }
  });
}

async function waitForEvent(emailId: string, type: string) {
  await poll(`event ${type} not found`, async () => {
    const events = await get(`/v1/emails/${emailId}/events`);
    return events.data.some((event: { type: string }) => event.type === type);
  });
}

async function waitForRun(id: string) {
  return poll("automation run did not finish", async () => {
    const response = await get(`/v1/automation-runs/${id}`);
    if (response.run.state === "done") return response.run;
    if (response.run.state === "failed") throw new Error(`automation run failed: ${response.run.error}`);
  }, 10_000);
}

async function waitForAttemptCount(webhookId: string, count: number) {
  await poll(`webhook did not record ${count} attempts`, async () => {
    const attempts = await get(`/v1/webhooks/${webhookId}/attempts`);
    return attempts.data.length >= count;
  });
}

async function poll<T>(message: string, check: () => Promise<T | false | undefined>, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(300);
  }
  throw new Error(message);
}

async function deleteStaleFailingWebhooks() {
  const webhooks = await get("/v1/webhooks");
  for (const webhook of webhooks.data as Array<{ id: string; url: string }>) {
    if (webhook.url.includes("localhost:9/")) await del(`/v1/webhooks/${webhook.id}`);
  }
}

async function get(path: string, auth = true) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: auth ? headers : undefined
  });
  return read(response);
}

async function getAs(key: string, path: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { authorization: `Bearer ${key}` }
  });
  return read(response);
}

async function post(path: string, body: unknown, extraHeaders: Record<string, string> = {}, auth = true) {
  const response = auth ? await rawPost(path, body, extraHeaders) : await rawPostWithoutAuth(path, body, extraHeaders);
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(response.json)}`);
  return response.json;
}

async function patch(path: string, body: unknown) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body)
  });
  return read(response);
}

async function rawPost(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return rawPostAs(apiKey, path, body, extraHeaders);
}

async function postAs(key: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await rawPostAs(key, path, body, extraHeaders);
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(response.json)}`);
  return response.json;
}

async function rawPostAs(key: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, json };
}

async function rawPostWithoutAuth(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, json };
}

async function rawGet(url: string, init: RequestInit = {}) {
  return fetch(url, init);
}

async function del(path: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "DELETE",
    headers: authHeaders
  });
  return read(response);
}

async function read(response: Response) {
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(json)}`);
  return json;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
