// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, mockFetch, signIn } from "../testing";
import { SessionProvider } from "./session";
import { Shell } from "./Shell";

function Page() { const location = useLocation(); return h("p", { "data-testid": "location" }, `${location.pathname}${location.search}`); }
function open() {
  render(h(MemoryRouter, { initialEntries: ["/timeline"] }, h(SessionProvider, null, h(Routes, null, h(Route, { element: h(Shell) }, h(Route, { path: "*", element: h(Page) }))))));
}
function palette() { fireEvent.click(screen.getByRole("button", { name: "Search or jump" })); return screen.getByRole("combobox"); }
function query(input: HTMLElement, value: string) { fireEvent.change(input, { target: { value } }); }
beforeEach(() => { signIn(); mockFetch(() => ({ body: { data: [] } })); });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
describe("Command K", () => {
  it("opens while typing, focuses search, navigates with Enter, and remembers destinations", () => {
    open(); fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = screen.getByRole("combobox"); expect(document.activeElement).toBe(input);
    query(input, "goals"); fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("location").textContent).toBe("/goals");
    expect(screen.queryByRole("dialog")).toBeNull();
    palette(); expect(screen.getByText("Recent")).toBeTruthy();
  });
  it("previews natural filters and opens the same filters on Emails", () => {
    open(); const input = palette(); query(input, "bounced emails today");
    expect(screen.getByText("Status: bounced · Today")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("location").textContent).toBe("/emails?range=today&status=bounced");
  });
  it("does not show write commands to viewers and restores focus on Escape", () => {
    signIn("viewer", ["read"]); open(); const trigger = screen.getByRole("button", { name: "Search or jump" }); trigger.focus();
    const input = palette(); expect(screen.queryByText("Send email", { selector: ".commandText span" })).toBeNull();
    fireEvent.keyDown(input, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
  it("debounces record queries, shows failures, and exposes automation actions", async () => {
    const fetch = mockFetch((url) => {
      if (url.includes("/domains")) return { status: 500, body: { message: "offline" } };
      return { body: { data: url.includes("/automations") ? [{ id: "automation_1", name: "Welcome", status: "enabled" }] : [] } };
    });
    open(); const input = palette(); query(input, "Wel"); query(input, "Welcome");
    await screen.findByText("Welcome"); expect(fetch).toHaveBeenCalledTimes(6);
    expect(screen.getByText(/Could not search domain/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Welcome" }));
    expect(screen.getByText("View runs")).toBeTruthy();
    query(input, "metrics");
    expect(screen.queryByText("View runs")).toBeNull();
    fireEvent.click(screen.getByText("View metrics"));
    expect(screen.getByTestId("location").textContent).toBe("/automations/automation_1/editor?tab=metrics");
  });
  it("discards late results from an earlier query", async () => {
    let release: (reply: { body: unknown }) => void = () => {};
    mockFetch((url) => url.includes("q=old") && url.includes("/templates") ? new Promise((resolve) => { release = resolve; }) : { body: { data: url.includes("q=new") && url.includes("/templates") ? [{ id: "template_new", name: "new" }] : [] } });
    open(); const input = palette(); query(input, "old");
    await waitFor(() => expect(screen.getByText("Searching records...")).toBeTruthy());
    query(input, "new"); await screen.findByText("new");
    release({ body: { data: [{ id: "template_old", name: "old" }] } });
    await waitFor(() => expect(screen.queryByText("old")).toBeNull());
    expect(screen.getByText("new")).toBeTruthy();
  });
});
