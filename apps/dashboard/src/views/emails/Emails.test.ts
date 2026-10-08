// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toCsv } from "../../components/CsvExport";
import { h, signIn } from "../../testing";
import type { Email } from "../../types";
import { emailCsv, Emails } from "./Emails";
import { api, list, requests, visit } from "./visit";

const email = (patch: Partial<Email> = {}): Email => ({
  object: "email",
  id: "email_1",
  sandbox: false,
  message_id: null,
  from: "Acme <hello@acme.test>",
  to: ["ada@example.com"],
  cc: [],
  bcc: [],
  reply_to: [],
  subject: "Welcome, Ada",
  html: "<p>Hi</p>",
  text: "Hi",
  last_event: "delivered",
  scheduled_at: null,
  tags: [],
  created_at: "2026-09-30T10:00:00.000Z",
  ...patch,
});

describe("Emails", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("sends the URL filters, the date range, and the API key to GET /emails", async () => {
    const fetch = api({
      "/emails": list([email({ last_event: "bounced" })]),
      "/api-keys": list([{ id: "key_1", name: "Production", created_at: "2026-09-01T00:00:00.000Z" }]),
    });
    visit(h(Emails), "/emails?q=ada&status=bounced&api_key_id=key_1&range=today", "/emails");

    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Send email" })).toBeNull();
    const query = requests(fetch, "GET", "/emails")[0].url.searchParams;
    expect(query.get("q")).toBe("ada");
    expect(query.get("status")).toBe("bounced");
    expect(query.get("api_key_id")).toBe("key_1");
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(query.get("from")).toBe(midnight.toISOString());
    expect(query.get("to")).toBeNull();
    expect(query.get("limit")).toBe("40");

    expect(screen.getAllByText("Bounced").length).toBeGreaterThan(0);
    expect(screen.getByText("Welcome, Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "API keys" }));
    expect(await screen.findByRole("option", { name: "Production" })).toBeTruthy();
  });

  it("cancels a scheduled email from the row menu after typing CANCEL", async () => {
    const fetch = api({
      "/emails": list([email({ last_event: "scheduled", scheduled_at: "2026-10-09T09:00:00.000Z" })]),
      "/api-keys": list([]),
      "POST /emails/email_1/cancel": { object: "email", id: "email_1" },
    });
    visit(h(Emails), "/emails");

    await screen.findByText("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel send" }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "CANCEL" } });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel email/ }));

    await waitFor(() => expect(requests(fetch, "POST", "/emails/email_1/cancel")).toHaveLength(1));
    await waitFor(() => expect(requests(fetch, "GET", "/emails").length).toBe(2));
  });

  it("hides Cancel for a delivered email", async () => {
    api({ "/emails": list([email()]), "/api-keys": list([]) });
    visit(h(Emails), "/emails");
    await screen.findByText("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.queryByRole("menuitem", { name: "Cancel send" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Copy ID" })).toBeTruthy();
  });

  it.each(["queued", "delivered"])("labels sandbox emails separately while preserving %s status", async (status) => {
    api({
      "/emails": list([email({ sandbox: true, last_event: status }), email({ id: "email_2", to: ["bob@acme.com"], last_event: status })]),
      "/api-keys": list([]),
    });
    visit(h(Emails), "/emails");
    const sandbox = (await screen.findByText("ada@example.com")).closest("tr")!;
    const real = screen.getByText("bob@acme.com").closest("tr")!;
    expect(within(sandbox).getByText(status[0]!.toUpperCase() + status.slice(1))).toBeTruthy();
    expect(within(sandbox).getByText("Sandbox")).toBeTruthy();
    expect(within(sandbox).getByTitle("Sandbox delivery is simulated. No email is sent externally.")).toBeTruthy();
    expect(within(real).queryByText("Sandbox")).toBeNull();
    expect(within(real).getByText(status[0]!.toUpperCase() + status.slice(1))).toBeTruthy();
  });

  it("exports the page as CSV with quoted fields", () => {
    const csv = toCsv([email({ subject: 'Hi, "Ada"', to: ["a@x.test", "b@x.test"] })], emailCsv);
    expect(csv).toBe(
      'id,to,from,subject,status,sandbox,created_at\r\nemail_1,a@x.test b@x.test,Acme <hello@acme.test>,"Hi, ""Ada""",delivered,false,2026-09-30T10:00:00.000Z\r\n',
    );
    expect(toCsv([email({ sandbox: true })], emailCsv)).toContain(",delivered,true,");
  });
});
