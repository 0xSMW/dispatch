#!/usr/bin/env node
import "dotenv/config";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Dispatch } from "@dispatch/sdk";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const command = args[0] ?? "help";
const api = new Dispatch({
  apiKey: process.env.DISPATCH_API_KEY ?? "sk_local_dispatch_dev_key_change_before_deploy",
  baseUrl: process.env.API_URL ?? "http://localhost:3100",
  userAgent: "dispatch-cli/0.1.0"
});
const execFile = promisify(execFileCb);

try {
  switch (command) {
    case "doctor":
      await doctor();
      break;
    case "send":
      await send();
      break;
    case "batch":
      await batch();
      break;
    case "domains":
      await domains();
      break;
    case "keys":
      await keys();
      break;
    case "templates":
      await templates();
      break;
    case "contacts":
      await contacts();
      break;
    case "suppressions":
      await suppressions();
      break;
    case "topics":
      await topics();
      break;
    case "segments":
      await segments();
      break;
    case "broadcasts":
      await broadcasts();
      break;
    case "automations":
      await automations();
      break;
    case "emails":
      await emails();
      break;
    case "received":
      await received();
      break;
    case "events":
      await events();
      break;
    case "logs":
      await logs();
      break;
    case "timeline":
      console.log(JSON.stringify(await api.timeline(), null, 2));
      break;
    case "usage":
      console.log(JSON.stringify(await api.usage(), null, 2));
      break;
    case "system":
      console.log(JSON.stringify(await api.system(), null, 2));
      break;
    case "webhooks":
      await webhooks();
      break;
    case "replay":
      await replay();
      break;
    case "tail":
      await tail();
      break;
    case "listen":
      listen();
      break;
    case "test-webhook":
      console.log(JSON.stringify(await api.testWebhook(), null, 2));
      break;
    case "verify-domain":
      await verifyDomain();
      break;
    case "dev":
      await dev(args[1]);
      break;
    default:
      help();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function doctor() {
  const checks = [];
  checks.push(await check("docker", async () => runCapture("docker", ["compose", "ps", "--format", "json"])));
  checks.push(await check("postgres", async () => tcp(5432)));
  checks.push(await check("redis", async () => tcp(6379)));
  checks.push(await check("mailpit", async () => tcp(8025)));
  checks.push(await check("api", async () => api.setup()));
  checks.push(await check("health", async () => fetch(`${process.env.API_URL ?? "http://localhost:3100"}/health`).then((r) => r.json())));
  checks.push(await check("system", async () => api.system()));
  checks.push(await check("domains", async () => api.domains()));
  checks.push(await check("emails", async () => api.emails()));
  checks.push(await check("webhooks", async () => api.webhooks()));

  for (const item of checks) {
    console.log(`${item.ok ? "ok" : "fail"} ${item.name}${item.detail ? ` ${item.detail}` : ""}`);
  }

  if (checks.some((item) => !item.ok)) process.exitCode = 1;
}

async function send() {
  const from = value("--from") ?? "hello@example.com";
  const to = value("--to") ?? "you@example.com";
  const subject = value("--subject") ?? "Dispatch local test";
  const text = value("--text") ?? "This email was accepted locally, sent by the fake provider, and tracked through events.";
  const template = value("--template");
  const variables = jsonValue("--variables") ?? {};
  const attachments = await attachmentsFromArgs();
  const body = template
    ? { from, to, template, variables, ...(attachments.length > 0 ? { attachments } : {}) }
    : { from, to, subject, text, ...(attachments.length > 0 ? { attachments } : {}) };
  const response = await api.send(body, value("--idempotency-key") ?? `cli-${Date.now()}`);
  console.log(JSON.stringify(response, null, 2));
}

async function batch() {
  const emails = (jsonValue("--emails") ?? batchEmails()) as Parameters<Dispatch["batch"]>[0];
  const response = await api.batch(emails, value("--idempotency-key") ?? `cli-batch-${Date.now()}`);
  console.log(JSON.stringify(response, null, 2));
}

function batchEmails() {
  const from = value("--from") ?? "hello@example.com";
  const tos = values("--to");
  const recipients = tos.length > 0 ? tos : ["batch-one@example.com", "batch-two@example.com"];
  const subject = value("--subject") ?? "Dispatch local batch";
  const text = value("--text") ?? "This email was accepted through the local batch API.";
  return recipients.map((to, index) => ({
    from,
    to,
    subject: recipients.length === 1 ? subject : `${subject} ${index + 1}`,
    text
  }));
}

async function domains() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const name = args[2] ?? value("--name");
    if (!name) throw new Error("Usage: dispatch domains create <name> [--region us-east-1]");
    console.log(JSON.stringify(await api.createDomain({ name, region: value("--region") }), null, 2));
    return;
  }
  if (subcommand === "verify") {
    const domainId = args[2];
    if (!domainId) throw new Error("Usage: dispatch domains verify <domain-id>");
    console.log(JSON.stringify(await api.verifyDomain(domainId), null, 2));
    return;
  }
  if (subcommand === "doctor") {
    const domainId = args[2];
    const domains = (await api.domains()) as { data: Array<{ id: string }> };
    const target = domainId ?? domains.data[0]?.id;
    if (!target) throw new Error("No domain found");
    console.log(JSON.stringify(await api.doctorDomain(target), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.domains(), null, 2));
}

async function keys() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const name = args[2] ?? value("--name") ?? `key-${Date.now()}`;
    console.log(JSON.stringify(await api.createKey({ name, scope: (value("--scope") as "full" | "send" | undefined) ?? "full" }), null, 2));
    return;
  }
  if (subcommand === "delete") {
    const keyId = args[2];
    if (!keyId) throw new Error("Usage: dispatch keys delete <key-id>");
    console.log(JSON.stringify(await api.deleteKey(keyId), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.keys(), null, 2));
}

