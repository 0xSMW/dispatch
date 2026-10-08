// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import type { Webhook as WebhookRow } from "../../types";
import { api, list, requests, visit } from "../emails/visit";
import { maskSecret, Webhook } from "./Webhook";
import { eventSummary, Webhooks } from "./Webhooks";

const hook = (patch: Partial<WebhookRow> = {}): WebhookRow => ({
  object: "webhook",
  id: "webhook_1",
  endpoint: "https://example.com/hooks",
  events: ["email.sent", "email.delivered"],
  status: "enabled",
  created_at: "2026-09-30T10:00:00.000Z",
  signing_secret: "whsec_abcdefghijklmnopWXYZ",
  ...patch,
});

describe("Webhooks", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists endpoints with status and a short event summary", async () => {
    api({ "/webhooks": list([hook({ events: ["email.sent", "email.delivered", "email.bounced", "contact.created"] })]) });
    visit(h(Webhooks), "/webhooks");
    expect(await screen.findByText("https://example.com/hooks")).toBeTruthy();
    expect(screen.getByText("email.sent, email.delivered and 2 more")).toBeTruthy();
    expect(eventSummary(["a.b"])).toBe("a.b");
  });

  it("adds a webhook with searched event types and shows the signing secret once", async () => {
    const fetch = api({ "/webhooks": list([]), "POST /webhooks": hook({ id: "webhook_2" }) });
    visit(h(Webhooks), "/webhooks");
    await screen.findByText("No webhooks yet");

    fireEvent.click(screen.getByRole("button", { name: "Add webhook" }));
    const dialog = screen.getByRole("dialog", { name: "Add webhook" });
    fireEvent.change(within(dialog).getByLabelText("Endpoint URL"), { target: { value: "https://example.com/hooks" } });
    fireEvent.change(within(dialog).getByLabelText("Search events"), { target: { value: "domain" } });
    expect(within(dialog).queryByText("email.sent")).toBeNull();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "domain.created" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Add/ }));

    expect(await screen.findByText("whsec_abcdefghijklmnopWXYZ")).toBeTruthy();
    expect(requests(fetch, "POST", "/webhooks")[0].body).toEqual({
      endpoint: "https://example.com/hooks",
      events: ["email.sent", "email.delivered", "email.bounced", "domain.created"],
    });
  });

  it("disables a webhook from the row menu", async () => {
    const fetch = api({ "/webhooks": list([hook()]), "PATCH /webhooks/webhook_1": hook({ status: "disabled" }) });
    visit(h(Webhooks), "/webhooks");
    await screen.findByText("https://example.com/hooks");
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disable" }));
    await waitFor(() => expect(requests(fetch, "PATCH", "/webhooks/webhook_1")[0]?.body).toEqual({ status: "disabled" }));
  });
});

