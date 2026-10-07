export type Query = Record<string, string | number | boolean | null | undefined>;

export type Client = {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, options?: { idempotencyKey?: string }): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
  upload<T = unknown>(path: string, form: FormData | Record<string, string | Blob>): Promise<T>;
};

export type ClientOptions = {
  apiUrl: string;
  token?: string | null;
  onUnauthorized?: () => void;
};

/** One schema failure: `path` points into the request body, such as "steps.2.config.template". */
export type Issue = { path: string; message: string };

/**
 * The error every client call throws. Mirrors the API body `{ name, statusCode, message }`.
 * A 400 from a schema failure also carries every `issue`, so a form can put each on its field.
 */
export class ApiError extends Error {
  statusCode: number;
  requestId?: string;
  issues: Issue[];

  constructor(name: string, statusCode: number, message: string, requestId?: string, issues: Issue[] = []) {
    super(message);
    this.name = name;
    this.statusCode = statusCode;
    this.requestId = requestId;
    this.issues = issues;
  }
}

function readIssues(value: unknown): Issue[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { path?: unknown; message?: unknown } => Boolean(item) && typeof item === "object")
    .map((item) => ({ path: typeof item.path === "string" ? item.path : "", message: typeof item.message === "string" ? item.message : "Invalid value" }));
}

// The public unsubscribe and shared pages have no session to tell them where the API is. A build
// without VITE_API_URL used to send them to localhost, so every recipient saw "Could not reach the
// API". A production build now falls back to the page's own origin, which is right when one host
// serves both. With the API on another host, VITE_API_URL has to be set at build time.
export function defaultApiUrl(): string {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  return import.meta.env.PROD ? window.location.origin : "http://localhost:3100";
}

// The API a key may be sent to. A URL typed into the sign-in form has to be local, this origin,
// or the API the operator built the dashboard for (VITE_API_URL). That last one is what lets the
// public unsubscribe and shared pages reach an API on another host with no session to carry a URL.
export function apiBase(value: string): string {
  const url = new URL(value, window.location.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const sameOrigin = url.origin === window.location.origin;
  const configured = import.meta.env.VITE_API_URL
    ? new URL(import.meta.env.VITE_API_URL, window.location.origin).origin
    : null;
  const trusted = local || sameOrigin || url.origin === configured || import.meta.env.VITE_ALLOW_REMOTE_API === "true";
  if (!["http:", "https:"].includes(url.protocol) || !trusted) {
    throw new ApiError("invalid_api_url", 0, "API URL is not allowed");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  if (!text) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${text}`;
}

export function makeClient({ apiUrl, token, onUnauthorized }: ClientOptions): Client {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (typeof init.body === "string") headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await fetch(`${apiBase(apiUrl)}${path}`, { ...init, headers });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("network_error", 0, "Could not reach the API");
    }

    const json = (await response.json().catch(() => null)) as
      | { name?: string; message?: string; request_id?: string; issues?: unknown }
      | null;
    if (!response.ok) {
      if (response.status === 401 && token) onUnauthorized?.();
      throw new ApiError(
        json?.name ?? "application_error",
        response.status,
        json?.message ?? (response.statusText || "Request failed"),
        json?.request_id,
        readIssues(json?.issues),
      );
    }
    return json as T;
  }

  const json = (body: unknown) => (body === undefined ? undefined : JSON.stringify(body));

  return {
    get: (path, query) => request(withQuery(path, query)),
    post: (path, body = {}, options = {}) => request(path, { method: "POST", body: json(body),
      headers: options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : undefined }),
    patch: (path, body = {}) => request(path, { method: "PATCH", body: json(body) }),
    delete: (path) => request(path, { method: "DELETE" }),
    upload: (path, form) => {
      let body = form;
      if (!(form instanceof FormData)) {
        body = new FormData();
        for (const [key, value] of Object.entries(form)) body.append(key, value);
      }
      return request(path, { method: "POST", body: body as FormData });
    },
  };
}

/** A client with no credentials, for the public pages and the session exchange. */
export function publicClient(apiUrl = defaultApiUrl()): Client {
  return makeClient({ apiUrl });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
