import { ApiError, seal, unseal } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { setContactTopics, subscriptionStored, subscriptionWire } from "./audience.js";
import { appendEvent } from "./events.js";

export type UnsubscribePayload = {
  use: "unsub";
  tenant_id: string;
  contact_id: string;
  broadcast_id: string | null;
};

// No expiry: an unsubscribe link in a year-old email must still work.
export function unsubscribeToken(
  input: { tenant_id: string; contact_id: string; broadcast_id?: string | null },
  secret: string,
) {
  return seal(
    { use: "unsub", tenant_id: input.tenant_id, contact_id: input.contact_id, broadcast_id: input.broadcast_id ?? null },
    secret,
  );
}

export function readUnsubscribeToken(token: string, secret: string): UnsubscribePayload | null {
  const payload = unseal<Partial<UnsubscribePayload> & { exp?: number }>(token, secret);
  if (!payload || payload.use !== "unsub") return null;
  if (typeof payload.tenant_id !== "string" || typeof payload.contact_id !== "string") return null;
  return {
    use: "unsub",
    tenant_id: payload.tenant_id,
    contact_id: payload.contact_id,
    broadcast_id: typeof payload.broadcast_id === "string" ? payload.broadcast_id : null,
  };
}

// page: the preference page in the dashboard. oneClick: the API route mail clients POST to (RFC 8058).
export function unsubscribeLinks(token: string, urls: { appUrl: string; publicUrl: string }) {
  const encoded = encodeURIComponent(token);
  return {
    page: `${urls.appUrl.replace(/\/$/, "")}/unsubscribe?token=${encoded}`,
    oneClick: `${urls.publicUrl.replace(/\/$/, "")}/unsubscribe/${encoded}`,
  };
}

export function unsubscribeHeaders(oneClickUrl: string) {
  return {
    "List-Unsubscribe": `<${oneClickUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// RFC 8058 one-click: mail providers post `List-Unsubscribe=One-Click`, urlencoded or as
// multipart/form-data. A multipart body arrives here as its raw text.
export function oneClick(body: unknown) {
  if (typeof body === "string") {
    if (/name="?List-Unsubscribe"?[\s\S]{0,200}?One-Click/i.test(body)) return true;
    return new URLSearchParams(body).get("List-Unsubscribe") === "One-Click";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (body as Record<string, unknown>)["List-Unsubscribe"] === "One-Click";
}

type PreferenceTopic = {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  status: string;
};

// Public topics, plus private topics the contact currently receives.
export async function visibleTopics(db: Queryable, tenantId: string, contactId: string) {
  const rows = await db.query<PreferenceTopic>(
    `select t.id, t.name, t.description, t.visibility, coalesce(s.status, t.default_status) as status
     from topics t
     left join topic_subscriptions s on s.tenant_id = t.tenant_id and s.topic_id = t.id and s.contact_id = $2
     where t.tenant_id = $1 and t.deleted_at is null
       and (t.visibility = 'public' or coalesce(s.status, t.default_status) = 'subscribed')
     order by t.name, t.id`,
    [tenantId, contactId],
  );
  return rows.rows;
}

export async function unsubscribeContact(db: Queryable, tenantId: string, contactId: string) {
  const row = await db.query<{ id: string; email: string; unsubscribed_at: string | Date | null }>(
    `select id, email, unsubscribed_at from contacts where tenant_id = $1 and id = $2 and deleted_at is null`,
    [tenantId, contactId],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Unsubscribe link not found");
  return row.rows[0];
}

export async function preferences(db: Queryable, payload: UnsubscribePayload) {
  const contact = await unsubscribeContact(db, payload.tenant_id, payload.contact_id);
  const topics = await visibleTopics(db, payload.tenant_id, contact.id);
  return {
    object: "unsubscribe" as const,
    email: contact.email,
    unsubscribed: Boolean(contact.unsubscribed_at),
    topics: topics.map((topic) => ({
      id: topic.id,
      name: topic.name,
      description: topic.description ?? null,
      subscription: subscriptionWire(topic.status),
    })),
  };
}

export type UnsubscribeAction =
  | { kind: "topics"; topics: Array<{ id: string; subscription: string }> }
  | { kind: "all" }
  | { kind: "one_click" };

// Applies a preference change and returns the webhook event type it should emit.
export async function applyUnsubscribe(db: Queryable, payload: UnsubscribePayload, action: UnsubscribeAction) {
  const contact = await unsubscribeContact(db, payload.tenant_id, payload.contact_id);
  let next = action;
  let broadcastTopic: string | null = null;
  if (payload.broadcast_id) {
    // A topic that has since been deleted counts as no topic, so a one-click from an old email
    // still succeeds and unsubscribes the contact.
    const broadcast = await db.query<{ topic_id: string | null }>(
      `select t.id as topic_id from broadcasts b
       left join topics t on t.tenant_id = b.tenant_id and t.id = b.topic_id and t.deleted_at is null
       where b.tenant_id = $1 and b.id = $2`,
      [payload.tenant_id, payload.broadcast_id],
    );
    broadcastTopic = broadcast.rows[0]?.topic_id ?? null;
  }
  if (next.kind === "one_click") {
    next = broadcastTopic ? { kind: "topics", topics: [{ id: broadcastTopic, subscription: "opt_out" }] } : { kind: "all" };
  }

  let type: "contact.updated" | "contact.topics.updated";
  let leftBroadcast: boolean;
  if (next.kind === "all") {
    await db.query(
      `update contacts set unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
       where tenant_id = $1 and id = $2 and deleted_at is null`,
      [payload.tenant_id, contact.id],
    );
    type = "contact.updated";
    leftBroadcast = true;
  } else {
    const allowed = new Set((await visibleTopics(db, payload.tenant_id, contact.id)).map((topic) => topic.id));
    if (broadcastTopic) allowed.add(broadcastTopic);
    for (const topic of next.topics) {
      if (!allowed.has(topic.id)) throw new ApiError("not_found", 404, "Topic not found");
    }
    await setContactTopics(db, payload.tenant_id, contact.id, next.topics);
    type = "contact.topics.updated";
    leftBroadcast = next.topics.some(
      (topic) => topic.id === broadcastTopic && subscriptionStored(topic.subscription) === "unsubscribed",
    );
  }

  if (leftBroadcast && payload.broadcast_id) {
    const left = await db.query<{ email_id: string | null }>(
      `update broadcast_recipients set unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
       where tenant_id = $1 and broadcast_id = $2 and contact_id = $3
       returning email_id`,
      [payload.tenant_id, payload.broadcast_id, contact.id],
    );
    // Recorded once on the email, which is what the unsubscribed metric and rate count.
    const emailId = left.rows[0]?.email_id;
    if (emailId) {
      await appendEvent(db, {
        tenantId: payload.tenant_id,
        requestId: `unsub_${contact.id}`,
        emailId,
        type: "email.unsubscribed",
        providerEventId: `${emailId}:unsubscribed`,
        data: { email: contact.email, broadcast_id: payload.broadcast_id },
      });
    }
  }
  return { type, contact: { id: contact.id, email: contact.email } };
}
