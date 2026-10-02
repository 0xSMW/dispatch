// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAt, h, mockFetch } from "../testing";
import { exchange, SessionProvider, sessionKey, useCan, useSession } from "./session";

const wrapper = ({ children }: { children: ReactNode }) => h(SessionProvider, null, children);

describe("session", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("exchanges email and password for a token through POST /sessions without a bearer", async () => {
    const fetch = mockFetch(() => ({
      body: { object: "session", id: "sess_1", token: "sess_secret", user: { email: "ada@example.com", name: "Ada", permissions: ["read"] } },
    }));
    const session = await exchange({ apiUrl: "http://localhost:3100/", email: "ada@example.com", password: "correct horse battery" });

    const { url, init } = callAt(fetch);
    expect(url).toBe("http://localhost:3100/sessions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ email: "ada@example.com", password: "correct horse battery" });
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    expect(session).toEqual({
      apiUrl: "http://localhost:3100",
      token: "sess_secret",
      id: "sess_1",
      user: { email: "ada@example.com", name: "Ada", permissions: ["read"] },
    });
  });

  it("also reads the older `{ session: { token } }` body", async () => {
    mockFetch(() => ({ body: { session: { id: "sess_2", token: "sess_old" }, user: { email: "ada@example.com" } } }));
    const session = await exchange({ apiUrl: "http://localhost:3100", email: "ada@example.com", password: "correct horse battery" });
    expect(session.token).toBe("sess_old");
    expect(session.id).toBe("sess_2");
  });

  it("stores the token in sessionStorage, never the password, and uses it on requests", async () => {
    const fetch = mockFetch((url) =>
      url.endsWith("/sessions")
        ? { body: { id: "sess_1", token: "sess_secret", user: { email: "ada@example.com", permissions: ["full"] } } }
        : { body: { object: "list", has_more: false, data: [] } },
    );
    const { result } = renderHook(() => {
      const session = useSession();
      // useClient throws until there is a session, so read the client from the context instead
      return { session, client: session.client };
    }, { wrapper });
    expect(result.current.session.session).toBeNull();

    await act(() => result.current.session.signIn({ apiUrl: "http://localhost:3100", email: "ada@example.com", password: "correct horse battery" }));
    const stored = sessionStorage.getItem(sessionKey)!;
    expect(JSON.parse(stored).token).toBe("sess_secret");
    expect(stored).not.toContain("correct horse");
    expect(JSON.stringify(localStorage)).not.toContain("correct horse");

    await result.current.client!.get("/domains");
    expect(new Headers(callAt(fetch, -1).init.headers).get("authorization")).toBe("Bearer sess_secret");
  });

  it("signs out: revokes the session and clears storage", async () => {
    sessionStorage.setItem(
      sessionKey,
      JSON.stringify({ apiUrl: "http://localhost:3100", token: "sess_secret", id: "sess_1", user: { email: "ada@example.com", permissions: ["full"] } }),
    );
    const fetch = mockFetch(() => ({ body: { object: "session", id: "sess_1", deleted: true } }));
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current.session?.token).toBe("sess_secret");

    act(() => result.current.signOut());
    expect(result.current.session).toBeNull();
    expect(sessionStorage.getItem(sessionKey)).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const { url, init } = callAt(fetch);
    expect(url).toBe("http://localhost:3100/sessions/sess_1");
    expect(init.method).toBe("DELETE");
  });

  it("surfaces a rejected exchange as an error", async () => {
    mockFetch(() => ({ status: 401, body: { name: "invalid_credentials", statusCode: 401, message: "Invalid email or password" } }));
    await expect(exchange({ apiUrl: "http://localhost:3100", email: "a@b.co", password: "wrong password" })).rejects.toMatchObject({
      name: "invalid_credentials",
      statusCode: 401,
    });
  });

  it("can write with full access and only read as a viewer", () => {
    const store = (permissions?: string[]) =>
      sessionStorage.setItem(sessionKey, JSON.stringify({ apiUrl: "http://localhost:3100", token: "sess_secret", user: { email: "ada@example.com", permissions } }));
    store(["full"]);
    expect(renderHook(() => useCan(), { wrapper }).result.current).toBe(true);
    store(["read"]);
    expect(renderHook(() => useCan(), { wrapper }).result.current).toBe(false);
  });

  it("reads the permissions of a session stored before they existed from GET /me", async () => {
    sessionStorage.setItem(sessionKey, JSON.stringify({ apiUrl: "http://localhost:3100", token: "sess_secret", user: { email: "ada@example.com" } }));
    const fetch = mockFetch(() => ({ body: { object: "me", session_id: "sess_9", user: { id: "user_1", email: "ada@example.com", role: "Admin", permissions: ["full"] } } }));
    const { result } = renderHook(() => useCan(), { wrapper });
    // Until /me answers, the old session can only read, so a failed lookup shows no write actions.
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
    expect(callAt(fetch).url).toBe("http://localhost:3100/me");
    const stored = JSON.parse(sessionStorage.getItem(sessionKey)!);
    expect(stored.user.permissions).toEqual(["full"]);
    // The session ID comes with it, so signing out can end the session on the server.
    expect(stored.id).toBe("sess_9");
  });
});
