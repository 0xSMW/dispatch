// Test helpers for the audience, settings, setup, and timeline page tests. Not imported by any page.
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn } from "../../testing";

/** A non-200 answer from a stubbed route. */
export class Status {
  constructor(
    public status: number,
    public body: unknown,
  ) {}
}

export type Handler = unknown | ((url: URL, init: RequestInit) => unknown);

/**
 * Stubs `fetch` with routes keyed by "METHOD /path", such as "GET /contacts".
 * A handler is a body, or a function of the URL and init that returns one (or a `Status`).
 * Unknown routes answer 404.
 */
export function stubApi(routes: Record<string, Handler>) {
  return mockFetch((raw, init) => {
    const url = new URL(raw);
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    if (!(key in routes)) return { status: 404, body: { name: "not_found", message: `No stub for ${key}` } };
    const handler = routes[key];
    const result = typeof handler === "function" ? (handler as (url: URL, init: RequestInit) => unknown)(url, init) : handler;
    return result instanceof Status ? { status: result.status, body: result.body } : { body: result };
  });
}

/** Renders `element` at `path`, matched by `route`, inside a signed-in session. */
export function show(element: ReactElement, path = "/", route = "*"): void {
  signIn();
  render(h(MemoryRouter, { initialEntries: [path] }, h(SessionProvider, null, h(Routes, null, h(Route, { path: route, element })))));
}

/** The calls `fetch` received, as "METHOD /path?query". */
export function calls(fetch: ReturnType<typeof mockFetch>): string[] {
  return fetch.mock.calls.map(([input, init]) => {
    const url = new URL(String(input));
    return `${(init as RequestInit | undefined)?.method ?? "GET"} ${url.pathname}${url.search}`;
  });
}

/** The parsed JSON body of the last call matching "METHOD /path". */
export function bodyOf(fetch: ReturnType<typeof mockFetch>, key: string): unknown {
  const call = [...fetch.mock.calls].reverse().find(([input, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${new URL(String(input)).pathname}` === key);
  if (!call) throw new Error(`No call to ${key}`);
  const body = (call[1] as RequestInit).body;
  return typeof body === "string" ? JSON.parse(body) : body;
}

export const list = <T>(data: T[], has_more = false) => ({ object: "list", has_more, data });
