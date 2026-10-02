import { ApiError } from "@dispatchmail/core";

export type EmailQuery = {
  status?: string;
  from?: string;
  to?: string;
  api_key_id?: string;
  q?: string;
};

// The list shows Resend's last_event names. Map them back to stored statuses.
const statuses: Record<string, string[]> = {
  canceled: ["cancelled"],
  cancelled: ["cancelled"],
  sent: ["sent", "submitted"],
};

// Builds the where fragment for GET /emails. Parameters number from $2, after the tenant.
export function emailWhere(query: EmailQuery) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length + 1}`;
  };
  if (query.status) {
    clauses.push(`e.status = any(${bind(Object.hasOwn(statuses, query.status) ? statuses[query.status] : [query.status])}::text[])`);
  }
  if (query.from) clauses.push(`e.created_at >= ${bind(date(query.from, "from"))}`);
  if (query.to) clauses.push(`e.created_at <= ${bind(date(query.to, "to"))}`);
  if (query.api_key_id) clauses.push(`e.api_key_id = ${bind(query.api_key_id)}`);
  const q = query.q?.trim();
  if (q) {
    const pattern = bind(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
    clauses.push(
      `(e.subject ilike ${pattern} or exists (
        select 1 from email_recipients rq
        where rq.tenant_id = e.tenant_id and rq.email_id = e.id and rq.email ilike ${pattern}
      ))`,
    );
  }
  return { where: clauses.length > 0 ? clauses.join(" and ") : undefined, params };
}

function date(value: string, name: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ApiError("validation_error", 400, `${name} must be a date`);
  return parsed.toISOString();
}
