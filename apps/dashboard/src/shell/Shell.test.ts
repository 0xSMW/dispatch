// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, mockFetch, signIn } from "../testing";
import { useResource } from "../hooks/useResource";
import { SessionProvider, sessionKey } from "./session";
import { EventsRedirect, nav, Shell } from "./Shell";

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

  it.each([
    { role: "full", width: 1440 }, { role: "viewer", width: 1440 },
    { role: "full", width: 390 }, { role: "viewer", width: 390 },
  ])("shares one flat menu with Metrics below Emails for $role at $width", ({ role, width }) => {
    vi.stubGlobal("innerWidth", width);
    if (role === "viewer") signIn("viewer", ["read"]);
    open("/events");
    const labels = ["Emails", "Metrics", "Broadcasts", "Automations", "Templates", "Audience", "Topics", "Goals", "Domains",
      "Logs", "API keys", "Webhooks", "Timeline", "Events", "Settings"];
    expect(nav.map((item) => item.label)).toEqual(labels);
    const menu = screen.getByRole("navigation", { name: "Main" });
    const main = within(menu);
    expect(main.getAllByRole("link").map((link) => link.textContent)).toEqual(labels);
    expect([...menu.children].map((child) => child.tagName)).toEqual(labels.map(() => "A"));
    expect(main.queryAllByRole("group")).toHaveLength(0);
    expect(main.queryByText("Send")).toBeNull();
    expect(main.queryByText("Engage")).toBeNull();
    expect(main.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(nav.map((item) => item.to));
    expect(main.getByRole("link", { name: "Events" }).getAttribute("href")).toBe("/events");
    expect(main.getByRole("link", { name: "Goals" }).getAttribute("href")).toBe("/goals");
  });

  it("opens the unsubscribe editor without dashboard chrome", () => {
    open("/settings/unsubscribe-page/edit");
    expect(screen.getByLabelText("Page field")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("anchors the account above navigation, derives initials, and opens its menu downward", () => {
    const session = JSON.parse(sessionStorage.getItem(sessionKey)!);
    session.user.name = "Stephen Walker";
    session.user.email = "stephen@example.com";
    sessionStorage.setItem(sessionKey, JSON.stringify(session));
    open("/events");
    const account = screen.getByRole("button", { name: /Stephen Walker\s*stephen@example.com/ });
    expect(account.querySelector(".avatar")?.textContent).toBe("SW");
    expect(document.querySelector(".sidebar")?.firstElementChild?.className).toBe("account");
    expect(document.querySelector(".sidebarFoot .account")).toBeNull();
    expect(document.querySelector(".sidebarFoot .sidebarTools")).toBeTruthy();
    vi.spyOn(account, "getBoundingClientRect").mockReturnValue({ top: 18, bottom: 66, left: 12, right: 232, width: 220, height: 48, x: 12, y: 18, toJSON: () => ({}) });
    fireEvent.click(account);
    expect(screen.getByRole("menu").style.top).toBe("70px");
    expect(screen.getByRole("menu").style.bottom).toBe("");
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });

  it("falls back to the email initial when the account has no name", () => {
    open("/events");
    const account = screen.getByRole("button", { name: "ada@example.com" });
    expect(account.querySelector(".avatar")?.textContent).toBe("A");
  });

  it("highlights Topics without also highlighting Audience", () => {
    open("/audience/topics");
    const menu = within(screen.getByRole("navigation", { name: "Main" }));
    expect(menu.getByRole("link", { name: "Topics" }).getAttribute("aria-current")).toBe("page");
    expect(menu.getByRole("link", { name: "Audience" }).getAttribute("aria-current")).toBeNull();
  });

  it.each([
    ["/automations/a/editor", true], ["/automations/a/editor?view=canvas", true],
    ["/automations/a/editor?view=list", false], ["/automations/a/editor?tab=runs", false],
    ["/automations/a/editor?tab=metrics&view=canvas", false], ["/automations", false],
    ["/templates/a/editor", false], ["/events", false],
  ])("scopes workspace chrome to the Canvas builder at %s", (path, workspace) => {
    open(path as string);
    expect(document.querySelector(".app")?.classList.contains("automationWorkspace")).toBe(workspace);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
  });

  it("replaces the old Events route while preserving search and hash", async () => {
    function Destination() {
      const location = useLocation();
      const navigate = useNavigate();
      return h("div", null, h("p", null, `${location.pathname}${location.search}${location.hash}`),
        h("button", { onClick: () => navigate(-1) }, "Back"));
    }
    render(h(MemoryRouter, { initialEntries: ["/before", "/automations/events?limit=10&q=signup#recent"] },
      h(Routes, null,
        h(Route, { path: "/automations/events", element: h(EventsRedirect) }),
        h(Route, { path: "*", element: h(Destination) }))));
    expect(await screen.findByText("/events?limit=10&q=signup#recent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("/before")).toBeTruthy();
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
