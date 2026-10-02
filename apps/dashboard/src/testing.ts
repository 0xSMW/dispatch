// Helpers for component tests. Tests are `.test.ts` (the root vitest config only includes
// `*.test.ts`), so they build elements with `h` instead of JSX.
import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { SessionProvider, sessionKey } from "./shell/session";

export const h = createElement;

export const apiUrl = "http://localhost:3100";

/** Stores a session so `SessionProvider` starts signed in. Pass `["read"]` to sign in as a viewer. */
export function signIn(token = "sess_test", permissions = ["full"]) {
  sessionStorage.setItem(sessionKey, JSON.stringify({ apiUrl, token, id: "sess_1", user: { email: "ada@example.com", permissions } }));
}

export type Reply = { status?: number; body: unknown };

/** Replaces `fetch` with a mock that answers each call from `reply(url, init)`. */
export function mockFetch(reply: (url: string, init: RequestInit) => Reply | Promise<Reply>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const { status = 200, body } = await reply(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The URL and init of one recorded `fetch` call; `index` -1 is the last call. */
export function callAt(fetch: ReturnType<typeof mockFetch>, index = 0): { url: string; init: RequestInit } {
  const call = fetch.mock.calls.at(index);
  if (!call) throw new Error(`fetch was not called ${index}`);
  return { url: String(call[0]), init: call[1] ?? {} };
}

/** Wraps children in a signed-in session and a memory router. */
export function wrapper({ children }: { children: ReactNode }) {
  return h(MemoryRouter, null, h(SessionProvider, null, children));
}
