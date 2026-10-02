// Test helpers for the template and broadcast pages. The editors call `useBlocker`, which needs a
// data router, so pages render inside `createMemoryRouter` instead of the shared `wrapper`.
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, type Reply } from "../../testing";

export type Router = ReturnType<typeof createMemoryRouter>;

/** Renders `routes` at `path` inside a signed-in session. Call `signIn()` first. */
export function renderAt(path: string, routes: Array<{ path: string; element: ReactElement }>): Router {
  const router = createMemoryRouter(
    [
      {
        element: h(SessionProvider, null, h(Outlet)),
        children: [...routes, { path: "*", element: h("p", null, "Elsewhere") }],
      },
    ],
    { initialEntries: [path] },
  );
  render(h(RouterProvider, { router }));
  return router;
}

export type Handler = unknown | ((url: URL, init: RequestInit) => Reply);

/**
 * Mocks `fetch` from a table keyed by "METHOD /path", such as "GET /templates/tpl_1".
 * A function value gets the URL and init and returns `{ status?, body }`. Anything else is the body.
 */
export function api(table: Record<string, Handler>) {
  return mockFetch((url, init) => {
    const parsed = new URL(url);
    const key = `${(init.method ?? "GET").toUpperCase()} ${parsed.pathname}`;
    if (!(key in table)) return { status: 404, body: { name: "not_found", statusCode: 404, message: `No mock for ${key}` } };
    const value = table[key];
    return typeof value === "function" ? (value as (url: URL, init: RequestInit) => Reply)(parsed, init) : { body: value };
  });
}

/** Every call to "METHOD /path", with its parsed URL and JSON body. */
export function calls(fetch: ReturnType<typeof mockFetch>, key: string): Array<{ url: URL; body: unknown }> {
  return fetch.mock.calls
    .map((call) => ({ url: new URL(String(call[0])), init: (call[1] ?? {}) as RequestInit }))
    .filter(({ url, init }) => `${(init.method ?? "GET").toUpperCase()} ${url.pathname}` === key)
    .map(({ url, init }) => ({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined }));
}

export const list = (data: unknown[], has_more = false) => ({ object: "list", has_more, data });
