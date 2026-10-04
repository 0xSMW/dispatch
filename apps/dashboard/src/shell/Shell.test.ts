// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, mockFetch, signIn } from "../testing";
import { useResource } from "../hooks/useResource";
import { SessionProvider } from "./session";
import { Shell } from "./Shell";

function Login() {
  const location = useLocation();
  return h("p", null, `Login from ${(location.state as { from?: string } | null)?.from ?? "nowhere"}`);
}

function Page() {
  const emails = useResource<unknown>("/emails");
  return h("p", null, emails.error ?? "Page");
}

function openGuarded(path: string) {
  render(
    h(
      MemoryRouter,
      { initialEntries: [path] },
      h(
        SessionProvider,
        null,
        h(Routes, null, h(Route, { path: "/login", element: h(Login) }), h(Route, { element: h(Shell) }, h(Route, { path: "*", element: h(Page) }))),
      ),
    ),
  );
}

describe("Shell and the session", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("sends a visitor with no session to /login and remembers where they were going", () => {
    mockFetch(() => ({ body: {} }));
    openGuarded("/emails?status=bounced");
    expect(screen.getByText("Login from /emails?status=bounced")).toBeTruthy();
  });

  it("signs out on a 401 in the middle of a session and returns to the same page after sign-in", async () => {
    signIn();
    mockFetch(() => ({ status: 401, body: { name: "invalid_session", statusCode: 401, message: "Invalid session" } }));
    openGuarded("/domains");
    expect(await screen.findByText("Login from /domains")).toBeTruthy();
    expect(sessionStorage.length).toBe(0);
  });
});

function open(path: string) {
  mockFetch(() => ({ body: { object: "list", has_more: false, data: [] } }));
  render(
    h(
      MemoryRouter,
      { initialEntries: [path] },
      h(
        SessionProvider,
        null,
        h(Routes, null, h(Route, { element: h(Shell) }, h(Route, { path: "*", element: h("input", { "aria-label": "Page field" }) }))),
      ),
    ),
  );
}

describe("Shell keys", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("opens the API reference for the page with A, filled with its ids", () => {
    open("/domains/domain_1");
    fireEvent.keyDown(document.body, { key: "a" });
    const drawer = screen.getByRole("dialog", { name: "Domain" });
    const call = within(drawer).getByRole("region", { name: "POST /domains/domain_1/verify" });
    expect(call.textContent).toContain('curl -X POST "http://localhost:3100/domains/domain_1/verify"');
    expect(call.textContent).toContain("$DISPATCH_API_KEY");

    fireEvent.click(within(drawer).getByRole("tab", { name: "TypeScript" }));
    expect(within(drawer).getByRole("region", { name: "POST /domains/domain_1/verify" }).textContent).toContain('dispatch.domains.verify("domain_1")');
  });

  it("opens it from the API button too, and ignores A while typing", () => {
    open("/emails");
    fireEvent.keyDown(screen.getByLabelText("Page field"), { key: "a" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /API/ }));
    expect(screen.getByRole("dialog", { name: "Emails" })).toBeTruthy();
  });

  it("lists every shortcut on ?", () => {
    open("/emails");
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    for (const label of ["Open the API reference for this page", "Switch between dark and light", "Select every row on the page", "Delete the selected rows", "Save"]) {
      expect(within(dialog).getByText(label)).toBeTruthy();
    }
  });
});