async function templates() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const name = value("--name") ?? args[2];
    const subject = value("--subject");
    const text = value("--text");
    const html = value("--html");
    if (!name || !subject || (!text && !html)) {
      throw new Error("Usage: dispatch templates create <name> --subject subject [--text body] [--html html] [--alias alias]");
    }
    console.log(
      JSON.stringify(
        await api.createTemplate({
          name,
          alias: value("--alias"),
          subject,
          text,
          html,
          variables: value("--variables")?.split(",").filter(Boolean) ?? []
        }),
        null,
        2
      )
    );
    return;
  }
  if (subcommand === "render") {
    const templateId = args[2];
    if (!templateId) throw new Error("Usage: dispatch templates render <template-id> --variables '{\"name\":\"Ada\"}'");
    console.log(JSON.stringify(await api.renderTemplate(templateId, jsonValue("--variables") ?? {}), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.templates(), null, 2));
}

async function contacts() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const email = args[2] ?? value("--email");
    if (!email) throw new Error("Usage: dispatch contacts create <email> [--first Ada] [--last Lovelace]");
    console.log(
      JSON.stringify(
        await api.createContact({
          email,
          first_name: value("--first"),
          last_name: value("--last"),
          properties: jsonValue("--properties") ?? {},
          unsubscribed: Boolean(value("--unsubscribed"))
        }),
        null,
        2
      )
    );
    return;
  }
  console.log(JSON.stringify(await api.contacts(), null, 2));
}

async function suppressions() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const email = args[2] ?? value("--email");
    if (!email) throw new Error("Usage: dispatch suppressions create <email> [--reason manual]");
    console.log(JSON.stringify(await api.suppress({ email, reason: value("--reason") ?? "manual" }), null, 2));
    return;
  }
  if (subcommand === "delete") {
    const suppressionId = args[2];
    if (!suppressionId) throw new Error("Usage: dispatch suppressions delete <suppression-id>");
    console.log(JSON.stringify(await api.unsuppress(suppressionId), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.suppressions(), null, 2));
}

async function topics() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const name = args[2] ?? value("--name");
    if (!name) throw new Error("Usage: dispatch topics create <name> [--key product-updates] [--default subscribed]");
    console.log(
      JSON.stringify(
        await api.createTopic({
          name,
          key: value("--key"),
          default_status: (value("--default") as "subscribed" | "unsubscribed" | undefined) ?? "subscribed"
        }),
        null,
        2
      )
    );
    return;
  }
  if (subcommand === "subscribe") {
    const topicId = args[2];
    const email = args[3] ?? value("--email");
    if (!topicId || !email) throw new Error("Usage: dispatch topics subscribe <topic-id> <email> [--status subscribed]");
    console.log(
      JSON.stringify(
        await api.subscribe(topicId, {
          email,
          status: (value("--status") as "subscribed" | "unsubscribed" | undefined) ?? "subscribed"
        }),
        null,
        2
      )
    );
    return;
  }
  if (subcommand === "subscriptions") {
    const topicId = args[2];
    if (!topicId) throw new Error("Usage: dispatch topics subscriptions <topic-id>");
    console.log(JSON.stringify(await api.topicSubscriptions(topicId), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.topics(), null, 2));
}

