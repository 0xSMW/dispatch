import { ApiError } from "@dispatchmail/core";

export const secretFields = new Set([
  "secret",
  "token",
  "signing_secret",
  "api_key",
  "password",
  "current_password",
  "access_token",
  "refresh_token",
]);

// Any key that names a secret, in any case: a client may send `new_password` or `Password`, and
// the route drops unknown keys without failing, so the body would keep it in plain text.
const secretName = /pass|secret|token|api_?key|restricted_key|authorization/i;

// Also hidden from a read-only user: share links and signed file URLs grant access on their own
// and outlive the session that reads them.
export const linkFields = new Set(["url", "download_url", "raw"]);

// Unsubscribe, click, open, file, and share links carry a token that acts without a session.
const tokenLink = /https?:\/\/[^\s"'<>()]+\/(?:unsubscribe|confirm|inbound|click|open|files|shared)(?:[/?][^\s"'<>()]*)?/gi;

/**
 * A URL cut to its scheme and host, for a read-only user. The path or the user part of a webhook
 * URL can hold a credential, as Slack's do.
 */
export function hostOnly(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/${parsed.pathname === "/" && !parsed.search ? "" : "…"}`;
  } catch {
    return "#link-hidden";
  }
}

/** Text with every token link replaced, for a read-only user. */
export function hideLinks<T extends string | null | undefined>(text: T): T {
  return (typeof text === "string" ? text.replace(tokenLink, "#link-hidden") : text) as T;
}

export const logBodyLimit = 64 * 1024;

export type LogQuery = {
  q?: string;
  email_id?: string;
  path?: string;
  status?: string;
  user_agent?: string;
  api_key_id?: string;
  start_date?: string;
  end_date?: string;
};

export type StoredLog = {
  id: string;
  created_at: string | Date;
  path: string;
  method: string;
  status: number;
  user_agent?: string | null;
  request_body?: unknown;
  response_body?: unknown;
};

export function redact(value: unknown, fields = secretFields): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, fields));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (fields.has(key) || (fields === secretFields && secretName.test(key))) return [key, "[redacted]"];
      if (key === "content" && typeof child === "string" && child.length > 256) {
        return [key, `[${child.length} bytes]`];
      }
      return [key, redact(child, fields)];
    }),
  );
}

function hideAll(value: unknown): unknown {
  if (typeof value === "string") return hideLinks(value);
  if (Array.isArray(value)) return value.map(hideAll);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, hideAll(child)]));
}

export function responseText(payload: unknown) {
  return typeof payload === "string" && payload.length <= logBodyLimit ? payload : null;
}

export function logBodies(input: {
  method: string;
  route?: string;
  body: unknown;
  responseText: string | null;
}) {
  if (input.route === "/inbound/:token" || input.route?.startsWith("/integrations")
    || input.route === "/confirm/:token" || (input.route === "/forms/:id" && input.method === "POST"))
    return { request_body: null, response_body: null };
  const response = parseJson(input.responseText);
  if (skipBodies(input.method, input.route, response)) {
    return { request_body: null, response_body: null };
  }
  return {
    request_body: bounded(redact(input.body)),
    response_body: bounded(response === undefined ? null : redact(response)),
  };
}

export function jsonbParams(values: unknown[]) {
  return values.map((value) => JSON.stringify(value ?? null));
}

export function logWhere(query: LogQuery) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (clause: string, value: unknown) => {
    params.push(value);
    clauses.push(clause.replaceAll("?", `$${params.length + 1}`));
  };
  if (query.path) bind(`path like '%' || ? || '%'`, query.path);
  // One box in the dashboard: a log ID, a request ID, or part of the path.
  if (query.q) bind(`(id = ? or request_id = ? or path like '%' || ? || '%')`, query.q);
  // The calls that created or changed one email: its own request, and any call whose path names it.
  if (query.email_id) {
    bind(
      `(request_id = (select request_id from emails where tenant_id = $1 and id = ?) or path like '%/emails/' || ? || '%')`,
      query.email_id,
    );
  }
  if (query.user_agent) bind(`user_agent like '%' || ? || '%'`, query.user_agent);
  if (query.api_key_id) bind(`api_key_id = ?`, query.api_key_id);
  if (query.status) bindStatus(query.status, bind);
  if (query.start_date) bind(`created_at >= ?`, timestamp(query.start_date, "start_date"));
  if (query.end_date) bind(`created_at <= ?`, timestamp(query.end_date, "end_date"));
  return {
    where: clauses.length > 0 ? clauses.join(" and ") : undefined,
    params,
  };
}

export function presentLog(row: StoredLog, detail = false, readOnly = false) {
  const log = {
    object: "log" as const,
    id: row.id,
    created_at: row.created_at,
    endpoint: row.path,
    method: row.method,
    response_status: row.status,
    user_agent: row.user_agent ?? null,
  };
  if (!detail) return log;
  const shown = (body: unknown) => (readOnly ? hideAll(redact(body ?? null, linkFields)) : (body ?? null));
  return {
    ...log,
    request_body: shown(row.request_body),
    response_body: shown(row.response_body),
  };
}

function skipBodies(method: string, route: string | undefined, response: unknown) {
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") return false;
  if (!route?.includes(":")) return true;
  return Boolean(
    response &&
      typeof response === "object" &&
      (response as { object?: string }).object === "list",
  );
}

function parseJson(text: string | null) {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function bounded(value: unknown) {
  if (value == null) return null;
  if (JSON.stringify(value).length > logBodyLimit) return null;
  return value;
}

function bindStatus(
  status: string,
  bind: (clause: string, value: unknown) => void,
) {
  const klass = status.match(/^([1-5])xx$/i);
  if (klass) {
    bind(`status >= ? and status < ? + 100`, Number(klass[1]) * 100);
    return;
  }
  if (/^\d{3}$/.test(status)) {
    bind(`status = ?`, Number(status));
    return;
  }
  throw new ApiError("validation_error", 400, "status must be a code or a class such as 2xx");
}

function timestamp(value: string, name: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError("validation_error", 400, `${name} must be a date`);
  }
  return date.toISOString();
}
