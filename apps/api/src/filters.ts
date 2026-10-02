import { ApiError } from "@dispatchmail/core";

// Builds a `where` fragment for paginate(). Its parameters start at $2, after the tenant.
function builder(start = 2) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length + start - 1}`;
  };
  return {
    clauses,
    bind,
    like: (text: string) => bind(`%${text.replace(/[\\%_]/g, "\\$&")}%`),
    done: () => ({ where: clauses.length > 0 ? clauses.join(" and ") : undefined, params }),
  };
}

function date(value: string, name: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ApiError("validation_error", 400, `${name} must be a date`);
  return parsed.toISOString();
}

// The end of a range. A bare date such as 2026-10-02 means through the end of that day.
function until(column: string, value: string, name: string, bind: (value: unknown) => string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const next = new Date(`${value.trim()}T00:00:00.000Z`);
    if (Number.isNaN(next.getTime())) throw new ApiError("validation_error", 400, `${name} must be a date`);
    next.setUTCDate(next.getUTCDate() + 1);
    return `${column} < ${bind(next.toISOString())}`;
  }
  return `${column} <= ${bind(date(value, name))}`;
}

function flag(value: string, name: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApiError("validation_error", 400, `${name} must be true or false`);
}

export type TemplateQuery = { q?: string; status?: string };

export function templateWhere(query: TemplateQuery) {
  const filter = builder();
  const q = query.q?.trim();
  if (q) {
    const pattern = filter.like(q);
    filter.clauses.push(`(t.name ilike ${pattern} or t.alias ilike ${pattern})`);
  }
  if (query.status === "draft") filter.clauses.push("t.published_version_id is null");
  else if (query.status === "published") filter.clauses.push("t.published_version_id is not null");
  else if (query.status) throw new ApiError("validation_error", 400, "status must be draft or published");
  return filter.done();
}

// The stored states behind each status the API shows.
const broadcastStates: Record<string, string[]> = {
  draft: ["draft"],
  scheduled: ["scheduled"],
  queued: ["sending", "paused"],
  sent: ["sent"],
  canceled: ["cancelled"],
};

export type BroadcastQuery = { status?: string; segment_id?: string; q?: string };

export function broadcastWhere(query: BroadcastQuery) {
  const filter = builder();
  if (query.status) {
    const states = query.status.split(",").flatMap((status) => {
      const stored = Object.hasOwn(broadcastStates, status.trim()) ? broadcastStates[status.trim()] : undefined;
      if (!stored) throw new ApiError("validation_error", 400, `status must be one of ${Object.keys(broadcastStates).join(", ")}`);
      return stored;
    });
    filter.clauses.push(`status = any(${filter.bind(states)}::text[])`);
  }
  if (query.segment_id) filter.clauses.push(`segment_id = ${filter.bind(query.segment_id)}`);
  const q = query.q?.trim();
  if (q) {
    const pattern = filter.like(q);
    filter.clauses.push(`(name ilike ${pattern} or subject ilike ${pattern})`);
  }
  return filter.done();
}

export type ContactQuery = { q?: string; subscribed?: string; segment_id?: string };

export function contactWhere(query: ContactQuery) {
  const filter = builder();
  if (query.segment_id) {
    filter.clauses.push(
      `exists (select 1 from segment_contacts sc where sc.tenant_id = contacts.tenant_id and sc.contact_id = contacts.id and sc.segment_id = ${filter.bind(query.segment_id)})`,
    );
  }
  const q = query.q?.trim();
  if (q) {
    const pattern = filter.like(q);
    filter.clauses.push(`(email ilike ${pattern} or first_name ilike ${pattern} or last_name ilike ${pattern})`);
  }
  if (query.subscribed) {
    filter.clauses.push(flag(query.subscribed, "subscribed") ? "unsubscribed_at is null" : "unsubscribed_at is not null");
  }
  return filter.done();
}

export type DomainQuery = { q?: string; status?: string; region?: string };

export function domainWhere(query: DomainQuery) {
  const filter = builder();
  const q = query.q?.trim();
  if (q) filter.clauses.push(`name ilike ${filter.like(q)}`);
  if (query.status) filter.clauses.push(`status = any(${filter.bind(query.status.split(",").map((value) => value.trim()))}::text[])`);
  if (query.region) filter.clauses.push(`region = ${filter.bind(query.region)}`);
  return filter.done();
}

export type ReceivedQuery = { q?: string; from?: string; to?: string };

// Received emails are listed from `received_emails m`.
export function receivedWhere(query: ReceivedQuery) {
  const filter = builder();
  const q = query.q?.trim();
  if (q) {
    const pattern = filter.like(q);
    filter.clauses.push(
      `(m.subject ilike ${pattern} or m.from_email ilike ${pattern} or exists (select 1 from received_recipients r where r.received_email_id = m.id and r.email ilike ${pattern}))`,
    );
  }
  if (query.from) filter.clauses.push(`m.created_at >= ${filter.bind(date(query.from, "from"))}`);
  if (query.to) filter.clauses.push(until("m.created_at", query.to, "to", filter.bind));
  return filter.done();
}

export type SuppressionQuery = { origin?: string; q?: string; from?: string; to?: string };

export function suppressionWhere(query: SuppressionQuery) {
  const filter = builder();
  filter.clauses.push("removed_at is null");
  if (query.origin) filter.clauses.push(`origin = ${filter.bind(query.origin)}`);
  const q = query.q?.trim();
  if (q) filter.clauses.push(`email ilike ${filter.like(q)}`);
  if (query.from) filter.clauses.push(`created_at >= ${filter.bind(date(query.from, "from"))}`);
  if (query.to) filter.clauses.push(until("created_at", query.to, "to", filter.bind));
  return filter.done();
}

export type RunQuery = { start_date?: string; end_date?: string };

// Runs of one automation. $2 is the automation id, and $3 the states when the caller filters by status.
export function runWhere(states: string[] | null, query: RunQuery) {
  const filter = builder(states ? 4 : 3);
  filter.clauses.push("r.automation_id = $2");
  if (states) filter.clauses.push("r.state = any($3)");
  if (query.start_date) filter.clauses.push(`r.created_at >= ${filter.bind(date(query.start_date, "start_date"))}`);
  if (query.end_date) filter.clauses.push(until("r.created_at", query.end_date, "end_date", filter.bind));
  const built = filter.done();
  return { where: built.where!, params: built.params };
}