async function segments() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const name = args[2] ?? value("--name");
    if (!name) throw new Error("Usage: dispatch segments create <name> [--description text]");
    console.log(JSON.stringify(await api.createSegment({ name, description: value("--description") }), null, 2));
    return;
  }
  if (subcommand === "add") {
    const segmentId = args[2];
    const email = args[3] ?? value("--email");
    if (!segmentId || !email) throw new Error("Usage: dispatch segments add <segment-id> <email>");
    console.log(JSON.stringify(await api.addSegmentContact(segmentId, { email }), null, 2));
    return;
  }
  if (subcommand === "remove") {
    const segmentId = args[2];
    const contactId = args[3] ?? value("--contact");
    if (!segmentId || !contactId) throw new Error("Usage: dispatch segments remove <segment-id> <segment-contact-id>");
    console.log(JSON.stringify(await api.removeSegmentContact(segmentId, contactId), null, 2));
    return;
  }
  if (subcommand === "contacts") {
    const segmentId = args[2];
    if (!segmentId) throw new Error("Usage: dispatch segments contacts <segment-id>");
    console.log(JSON.stringify(await api.segmentContacts(segmentId), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.segments(), null, 2));
}

async function broadcasts() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const name = args[2] ?? value("--name");
    const from = value("--from") ?? "hello@example.com";
    const subject = value("--subject");
    const text = value("--text");
    const html = value("--html");
    const template = value("--template");
    if (!name || (!template && !subject) || (!template && !text && !html)) {
      throw new Error("Usage: dispatch broadcasts create <name> --subject subject [--text body] [--html html] [--topic id] [--segment id]");
    }
    console.log(
      JSON.stringify(
        await api.createBroadcast({
          name,
          from,
          subject,
          text,
          html,
          template,
          variables: jsonValue("--variables") ?? {},
          topic_id: value("--topic"),
          segment_id: value("--segment")
        }),
        null,
        2
      )
    );
    return;
  }
  if (subcommand === "send") {
    const broadcastId = args[2];
    if (!broadcastId) throw new Error("Usage: dispatch broadcasts send <broadcast-id>");
    console.log(JSON.stringify(await api.sendBroadcast(broadcastId), null, 2));
    return;
  }
  if (subcommand === "get") {
    const broadcastId = args[2];
    if (!broadcastId) throw new Error("Usage: dispatch broadcasts get <broadcast-id>");
    console.log(JSON.stringify(await api.broadcast(broadcastId), null, 2));
    return;
  }
  if (subcommand === "clone") {
    const broadcastId = args[2];
    if (!broadcastId) throw new Error("Usage: dispatch broadcasts clone <broadcast-id> [--name name]");
    console.log(JSON.stringify(await api.cloneBroadcast(broadcastId, { name: value("--name") }), null, 2));
    return;
  }
  if (["pause", "resume", "cancel"].includes(subcommand ?? "")) {
    const broadcastId = args[2];
    if (!broadcastId) throw new Error(`Usage: dispatch broadcasts ${subcommand} <broadcast-id>`);
    const action =
      subcommand === "pause" ? api.pauseBroadcast(broadcastId) : subcommand === "resume" ? api.resumeBroadcast(broadcastId) : api.cancelBroadcast(broadcastId);
    console.log(JSON.stringify(await action, null, 2));
    return;
  }
  console.log(JSON.stringify(await api.broadcasts(), null, 2));
}

