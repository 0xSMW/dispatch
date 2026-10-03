import { ApiError, brandContext, id } from "@dispatchmail/core";
import {
  claimBroadcast,
  countRecipients,
  failBroadcast,
  finishChunk,
  hasRecipients,
  ingestEmail,
  loadBrand,
  markRecipients,
  queuedRecipients,
  renderBroadcast,
  snapshotBroadcast,
  tx,
  subscriptionLinks,
  type Db,
  type DueBroadcast,
  type Queryable,
  type QueuedRecipient,
  type RecipientResult,
} from "@dispatchmail/db";

// The renderer lives in @dispatchmail/db, where the API also uses it for test sends and for the
// check before a broadcast goes out.
export { recipientContext as contactContext, renderBroadcast, withPreview } from "@dispatchmail/db";

export const chunkSize = 200;

export type BroadcastOptions = {
  publicUrl: string;
  appUrl: string;
  secret: string;
  limit?: number;
  chunk?: number;
  // How many of a broadcast's emails may wait for delivery before it is given more.
  backlog?: number;
  ingest?: typeof ingestEmail;
  onError?: (broadcastId: string | null, error: unknown) => void;
};

class ChunkError extends Error {
  constructor(
    readonly broadcastId: string,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

// One chunk per due broadcast per tick, each in its own transaction that holds the broadcast row.
// A pause or cancel waits for the running chunk, then the next claim skips the broadcast.
export async function sendBroadcasts(db: Db, options: BroadcastOptions) {
  const done: string[] = [];
  let sent = 0;
  for (let index = 0; index < (options.limit ?? 5); index += 1) {
    try {
      const broadcastId = await tx(db, (client) => sendChunk(client, done, options));
      if (!broadcastId) break;
      done.push(broadcastId);
      sent += 1;
    } catch (error) {
      // The chunk rolled back. The failure is counted on the broadcast, which is left out of the
      // rest of this pass so the other broadcasts still move.
      if (!(error instanceof ChunkError)) {
        options.onError?.(null, error);
        break;
      }
      options.onError?.(error.broadcastId, error.cause);
      done.push(error.broadcastId);
      await failBroadcast(db, error.broadcastId, error.message).catch(() => undefined);
    }
  }
  return sent;
}

export async function sendChunk(client: Queryable, exclude: string[], options: BroadcastOptions) {
  const broadcast = await claimBroadcast(client, exclude, options.backlog);
  if (!broadcast) return null;
  try {
    return await sendClaimed(client, broadcast, options);
  } catch (error) {
    throw new ChunkError(broadcast.id, error);
  }
}

async function sendClaimed(client: Queryable, broadcast: DueBroadcast, options: BroadcastOptions) {
  const tenantId = broadcast.tenant_id;

  if (!(await hasRecipients(client, tenantId, broadcast.id))) {
    const count = await snapshotBroadcast(client, tenantId, broadcast.id);
    await countRecipients(client, tenantId, broadcast.id, count);
  }

  const recipients = await queuedRecipients(client, tenantId, broadcast.id, options.chunk ?? chunkSize);
  const brand = await loadBrand(client, tenantId);
  const brandVars = brandContext(brand.brand, { tenantName: brand.name, domain: brand.domain, from: broadcast.from_email });
  const ingest = options.ingest ?? ingestEmail;
  const results: RecipientResult[] = [];

  for (const recipient of recipients) {
    if (recipient.skip) {
      results.push({ id: recipient.id, status: "skipped" });
      continue;
    }
    const emailId = id("email");
    const links = subscriptionLinks({
      tenantId, contactId: recipient.contact_id, broadcastId: broadcast.id,
      topicId: broadcast.topic_id, emailId, ...options,
    });
    try {
      const content = renderBroadcast(broadcast, recipient, brandVars, links.context.UNSUBSCRIBE_URL!);
      const sent = await ingest(client, {
        tenantId,
        requestId: broadcast.request_id ?? `req_${broadcast.id}`,
        emailId,
        contactId: recipient.contact_id,
        from: broadcast.from_email,
        fromName: broadcast.from_name,
        to: recipient.email,
        replyTo: broadcast.reply_to?.length ? broadcast.reply_to : undefined,
        subject: content.subject,
        html: content.html,
        text: content.text,
        headers: links.headers,
        tags: { broadcast_id: broadcast.id },
        topicId: broadcast.topic_id,
        broadcastId: broadcast.id,
        publicUrl: options.publicUrl,
      });
      // An address suppressed, or opted out of the topic, since the snapshot gets no email. It
      // is recorded as skipped, not counted as sent.
      const queued = sent.email.status === "queued" || sent.email.status === "scheduled";
      results.push(
        queued
          ? { id: recipient.id, status: "sent", email_id: sent.email.id }
          : { id: recipient.id, status: "skipped", email_id: sent.email.id, error: sent.email.status === "suppressed" ? "Suppressed" : "Opted out" },
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      results.push({ id: recipient.id, status: "failed", error: error.message });
    }
  }

  await markRecipients(client, tenantId, results);
  await finishChunk(client, tenantId, broadcast.id, results.filter((row) => row.status === "sent").length);
  return broadcast.id;
}

