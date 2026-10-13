import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Dispatch, WebhookVerificationError } from "../../packages/sdk/src/index.js";
import type { Usage } from "./common.js";

export async function send(u: Usage): Promise<void> {
  u.check((await u.api("GET", "/health")).provider === "fake", "Sending journey requires the fake provider");
  u.check(["127.0.0.1", "localhost", "[::1]"].includes(new URL(u.hook.url).hostname), "Webhook receiver must be local");
  const hook = await u.api("POST", "/webhooks", { endpoint: u.hook.url, events: ["email.delivered"], enabled: true });
  u.clean(`/webhooks/${hook.id}`);
  const bytes = Buffer.from(`${u.run} attachment bytes\n`);
  const body = {
    from: u.sender, to: `send-${u.run}@dispatch.fixture`, subject: `${u.run} sending`, text: "Local fake delivery",
    attachments: [{ filename: "usage.txt", content_type: "text/plain", content: bytes.toString("base64") }],
  };
  const headers = { "Idempotency-Key": `${u.run}-send` };
  const pair = await Promise.all([
    u.api("POST", "/emails", body, 200, u.key, headers),
    u.api("POST", "/emails", body, 200, u.key, headers),
  ]);
  u.check(typeof pair[0].id === "string" && pair[0].id === pair[1].id && pair[0].sandbox === false, "Identical sends must return one non-sandbox email ID");
  const email = pair[0].id;
  const mismatch = await u.api("POST", "/emails", { ...body, subject: `${u.run} changed` }, 409, u.key, headers);
  u.check(mismatch.name === "invalid_idempotent_request", "Changed idempotency payload must be rejected");

  const scheduled = await u.api("POST", "/emails", {
    from: u.sender, to: `scheduled-${u.run}@dispatch.fixture`, subject: `${u.run} scheduled`, text: "Later", scheduled_at: "in 2 days",
  });
  await u.api("POST", `/emails/${scheduled.id}/cancel`, {});
  const rows = await u.wait(() => u.sql(
    "select e.subject,e.status,e.sandbox,e.provider_message_id,j.state,j.attempts from emails e join send_jobs j on j.email_id=e.id and j.tenant_id=e.tenant_id where e.tenant_id=$1 and e.id=$2",
    [u.tenant, email],
  ), rows => rows.length === 1 && rows[0].status === "delivered" && rows[0].state === "done", "one delivered send job");
  u.check(rows[0].subject === body.subject && rows[0].attempts === 1 && rows[0].sandbox === false && rows[0].provider_message_id, "Original fake send must complete once without payload replacement");
  const copies = await u.sql("select count(*)::integer total from emails where tenant_id=$1 and subject=$2", [u.tenant, body.subject]);
  u.check(copies[0].total === 1, "Concurrent requests must persist one email");
  const recipients = await u.sql("select status,sandbox from email_recipients where tenant_id=$1 and email_id=$2", [u.tenant, email]);
  u.check(recipients.length === 1 && recipients[0].status === "delivered" && recipients[0].sandbox === false, "Recipient delivery must persist");
  const saved = await u.sql("select state,response_json from idempotency_keys where tenant_id=$1 and key=$2", [u.tenant, headers["Idempotency-Key"]]);
  u.check(saved.length === 1 && saved[0].state === "done" && saved[0].response_json.email.id === email, "One completed idempotency record must persist");

  const attachments = await u.api("GET", `/emails/${email}/attachments`);
  u.check(attachments.data.length === 1, "One attachment must be listed");
  const attachment = await u.api("GET", `/emails/${email}/attachments/${attachments.data[0].id}`);
  u.check(new URL(attachment.download_url).origin === new URL(u.url).origin, "Attachment download must stay on the local API");
  const downloaded = Buffer.from(await u.command("curl", ["--fail", "--silent", "--show-error", "--max-time", "15", attachment.download_url]));
  u.check(downloaded.equals(bytes) && attachment.size === bytes.length, "Signed attachment bytes must match the supplied file");
  const stored = await u.sql("select size_bytes,content_hash from email_attachments where tenant_id=$1 and email_id=$2 and id=$3", [u.tenant, email, attachment.id]);
  const contentHash = createHash("sha256").update(downloaded.toString("base64")).digest("hex");
  u.check(stored.length === 1 && stored[0].size_bytes === bytes.length && stored[0].content_hash === contentHash, "Stored attachment size and hash must match its download");

  const events = await u.sql("select id from email_events where tenant_id=$1 and email_id=$2 and type='email.delivered'", [u.tenant, email]);
  u.check(events.length === 1, "One delivered event must persist");
  const receipt = await u.wait(async () => u.hook.receipts.find(row => JSON.parse(row.raw).id === events[0].id), Boolean, "signed webhook receipt");
  const sdk = new Dispatch({ apiKey: u.key, baseUrl: u.url });
  const verification = {
    payload: receipt.raw, webhookSecret: hook.signing_secret,
    headers: { id: String(receipt.headers["webhook-id"]), timestamp: String(receipt.headers["webhook-timestamp"]), signature: String(receipt.headers["webhook-signature"]) },
  };
  const payload = sdk.webhooks.verify<{ id: string; type: string }>(verification);
  u.check(payload.id === events[0].id && payload.type === "email.delivered", "Public SDK must verify the actual webhook payload");
  let rejected = false;
  try { sdk.webhooks.verify({ ...verification, payload: `${receipt.raw} ` }); }
  catch (error) { rejected = error instanceof WebhookVerificationError; }
  u.check(rejected, "Public SDK must reject a tampered webhook payload");
  await u.wait(() => u.sql("select state,status from webhook_attempts where tenant_id=$1 and webhook_id=$2 and event_id=$3", [u.tenant, hook.id, events[0].id]),
    rows => rows.length === 1 && rows[0].state === "sent" && rows[0].status === 200, "recorded webhook delivery");
  await u.restart();
  const afterRestart = await u.api("GET", `/emails/${email}`);
  u.check(afterRestart.last_event === "delivered", "Delivered state must survive a worker restart");
  const durable = await u.sql("select j.state,j.attempts,(select count(*)::int from email_events v where v.email_id=j.email_id and v.type='email.delivered') as delivered from send_jobs j where j.tenant_id=$1 and j.email_id=$2", [u.tenant, email]);
  u.check(durable.length === 1 && durable[0].state === "done" && durable[0].attempts === 1 && durable[0].delivered === 1, "Worker restart must preserve one completed job and delivery event");
  const cancelled = await u.sql("select e.status,e.provider_message_id,j.state,j.attempts from emails e join send_jobs j on j.email_id=e.id and j.tenant_id=e.tenant_id where e.tenant_id=$1 and e.id=$2", [u.tenant, scheduled.id]);
  u.check(cancelled.length === 1 && cancelled[0].status === "cancelled" && cancelled[0].state === "cancelled" && cancelled[0].attempts === 0 && cancelled[0].provider_message_id === null, "Cancelled scheduled email must remain unsent");
  await writeFile(join(u.dir, "send.json"), JSON.stringify({ email, scheduled: scheduled.id, attachment: attachment.id, event: events[0].id, downloadSha256: createHash("sha256").update(downloaded).digest("hex"), webhookVerified: true, tamperRejected: rejected }, null, 2), { mode: 0o600 });
}