describe("Webhook", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  const deliveries = list([
    { object: "webhook_event", id: "event_1", type: "email.delivered", status: "failed", created_at: "2026-09-30T10:00:00.000Z" },
    { object: "webhook_event", id: "event_2", type: "email.sent", status: "success", created_at: "2026-09-30T09:00:00.000Z" },
  ]);

  function stack(extra: Record<string, unknown> = {}) {
    return api({
      "/webhooks/webhook_1": hook(),
      "/webhooks/webhook_1/events": deliveries,
      "/webhooks/webhook_1/events/event_1": {
        ...deliveries.data[0],
        payload: { type: "email.delivered", data: { email_id: "email_1" } },
        next_attempt_at: "2026-09-30T10:30:00.000Z",
      },
      "/webhooks/webhook_1/events/event_1/attempts": list([
        { id: "attempt_1", http_status_code: 500, response: '{"error":"boom"}', sent_at: "2026-09-30T10:00:01.000Z" },
      ]),
      "/webhooks/webhook_1/events/event_2": { ...deliveries.data[1], payload: { type: "email.sent" }, next_attempt_at: null },
      "/webhooks/webhook_1/events/event_2/attempts": list([{ id: "attempt_2", http_status_code: 200, response: "ok", sent_at: "2026-09-30T09:00:01.000Z" }]),
      ...extra,
    });
  }

  it("masks the signing secret until revealed", async () => {
    stack();
    visit(h(Webhook), "/webhooks/webhook_1", "/webhooks/:id");
    expect(await screen.findByText(maskSecret("whsec_abcdefghijklmnopWXYZ"))).toBeTruthy();
    expect(screen.queryByText("whsec_abcdefghijklmnopWXYZ")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal signing secret" }));
    expect(screen.getByText("whsec_abcdefghijklmnopWXYZ")).toBeTruthy();
    expect(maskSecret("whsec_abcdefghijklmnopWXYZ")).toBe("whsec_••••••••••••WXYZ");
  });

  it("shows the first delivery with attempts and payload, switches deliveries, and replays", async () => {
    const fetch = stack({ "POST /webhooks/webhook_1/events/event_2/replay": { queued: true, event_id: "event_2" } });
    visit(h(Webhook), "/webhooks/webhook_1", "/webhooks/:id");

    expect(await screen.findByText('{"error":"boom"}', { selector: "td span" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Response body" })).toBeTruthy();
    expect(screen.getAllByText("500").length).toBeGreaterThan(0);
    expect(screen.getByText('"email_id"')).toBeTruthy();

    fireEvent.click(screen.getByText("email.sent", { selector: "td span" }));
    await waitFor(() => expect(requests(fetch, "GET", "/webhooks/webhook_1/events/event_2/attempts")).toHaveLength(1));
    await screen.findAllByText("200");
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    await waitFor(() => expect(requests(fetch, "POST", "/webhooks/webhook_1/events/event_2/replay")).toHaveLength(1));
  });

  it("toggles status, edits event types, and rotates the secret", async () => {
    const fetch = stack({
      "PATCH /webhooks/webhook_1": (_url: URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Partial<WebhookRow>;
        return { body: hook(body) };
      },
      "POST /webhooks/webhook_1/signing-secret/rotate": hook({ signing_secret: "whsec_rotatedrotated1234" }),
    });
    visit(h(Webhook), "/webhooks/webhook_1", "/webhooks/:id");
    await screen.findByRole("heading", { name: "https://example.com/hooks" });

    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    await waitFor(() => expect(requests(fetch, "PATCH", "/webhooks/webhook_1")[0]?.body).toEqual({ status: "disabled" }));
    await screen.findByRole("switch", { name: "Disabled" });

    fireEvent.click(screen.getByRole("button", { name: "Edit events" }));
    const dialog = screen.getByRole("dialog", { name: "Edit events" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "email.sent" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(requests(fetch, "PATCH", "/webhooks/webhook_1")[1]?.body).toEqual({ events: ["email.delivered"] }));

    fireEvent.click(screen.getByRole("button", { name: "Webhook actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rotate signing secret" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Rotate signing secret" })).getByRole("button", { name: /^Rotate/ }));
    expect(await screen.findByText("whsec_rotatedrotated1234")).toBeTruthy();
    expect(requests(fetch, "POST", "/webhooks/webhook_1/signing-secret/rotate")).toHaveLength(1);
  });

  it("deletes the webhook after typing DELETE", async () => {
    const fetch = stack({ "DELETE /webhooks/webhook_1": { object: "webhook", id: "webhook_1", deleted: true } });
    visit(h(Webhook), "/webhooks/webhook_1", "/webhooks/:id");
    await screen.findByRole("heading", { name: "https://example.com/hooks" });
    fireEvent.click(screen.getByRole("button", { name: "Webhook actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete webhook" }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "DELETE" } });
    fireEvent.click(screen.getByRole("button", { name: /^Delete webhook/ }));
    expect((await screen.findByTestId("location")).textContent).toBe("/webhooks");
    expect(requests(fetch, "DELETE", "/webhooks/webhook_1")).toHaveLength(1);
  });
});
