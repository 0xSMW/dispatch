// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, mockFetch, signIn, wrapper } from "../../testing";
import { Events, samplePayload, schemaIssue, toSchema } from "./Events";

const definitions = [{ object: "event", id: "evdef_1", name: "user.upgraded", schema: { plan: "string", seats: "number" }, created_at: "2026-09-01T00:00:00.000Z" }];
const fired = [{ object: "fired_event", id: "cevt_1", name: "user.upgraded", email: "ada@example.com", payload: { plan: "pro" }, request_id: "req_1", created_at: "2026-09-02T00:00:00.000Z" }];

function api() {
  return mockFetch((url, init) => {
    const path = new URL(url).pathname;
    if (init.method === "POST" && path === "/events") return { body: { object: "event", id: "evdef_2", name: "user.created", schema: {} } };
    if (init.method === "POST") return { status: 202, body: { object: "event", event: "user.upgraded", id: "cevt_2" } };
    if (path === "/events") return { body: { object: "list", has_more: false, data: definitions } };
    if (path === "/fired-events") return { body: { object: "list", has_more: false, data: fired } };
    return { body: {} };
  });
}

const posted = (fetch: ReturnType<typeof api>, path: string) => {
  const call = fetch.mock.calls.find(([url, init]) => init?.method === "POST" && new URL(String(url)).pathname === path);
  return call ? JSON.parse(String(call[1]!.body)) : null;
};

describe("Events", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists definitions with their fields and the fired events", async () => {
    const fetch = api();
    render(h(Events), { wrapper });
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText(/with a new email address creates a contact/)).toBeTruthy();
    expect(screen.getAllByText("user.upgraded").length).toBe(2);
    expect(screen.getByText(": number")).toBeTruthy();
    const paths = fetch.mock.calls.map(([url]) => String(url));
    expect(paths).toContain("http://localhost:3100/events?limit=40");
    expect(paths).toContain("http://localhost:3100/fired-events?limit=20");
  });

  it("adds a definition with typed fields", async () => {
    const fetch = api();
    render(h(Events), { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Add event" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: "user.created" } });
    fireEvent.change(within(dialog).getByLabelText("Property"), { target: { value: "trial_ends" } });
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "date" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Add\s*(Ctrl|⌘)/ }));
    await waitFor(() => expect(posted(fetch, "/events")).toEqual({ name: "user.created", schema: { trial_ends: "date" } }));
  });

  it("sends a test event with a payload prefilled from the definition", async () => {
    const fetch = api();
    render(h(Events), { wrapper });
    const row = (await screen.findAllByText("user.upgraded"))[0]!.closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Send test event" }));
    const dialog = screen.getByRole("dialog");
    expect(String((within(dialog).getByLabelText("Payload") as HTMLTextAreaElement).value)).toContain('"seats": 1');
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Send/ }));
    await waitFor(() =>
      expect(posted(fetch, "/events/send")).toEqual({ event: "user.upgraded", email: "ada@example.com", payload: { plan: "text", seats: 1 } }),
    );
  });
});

describe("event helpers", () => {
  it("builds a schema map and catches duplicate fields", () => {
    expect(toSchema([{ name: " plan ", type: "string" }, { name: "", type: "number" }])).toEqual({ plan: "string" });
    expect(schemaIssue([{ name: "plan", type: "string" }, { name: "plan", type: "number" }])).toBe("plan is listed twice.");
    expect(samplePayload({ ok: "boolean", n: "number" })).toEqual({ ok: true, n: 1 });
  });
});
