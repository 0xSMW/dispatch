import { assertPublicWebhookTarget, linkCheckSchema, publicFetch } from "@dispatchmail/core";
import type { FastifyInstance } from "fastify";

export type LinkResult = {
  object: "link";
  url: string;
  ok: boolean;
  status: number | null;
  message: string;
};

export type LinkCheckOptions = {
  fetch?: typeof fetch;
  guard?: (host: string) => Promise<void>;
  timeoutMs?: number;
  maxRedirects?: number;
  concurrency?: number;
};

const statusText: Record<number, string> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not found",
  410: "gone",
  429: "too many requests",
  500: "server error",
  502: "bad gateway",
  503: "service unavailable",
};

export function registerLinks(app: FastifyInstance, options: LinkCheckOptions = {}) {
  app.post("/links/check", async (request) => {
    const input = linkCheckSchema.parse(request.body);
    return { object: "list", has_more: false, data: await checkLinks(input.urls, options) };
  });
}

export async function checkLinks(urls: string[], options: LinkCheckOptions = {}) {
  const unique = [...new Set(urls)];
  const results = new Map<string, LinkResult>();
  const queue = [...unique];
  const workers = Array.from({ length: Math.min(options.concurrency ?? 8, queue.length) }, async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      results.set(url, await checkLink(url, options));
    }
  });
  await Promise.all(workers);
  return urls.map((url) => results.get(url)!);
}

// HEAD each URL, following redirects by hand so every hop goes through the SSRF guard.
export async function checkLink(value: string, options: LinkCheckOptions = {}): Promise<LinkResult> {
  // publicFetch refuses a private address at the moment it connects, so a host cannot pass the
  // guard and then be re-pointed.
  const fetchImpl = options.fetch ?? (publicFetch as typeof fetch);
  const guard = options.guard ?? assertPublicWebhookTarget;
  const result = (ok: boolean, status: number | null, message: string): LinkResult => ({ object: "link", url: value, ok, status, message });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return result(false, null, "not a valid URL");
  }
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop += 1) {
    if (!["http:", "https:"].includes(url.protocol)) return result(false, null, "only http and https links can be checked");
    try {
      await guard(url.hostname);
    } catch {
      return result(false, null, "host is not allowed");
    }
    let response: Response;
    try {
      response = await request(fetchImpl, url, "HEAD", options.timeoutMs ?? 5_000);
      if (response.status === 405 || response.status === 501) {
        response = await request(fetchImpl, url, "GET", options.timeoutMs ?? 5_000);
      }
    } catch {
      return result(false, null, "could not be reached");
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    if (response.ok) return result(true, response.status, "ok");
    return result(false, response.status, `${response.status} ${statusText[response.status] ?? "error"}`);
  }
  return result(false, null, "too many redirects");
}

async function request(fetchImpl: typeof fetch, url: URL, method: "HEAD" | "GET", timeoutMs: number) {
  const response = await fetchImpl(url, {
    method,
    redirect: "manual",
    headers: { "user-agent": "Dispatch link check" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (method === "GET") await response.body?.cancel().catch(() => undefined);
  return response;
}