async function events() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const name = args[2] ?? value("--name");
    if (!name) throw new Error("Usage: dispatch events create <name> [--email user@example.com] [--data '{}']");
    console.log(JSON.stringify(await api.createEvent({ name, email: value("--email"), data: jsonValue("--data") ?? {} }), null, 2));
    return;
  }
  if (subcommand === "get") {
    const eventId = args[2];
    if (!eventId) throw new Error("Usage: dispatch events get <event-id>");
    console.log(JSON.stringify(await api.event(eventId), null, 2));
    return;
  }
  if (subcommand === "update") {
    const eventId = args[2];
    if (!eventId) throw new Error("Usage: dispatch events update <event-id> [--name name] [--email user@example.com] [--data '{}']");
    console.log(
      JSON.stringify(
        await api.updateEvent(eventId, {
          name: value("--name"),
          email: value("--email"),
          data: jsonValue("--data")
        }),
        null,
        2
      )
    );
    return;
  }
  if (subcommand === "delete") {
    const eventId = args[2];
    if (!eventId) throw new Error("Usage: dispatch events delete <event-id>");
    console.log(JSON.stringify(await api.deleteEvent(eventId), null, 2));
    return;
  }
  if (subcommand === "email") {
    const emailId = args[2];
    if (!emailId) throw new Error("Usage: dispatch events email <email-id>");
    console.log(JSON.stringify(await api.emailEvents(emailId), null, 2));
    return;
  }
  if (subcommand) {
    console.log(JSON.stringify(await api.emailEvents(subcommand), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.events(), null, 2));
}

async function automations() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const name = args[2] ?? value("--name");
    const trigger = value("--trigger");
    const steps = jsonValue("--steps");
    if (!name || !trigger || !steps) {
      throw new Error("Usage: dispatch automations create <name> --trigger event.name --steps '[{\"type\":\"send_email\",...}]'");
    }
    console.log(JSON.stringify(await api.createAutomation({ name, trigger, steps }), null, 2));
    return;
  }
  if (subcommand === "get") {
    const automationId = args[2];
    if (!automationId) throw new Error("Usage: dispatch automations get <automation-id>");
    console.log(JSON.stringify(await api.automation(automationId), null, 2));
    return;
  }
  if (subcommand === "runs") {
    const automationId = args[2];
    if (!automationId) throw new Error("Usage: dispatch automations runs <automation-id>");
    console.log(JSON.stringify(await api.automationRuns(automationId), null, 2));
    return;
  }
  if (subcommand === "run") {
    const runId = args[2];
    if (!runId) throw new Error("Usage: dispatch automations run <run-id>");
    console.log(JSON.stringify(await api.automationRun(runId), null, 2));
    return;
  }
  if (subcommand === "stop") {
    const automationId = args[2];
    if (!automationId) throw new Error("Usage: dispatch automations stop <automation-id>");
    console.log(JSON.stringify(await api.stopAutomation(automationId), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.automations(), null, 2));
}

async function emails() {
  const subcommand = args[1];
  if (subcommand === "get") {
    const emailId = args[2];
    if (!emailId) throw new Error("Usage: dispatch emails get <email-id>");
    console.log(JSON.stringify(await api.email(emailId), null, 2));
    return;
  }
  if (subcommand === "events") {
    const emailId = args[2];
    if (!emailId) throw new Error("Usage: dispatch emails events <email-id>");
    console.log(JSON.stringify(await api.emailEvents(emailId), null, 2));
    return;
  }
  if (subcommand === "retry") {
    const emailId = args[2];
    if (!emailId) throw new Error("Usage: dispatch emails retry <email-id>");
    console.log(JSON.stringify(await api.retryEmail(emailId), null, 2));
    return;
  }
  if (subcommand === "update") {
    const emailId = args[2];
    if (!emailId) throw new Error("Usage: dispatch emails update <email-id> [--subject subject] [--text body] [--html html] [--scheduled-at iso]");
    console.log(
      JSON.stringify(
        await api.updateEmail(emailId, {
          subject: value("--subject"),
          text: value("--text"),
          html: value("--html"),
          scheduled_at: value("--scheduled-at")
        }),
        null,
        2
      )
    );
    return;
  }
  if (subcommand === "attachments") {
    const emailId = args[2];
    const attachmentId = args[3];
    if (!emailId) throw new Error("Usage: dispatch emails attachments <email-id> [attachment-id]");
    console.log(JSON.stringify(attachmentId ? await api.emailAttachment(emailId, attachmentId) : await api.emailAttachments(emailId), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.emails(), null, 2));
}

async function logs() {
  const subcommand = args[1];
  if (subcommand === "export") {
    const response = await fetch(`${process.env.API_URL ?? "http://localhost:3100"}/v1/logs/export`, {
      headers: {
        authorization: `Bearer ${process.env.DISPATCH_API_KEY ?? "sk_local_dispatch_dev_key_change_before_deploy"}`,
        "user-agent": "dispatch-cli/0.1.0"
      }
    });
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.logs(), null, 2));
}

