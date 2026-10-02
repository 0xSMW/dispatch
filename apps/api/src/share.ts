import { ApiError, durationSeconds, seal, unseal } from "@dispatchmail/core";
import type { Queryable } from "@dispatchmail/db";

export const shareMaxSeconds = 48 * 60 * 60;

export type SharePayload = {
  use?: string;
  tenant_id?: string;
  email_id?: string;
  kind?: string;
  exp?: number;
};

export function shareExpiry(expiresIn: string | undefined, now = Date.now()) {
  const seconds = expiresIn ? durationSeconds(expiresIn) : shareMaxSeconds;
  if (seconds < 1 || seconds > shareMaxSeconds) {
    throw new ApiError("validation_error", 422, "expires_in must be at most 48 hours");
  }
  return Math.floor(now / 1000) + seconds;
}

export function shareToken(
  input: { tenantId: string; emailId: string; kind: "sent" | "received"; exp: number },
  secret: string,
) {
  return seal(
    { use: "share", tenant_id: input.tenantId, email_id: input.emailId, kind: input.kind, exp: input.exp },
    secret,
  );
}

export function readShareToken(token: string, secret: string) {
  const payload = unseal<SharePayload>(token, secret);
  if (!payload || payload.use !== "share" || !payload.tenant_id || !payload.email_id) return null;
  if (payload.kind !== "sent" && payload.kind !== "received") return null;
  return payload as SharePayload & { tenant_id: string; email_id: string; kind: "sent" | "received" };
}

export async function loadSharedEmail(db: Queryable, payload: { tenant_id: string; email_id: string; kind: "sent" | "received" }) {
  const sent = payload.kind === "sent";
  const result = await db.query<ShareRow>(
    sent
      ? `select e.subject, e.from_email, e.from_name, e.created_at, e.html, e.text,
           coalesce(json_agg(r.email order by r.created_at) filter (where r.kind = 'to'), '[]') as recipients
         from emails e
         left join email_recipients r on r.email_id = e.id
         where e.tenant_id = $1 and e.id = $2
         group by e.id`
      : `select m.subject, m.from_email, null as from_name, m.created_at, m.html, m.text,
           coalesce(json_agg(r.email order by r.created_at) filter (where r.kind = 'to'), '[]') as recipients
         from received_emails m
         left join received_recipients r on r.received_email_id = m.id
         where m.tenant_id = $1 and m.id = $2
         group by m.id`,
    [payload.tenant_id, payload.email_id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    subject: row.subject,
    from: row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email,
    to: asList(row.recipients),
    created_at: row.created_at,
    html: row.html ?? null,
    text: row.text ?? null,
  };
}

type ShareRow = {
  subject: string;
  from_email: string;
  from_name?: string | null;
  created_at: string | Date;
  html?: string | null;
  text?: string | null;
  recipients?: unknown;
};

function asList(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
