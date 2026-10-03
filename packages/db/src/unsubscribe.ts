import { ApiError, id, seal, unseal } from "@dispatchmail/core";
import type { Queryable } from "./index.js";
import { setContactTopics, subscriptionStored, subscriptionWire } from "./audience.js";
import { appendEvent, fanoutEvent } from "./events.js";

export type UnsubscribePayload = {
  use: "unsub";
  tenant_id: string;
  contact_id: string | null;
  email?: string | null;
  broadcast_id: string | null;
  topic_id?: string | null;
  email_id?: string | null;
};

// No expiry: an unsubscribe link in a year-old email must still work.
export function unsubscribeToken(
  input: { tenant_id: string; contact_id?: string | null; email?: string | null; broadcast_id?: string | null; topic_id?: string | null; email_id?: string | null },
  secret: string,
) {
  if (Boolean(input.contact_id) === Boolean(input.email)) throw new Error("An unsubscribe link needs exactly one recipient");
  return seal({
    use: "unsub", tenant_id: input.tenant_id, contact_id: input.contact_id ?? null,
    email: input.email?.toLowerCase() ?? null, broadcast_id: input.broadcast_id ?? null,
    topic_id: input.topic_id ?? null, email_id: input.email_id ?? null,
  }, secret);
}

export function readUnsubscribeToken(token: string, secret: string): UnsubscribePayload | null {
  const payload = unseal<Partial<UnsubscribePayload> & { exp?: number }>(token, secret);
  if (!payload || payload.use !== "unsub") return null;
  if (typeof payload.tenant_id !== "string" || !payload.tenant_id) return null;
  const contactId = typeof payload.contact_id === "string" && payload.contact_id ? payload.contact_id : null;
  const email = typeof payload.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email) ? payload.email.toLowerCase() : null;
  if (Boolean(contactId) === Boolean(email)) return null;
  return {
    use: "unsub",
    tenant_id: payload.tenant_id,
    contact_id: contactId,
    email,
    broadcast_id: typeof payload.broadcast_id === "string" ? payload.broadcast_id : null,
    topic_id: typeof payload.topic_id === "string" ? payload.topic_id : null,
    email_id: typeof payload.email_id === "string" ? payload.email_id : null,
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

export const unsubscribeVariables = ["UNSUBSCRIBE_URL", "RESEND_UNSUBSCRIBE_URL", "DISPATCH_UNSUBSCRIBE_URL"] as const;

export function subscriptionLinks(input: {
  tenantId: string; contactId?: string | null; email?: string | null; broadcastId?: string | null;
  topicId?: string | null; emailId: string; secret?: string; appUrl?: string; publicUrl?: string;
}) {
  if (!input.secret || !input.appUrl || !input.publicUrl) throw new Error("Marketing email needs unsubscribe URLs and a signing secret");
  const token = unsubscribeToken({
    tenant_id: input.tenantId, contact_id: input.contactId,
    email: input.contactId ? null : input.email, broadcast_id: input.broadcastId,
    topic_id: input.topicId, email_id: input.emailId,
  }, input.secret);
  const links = unsubscribeLinks(token, { appUrl: input.appUrl, publicUrl: input.publicUrl });
  return {
    context: Object.fromEntries(unsubscribeVariables.map((key) => [key, links.page])),
    headers: unsubscribeHeaders(links.oneClick),
  };
}

export function replaceUnsubscribe(content: string | null | undefined, context: Record<string, unknown>) {
  return content?.replace(/\{\{\{?\s*(UNSUBSCRIBE_URL|RESEND_UNSUBSCRIBE_URL|DISPATCH_UNSUBSCRIBE_URL)\s*\}\}\}?/g, (placeholder, key: string) =>
    typeof context[key] === "string" ? context[key] as string : placeholder,
  );
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
    `select id, email, unsubscribed_at from contacts where tenant_id = $1 and id = $2`,
    [tenantId, contactId],
  );
  if (!row.rows[0]) throw new ApiError("not_found", 404, "Unsubscribe link not found");
  return row.rows[0];
}