async function received() {
  const subcommand = args[1];
  if (subcommand === "simulate") {
    const from = value("--from") ?? "sender@example.net";
    const to = value("--to") ?? "inbound@example.com";
    const subject = value("--subject") ?? "Inbound local test";
    const text = value("--text");
    const html = value("--html");
    const attachments = await attachmentsFromArgs();
    console.log(
      JSON.stringify(
        await api.simulateReceivedEmail({
          from,
          to,
          subject,
          text: text ?? (html ? undefined : "This received email was simulated locally."),
          html,
          headers: jsonValue("--headers") ?? {},
          attachments
        }),
        null,
        2
      )
    );
    return;
  }
  if (subcommand === "get") {
    const receivedId = args[2];
    if (!receivedId) throw new Error("Usage: dispatch received get <received-email-id>");
    console.log(JSON.stringify(await api.receivedEmail(receivedId), null, 2));
    return;
  }
  if (subcommand === "attachments") {
    const receivedId = args[2];
    const attachmentId = args[3];
    if (!receivedId) throw new Error("Usage: dispatch received attachments <received-email-id> [attachment-id]");
    console.log(
      JSON.stringify(attachmentId ? await api.receivedAttachment(receivedId, attachmentId) : await api.receivedAttachments(receivedId), null, 2)
    );
    return;
  }
  console.log(JSON.stringify(await api.receivedEmails(), null, 2));
}

async function webhooks() {
  const subcommand = args[1];
  if (subcommand === "create") {
    const url = args[2] ?? value("--url");
    if (!url) throw new Error("Usage: dispatch webhooks create <url>");
    console.log(
      JSON.stringify(
        await api.createWebhook({
          url,
          events: value("--events")?.split(",").filter(Boolean) ?? ["email.sent", "email.delivered"]
        }),
        null,
        2
      )
    );
    return;
  }
  if (subcommand === "attempts") {
    const webhookId = args[2];
    if (!webhookId) throw new Error("Usage: dispatch webhooks attempts <webhook-id>");
    console.log(JSON.stringify(await api.webhookAttempts(webhookId), null, 2));
    return;
  }
  if (subcommand === "test") {
    console.log(JSON.stringify(await api.testWebhook(), null, 2));
    return;
  }
  console.log(JSON.stringify(await api.webhooks(), null, 2));
}

async function replay() {
  const webhookId = args[1];
  if (!webhookId) throw new Error("Usage: dispatch replay <webhook-id> [--attempt attempt_id] [--event event_id]");
  console.log(
    JSON.stringify(
      await api.replayWebhook(webhookId, {
        attempt_id: value("--attempt"),
        event_id: value("--event")
      }),
      null,
      2
    )
  );
}

async function tail() {
  const seen = new Set<string>();
  while (true) {
    const response = (await api.emails()) as { data: Array<{ id: string; status: string; subject: string }> };
    for (const email of response.data.reverse()) {
      const key = `${email.id}:${email.status}`;
      if (!seen.has(key)) {
        seen.add(key);
        console.log(`${new Date().toISOString()} ${email.id} ${email.status} ${email.subject}`);
      }
    }
    await sleep(1_000);
  }
}

function listen() {
  const port = Number(value("--port") ?? 8787);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    console.log(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          method: request.method,
          url: request.url,
          id: request.headers["dispatch-webhook-id"],
          signature: request.headers["dispatch-webhook-signature"],
          body: JSON.parse(body || "{}")
        },
        null,
        2
      )
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(port, () => console.log(`listening on http://localhost:${port}/webhooks`));
}

async function dev(subcommand?: string) {
  if (subcommand === "up") {
    await run("docker", ["compose", "up", "-d"]);
    return;
  }
  if (subcommand === "seed") {
    await run("pnpm", ["db:seed"]);
    return;
  }
  help();
}

async function verifyDomain() {
  const domainId = args[1];
  const domains = (await api.domains()) as { data: Array<{ id: string; name: string }> };
  const target = domainId ?? domains.data[0]?.id;
  if (!target) throw new Error("No domain found");
  console.log(JSON.stringify(await api.doctorDomain(target), null, 2));
}

