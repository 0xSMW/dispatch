// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, mockFetch, signIn, wrapper } from "../../testing";
import { Events, samplePayload, schemaIssue, toSchema } from "./Events";

const definitions = [{ object: "event", id: "evdef_1", name: "user.upgraded", schema: { plan: "string", seats: "number" },
  fired_count: 1204, last_fired_at: "2026-09-02T00:00:00.000Z", created_at: "2026-09-01T00:00:00.000Z" }];
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

const refreshedAt = "2026-09-03T12:00:00.000Z";

function refreshApi(sendStatus = 202) {
  let definitionReads = 0;
  let firedReads = 0;
  return mockFetch((url, init) => {
    const path = new URL(url).pathname;
    if (init.method === "POST" && path === "/events/send") {
      return sendStatus === 202
        ? { status: 202, body: { object: "event", event: "user.upgraded", id: "cevt_2" } }
        : { status: sendStatus, body: { error: { type: "validation_error", message: "Event rejected." } } };
    }
    if (path === "/events") {
      definitionReads += 1;
      return { body: { object: "list", has_more: false, data: definitionReads === 1
        ? definitions : [{ ...definitions[0], fired_count: 1205, last_fired_at: refreshedAt }] } };
    }
    if (path === "/fired-events") {
      firedReads += 1;
      return { body: { object: "list", has_more: false, data: firedReads === 1
        ? fired : [{ ...fired[0], id: "cevt_2", email: "grace@example.com", created_at: refreshedAt }, ...fired] } };
    }
    return { body: {} };
  });
}

function listRequests(fetch: ReturnType<typeof mockFetch>) {
  return fetch.mock.calls
    .filter(([, init]) => (init?.method ?? "GET") === "GET")
    .map(([url]) => String(url));
}

async function expectRefreshed(fetch: ReturnType<typeof mockFetch>) {
  expect(await screen.findByText("grace@example.com")).toBeTruthy();
  await waitFor(() => expect(screen.getByText("1,205")).toBeTruthy());
  const definition = screen.getByText("1,205").closest("tr")!;
  expect(definition.querySelector("time")?.dateTime).toBe(refreshedAt);
  const firing = screen.getByText("grace@example.com").closest("tr")!;
  expect(firing.querySelector("time")?.dateTime).toBe(refreshedAt);
  expect(listRequests(fetch)).toEqual([
    "http://localhost:3100/events?limit=40",
    "http://localhost:3100/fired-events?limit=20",
    "http://localhost:3100/events?limit=40",
    "http://localhost:3100/fired-events?limit=20",
  ]);
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
    expect(screen.getByRole("heading", { name: "Events" })).toBeTruthy();
    expect(screen.getByText("1,204")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Automations" })).toBeNull();
    const paths = fetch.mock.calls.map(([url]) => String(url));
    expect(paths).toContain("http://localhost:3100/events?limit=40");
    expect(paths).toContain("http://localhost:3100/fired-events?limit=20");
  });

  it("renders zero counts and null last-fired as Never, not the current time", async () => {
    mockFetch((url) => ({ body: { object: "list", has_more: false, data: new URL(url).pathname === "/events"
      ? [{ ...definitions[0], fired_count: 0, last_fired_at: null }] : [] } }));
    render(h(Events), { wrapper });
    const row = (await screen.findByText("user.upgraded")).closest("tr")!;
    expect(within(row).getByText("0")).toBeTruthy();
    expect(within(row).getByText("Never")).toBeTruthy();
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

  it("sends a prefilled test event and refreshes definitions and firing rows on success", async () => {
    const fetch = refreshApi();
    render(h(Events), { wrapper });
    await screen.findByText("ada@example.com");
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
    await expectRefreshed(fetch);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["full", "read"])("refreshes both lists manually with %s permissions", async (permission) => {
    signIn("sess_test", [permission]);
    const fetch = refreshApi();
    render(h(Events), { wrapper });
    await screen.findByText("ada@example.com");
    if (permission === "read") {
      expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Send test event" })).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await expectRefreshed(fetch);
    expect(fetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reloads neither list after a failed Send", async () => {
    const fetch = refreshApi(422);
    render(h(Events), { wrapper });
    await screen.findByText("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send test event" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Event"), { target: { value: "user.upgraded" } });
    const send = within(dialog).getByRole("button", { name: /Send/ }) as HTMLButtonElement;
    fireEvent.click(send);
    await waitFor(() => expect(posted(fetch, "/events/send")).not.toBeNull());
    await waitFor(() => expect(send.disabled).toBe(false));
    expect(listRequests(fetch)).toEqual([
      "http://localhost:3100/events?limit=40",
      "http://localhost:3100/fired-events?limit=20",
    ]);
    expect(screen.getByText("1,204")).toBeTruthy();
    expect(screen.getByText("1,204").closest("tr")!.querySelector("time")?.dateTime).toBe(definitions[0]!.last_fired_at);
    expect(screen.queryByText("grace@example.com")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("event helpers", () => {
  it("builds a schema map and catches duplicate fields", () => {
    expect(toSchema([{ name: " plan ", type: "string" }, { name: "", type: "number" }])).toEqual({ plan: "string" });
    expect(schemaIssue([{ name: "plan", type: "string" }, { name: "plan", type: "number" }])).toBe("plan is listed twice.");
    expect(samplePayload({ ok: "boolean", n: "number" })).toEqual({ ok: true, n: 1 });
  });
});