export async function preferences(db: Queryable, payload: UnsubscribePayload) {
  const contact = payload.contact_id
    ? await unsubscribeContact(db, payload.tenant_id, payload.contact_id)
    : (await db.query<{ id: string; email: string; unsubscribed_at: string | Date | null }>(
      "select id, email, unsubscribed_at from contacts where tenant_id = $1 and lower(email) = lower($2) order by deleted_at nulls first limit 1",
      [payload.tenant_id, payload.email],
    )).rows[0] ?? { id: "", email: payload.email!, unsubscribed_at: null };
  const topics = await visibleTopics(db, payload.tenant_id, contact.id);
  const topicId = await unsubscribeTopic(db, payload);
  if (topicId && !topics.some((topic) => topic.id === topicId)) {
    const topic = await db.query<PreferenceTopic>(
      "select id, name, description, visibility, default_status as status from topics where tenant_id = $1 and id = $2 and deleted_at is null",
      [payload.tenant_id, topicId],
    );
    if (topic.rows[0]) topics.push(topic.rows[0]);
  }
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
async function unsubscribeTopic(db: Queryable, payload: UnsubscribePayload): Promise<string | null> {
  if (payload.broadcast_id) {
    // A topic that has since been deleted counts as no topic, so a one-click from an old email
    // still succeeds and unsubscribes the contact.
    const broadcast = await db.query<{ topic_id: string | null }>(
      `select t.id as topic_id from broadcasts b
       left join topics t on t.tenant_id = b.tenant_id and t.id = b.topic_id and t.deleted_at is null
       where b.tenant_id = $1 and b.id = $2`,
      [payload.tenant_id, payload.broadcast_id],
    );
    return broadcast.rows[0]?.topic_id ?? null;
  }
  if (!payload.topic_id) return null;
  const topic = await db.query<{ id: string }>(
    "select id from topics where tenant_id = $1 and id = $2 and deleted_at is null",
    [payload.tenant_id, payload.topic_id],
  );
  return topic.rows[0]?.id ?? null;
}

export async function applyUnsubscribe(db: Queryable, payload: UnsubscribePayload, action: UnsubscribeAction) {
  let next = action;
  const broadcastTopic = await unsubscribeTopic(db, payload);
  if (next.kind === "one_click") {
    next = broadcastTopic ? { kind: "topics", topics: [{ id: broadcastTopic, subscription: "opt_out" }] } : { kind: "all" };
  }

  let contact: { id: string; email: string; unsubscribed_at: string | Date | null };
  if (payload.contact_id) {
    const row = await db.query<typeof contact>(
      "select id, email, unsubscribed_at from contacts where tenant_id = $1 and id = $2 for update",
      [payload.tenant_id, payload.contact_id],
    );
    if (!row.rows[0]) throw new ApiError("not_found", 404, "Unsubscribe link not found");
    contact = row.rows[0];
  } else {
    const read = () => db.query<typeof contact>(
      "select id, email, unsubscribed_at from contacts where tenant_id = $1 and lower(email) = lower($2) order by deleted_at nulls first limit 1 for update",
      [payload.tenant_id, payload.email],
    );
    let row = await read();
    if (!row.rows[0]) {
      await db.query(
        `insert into contacts (id, tenant_id, email, unsubscribed_at)
         values ($1, $2, $3, case when $4::boolean then now() else null end) on conflict do nothing`,
        [id("contact"), payload.tenant_id, payload.email, next.kind === "all"],
      );
      row = await read();
    }
    if (!row.rows[0]) throw new ApiError("not_found", 404, "Unsubscribe link not found");
    contact = row.rows[0];
  }

  let type: "contact.updated" | "contact.topics.updated";
  let leftBroadcast: boolean;
  if (next.kind === "all") {
    await db.query(
      `update contacts set unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
       where tenant_id = $1 and id = $2`,
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
    // Topic writes are ordered: a repeated topic's last preference is the one saved.
    const subscription = new Map(next.topics.map((topic) => [topic.id, topic.subscription])).get(broadcastTopic ?? "");
    leftBroadcast = subscription !== undefined && subscriptionStored(subscription) === "unsubscribed";
  }

  let emailId = payload.email_id ?? null;
  if (leftBroadcast && payload.broadcast_id) {
    const left = await db.query<{ email_id: string | null }>(
      `update broadcast_recipients set unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
       where tenant_id = $1 and broadcast_id = $2 and contact_id = $3
       returning email_id`,
      [payload.tenant_id, payload.broadcast_id, contact.id],
    );
    // Recorded once on the email, which is what the unsubscribed metric and rate count.
    emailId = emailId ?? left.rows[0]?.email_id ?? null;
  }
  if (leftBroadcast && emailId) {
      const event = await appendEvent(db, {
        tenantId: payload.tenant_id,
        requestId: `unsub_${contact.id}`,
        emailId,
        type: "email.unsubscribed",
        providerEventId: `${emailId}:unsubscribed`,
        data: { email: contact.email, broadcast_id: payload.broadcast_id },
      });
      if (event) await fanoutEvent(db, event);
  }
  return { type, contact: { id: contact.id, email: contact.email } };
}
