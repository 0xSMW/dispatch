// Test helper for the operations pages: renders one page at a URL inside a signed-in session and a
// memory router, so `useParams` and `useSearchParams` work. Any other path renders a "location"
// marker, which lets a test assert where a page navigated.
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, type Reply } from "../../testing";

function Location() {
  const location = useLocation();
  return h("p", { "data-testid": "location" }, `${location.pathname}${location.search}`);
}

/** Renders `element` for `route` (such as "/emails/:id") at `url` (such as "/emails/email_1"). */
export function visit(element: ReactElement, url: string, route = url.split("?")[0]): RenderResult {
  return render(
    h(
      MemoryRouter,
      { initialEntries: [url] },
      h(SessionProvider, null, h(Routes, null, h(Route, { path: route, element }), h(Route, { path: "*", element: h(Location) }))),
    ),
  );
}

/** A list envelope. */
export function list<T>(data: T[], hasMore = false) {
  return { object: "list", has_more: hasMore, data };
}

type Handler = unknown | ((url: URL, init: RequestInit) => Reply);

/**
 * Mocks `fetch` from a table keyed by "METHOD /path" (the query is ignored). A bare "/path" means GET.
 * A function value gets the URL and init and returns `{ status?, body }`. Unknown paths answer 404.
 */
export function api(table: Record<string, Handler>) {
  return mockFetch((raw, init) => {
    const url = new URL(raw);
    const method = (init.method ?? "GET").toUpperCase();
    const hit = table[`${method} ${url.pathname}`] ?? (method === "GET" ? table[url.pathname] : undefined);
    if (hit === undefined) return { status: 404, body: { name: "not_found", statusCode: 404, message: `No mock for ${method} ${url.pathname}` } };
    return typeof hit === "function" ? (hit as (url: URL, init: RequestInit) => Reply)(url, init) : { body: hit };
  });
}

/** The recorded calls to one method and path, with the URL parsed and the JSON body read. */
export function requests(fetch: ReturnType<typeof mockFetch>, method: string, path: string) {
  return fetch.mock.calls
    .map(([input, init]) => ({ url: new URL(String(input)), init: (init ?? {}) as RequestInit }))
    .filter((call) => (call.init.method ?? "GET").toUpperCase() === method && call.url.pathname === path)
    .map((call) => ({ ...call, body: call.init.body ? (JSON.parse(String(call.init.body)) as unknown) : undefined }));
}