async function check(name: string, runCheck: () => Promise<unknown>) {
  try {
    const result = await runCheck();
    return { name, ok: true, detail: summarize(result) };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function summarize(result: unknown) {
  if (result && typeof result === "object" && "ok" in result) return JSON.stringify(result);
  if (typeof result === "string") return result.length > 80 ? result.slice(0, 77) + "..." : result;
  return "";
}

async function runCapture(commandName: string, commandArgs: string[]) {
  const { stdout } = await execFile(commandName, commandArgs, { cwd: process.cwd() });
  return stdout.trim() ? "ready" : "empty";
}

function tcp(port: number) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 1_000 });
    socket.on("connect", () => {
      socket.destroy();
      resolve("ready");
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`port ${port} timed out`));
    });
    socket.on("error", reject);
  });
}

function value(name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function jsonValue(name: string) {
  const raw = value(name);
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function values(name: string) {
  const matches: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) matches.push(args[index + 1]);
  }
  return matches;
}

async function attachmentsFromArgs() {
  const files = values("--attachment");
  const contentType = value("--attachment-type") ?? "application/octet-stream";
  return Promise.all(
    files.map(async (file) => ({
      filename: basename(file),
      content: (await readFile(file)).toString("base64"),
      content_type: contentType,
      disposition: "attachment" as const
    }))
  );
}

function run(commandName: string, commandArgs: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(commandName, commandArgs, { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${commandName} exited ${code}`))));
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function help() {
  console.log(`dispatch commands:
  doctor
  dev up
  dev seed
  send [--from hello@example.com] [--to you@example.com] [--subject subject] [--text body]
  send [--attachment ./file.pdf] [--attachment-type application/pdf]
  batch [--from hello@example.com] [--to one@example.com] [--to two@example.com] [--subject subject] [--text body]
  batch --emails '[{"from":"hello@example.com","to":"you@example.com","subject":"Subject","text":"Body"}]'
  domains
  domains create <name> [--region us-east-1]
  domains verify <domain-id>
  domains doctor [domain-id]
  keys
  keys create [name] [--scope full]
  keys delete <key-id>
  templates
  templates create <name> --subject subject [--text body] [--html html] [--alias alias]
  templates render <template-id> --variables '{"name":"Ada"}'
  contacts
  contacts create <email> [--first first] [--last last]
  suppressions
  suppressions create <email> [--reason reason]
  suppressions delete <suppression-id>
  topics
  topics create <name> [--key product-updates] [--default subscribed]
  topics subscribe <topic-id> <email> [--status subscribed]
  topics subscriptions <topic-id>
  segments
  segments create <name> [--description text]
  segments add <segment-id> <email>
  segments remove <segment-id> <segment-contact-id>
  segments contacts <segment-id>
  broadcasts
  broadcasts create <name> --subject subject [--text body] [--html html] [--topic id] [--segment id]
  broadcasts send <broadcast-id>
  broadcasts get <broadcast-id>
  broadcasts pause <broadcast-id>
  broadcasts resume <broadcast-id>
  broadcasts cancel <broadcast-id>
  broadcasts clone <broadcast-id> [--name name]
  automations
  automations create <name> --trigger event.name --steps '[{"type":"send_email","from":"hello@example.com","template":"welcome"}]'
  automations get <automation-id>
  automations runs <automation-id>
  automations run <run-id>
  automations stop <automation-id>
  emails
  emails get <email-id>
  emails update <email-id> [--subject subject] [--text body] [--html html] [--scheduled-at iso]
  emails retry <email-id>
  emails events <email-id>
  emails attachments <email-id> [attachment-id]
  received
  received simulate [--from sender@example.net] [--to inbound@example.com] [--text body]
  received get <received-email-id>
  received attachments <received-email-id> [attachment-id]
  events
  events create <name> [--email user@example.com] [--data '{}']
  events get <event-id>
  events update <event-id> [--name name] [--email user@example.com] [--data '{}']
  events delete <event-id>
  events email <email-id>
  logs
  logs export
  timeline
  usage
  system
  webhooks
  webhooks create <url> [--events email.sent,email.delivered]
  webhooks test
  webhooks attempts <webhook-id>
  replay <webhook-id> [--attempt attempt_id] [--event event_id]
  tail
  listen [--port 8787]
  test-webhook
  verify-domain [domain-id]`);
}
