// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import type { Email as EmailRow, EmailEvent } from "../../types";
import { Email, timeline } from "./Email";
import { adviceFor, problemOf } from "./Problem";
import { api, list, requests, visit } from "./visit";

const row = (patch: Partial<EmailRow> = {}): EmailRow => ({
  object: "email",
  id: "email_1",
  message_id: "<abc@ses>",
  from: "Acme <hello@acme.test>",
  to: ["ada@example.com"],
  cc: [],
  bcc: [],
  reply_to: ["support@acme.test"],
  subject: "Welcome, Ada",
  html: "<p>Hello <script>alert(1)</script></p>",
  text: "Hello",
  last_event: "delivered",
  scheduled_at: null,
  tags: [],
  created_at: "2026-09-30T10:00:00.000Z",
  ...patch,
});

const event = (type: string, data: Record<string, unknown> = {}, id = type): EmailEvent => ({
  id,
  type,
  data,
  created_at: "2026-09-30T10:00:05.000Z",
});

const bounce = event("email.bounced", { bounce: { type: "Permanent", subType: "NoEmail", message: "550 5.1.1 user unknown" } });

function stack(email: EmailRow, events: EmailEvent[], extra: Record<string, unknown> = {}) {
  return api({
    "/emails/email_1": email,
    "/emails/email_1/events": list(events),
    "/emails/email_1/attachments": list([
      {
        id: "att_1",
        filename: "invoice.pdf",
        content_type: "application/pdf",
        size: 2048,
        download_url: "http://localhost:3100/files/signed",
        expires_at: "2026-10-01T10:00:00.000Z",
        created_at: "2026-09-30T10:00:00.000Z",
      },
    ]),
    ...extra,
  });
}

describe("Email", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows facts, the event timeline, attachments, and a sandboxed preview", async () => {
    const fetch = stack(row(), [event("email.sent"), event("email.delivered")]);
    visit(h(Email), "/emails/email_1", "/emails/:id");

    expect(await screen.findByRole("heading", { name: "ada@example.com" })).toBeTruthy();
    expect(screen.getByText("Acme <hello@acme.test>")).toBeTruthy();
    expect(screen.getByText("support@acme.test")).toBeTruthy();
    expect(requests(fetch, "GET", "/emails/email_1/events")[0].url.searchParams.get("limit")).toBe("100");
    await screen.findByText("delivered", { selector: ".eventNode .badge" });

    const link = await screen.findByRole("link", { name: /invoice\.pdf/ });
    expect(link.getAttribute("href")).toBe("http://localhost:3100/files/signed");

    const frame = screen.getByTitle("Email preview");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<script>");
    fireEvent.click(screen.getByRole("button", { name: /Phone/ }));
    expect(screen.getByTitle("Email preview").className).toContain("phone");

    fireEvent.click(screen.getByRole("tab", { name: "HTML" }));
    expect(screen.getByText("<p", { selector: ".tokTag" })).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("loads Insights only when the tab opens and groups the checks", async () => {
    const fetch = stack(row(), [], {
      "/emails/email_1/insights": {
        object: "email_insights",
        email_id: "email_1",
        needs_attention: [{ id: "dmarc", title: "A valid DMARC record exists", detail: "No DMARC record found." }],
        possible_improvements: [],
        doing_great: [{ id: "plain_text", title: "A plain text version is included", detail: "Yes." }],
      },
    });
    visit(h(Email), "/emails/email_1", "/emails/:id");
    await screen.findByRole("heading", { name: "ada@example.com" });
    expect(requests(fetch, "GET", "/emails/email_1/insights")).toHaveLength(0);

    fireEvent.click(screen.getByRole("tab", { name: "Insights" }));
    expect(await screen.findByText("A valid DMARC record exists")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("A plain text version is included")).toBeTruthy();
    expect(requests(fetch, "GET", "/emails/email_1/insights")).toHaveLength(1);
  });

  it("explains a bounce in a drawer and removes the address from the suppression list", async () => {
    const fetch = stack(row({ last_event: "bounced" }), [event("email.sent"), bounce], {
      "DELETE /suppressions/ada%40example.com": { object: "suppression", id: "sup_1", deleted: true },
    });
    visit(h(Email), "/emails/email_1", "/emails/:id");

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText(/This email bounced for ada@example.com/)).toBeTruthy();
    fireEvent.click(within(banner).getByRole("button", { name: "See details" }));
    const drawer = screen.getByRole("dialog", { name: "What happened" });
    expect(within(drawer).getByText("NoEmail")).toBeTruthy();
    expect(within(drawer).getByText("550 5.1.1 user unknown")).toBeTruthy();
    expect(within(drawer).getByText(/does not exist/)).toBeTruthy();

    fireEvent.click(within(drawer).getByRole("button", { name: "Remove from suppression list" }));
    await waitFor(() => expect(requests(fetch, "DELETE", "/suppressions/ada%40example.com")).toHaveLength(1));
  });

  it("creates a share link and shows it with a copy button", async () => {
    const fetch = stack(row(), [], {
      "POST /emails/email_1/share": { object: "email", id: "email_1", url: "http://localhost:5173/shared?token=abc" },
    });
    visit(h(Email), "/emails/email_1", "/emails/:id");
    await screen.findByRole("heading", { name: "ada@example.com" });

    fireEvent.click(screen.getByRole("button", { name: "Email actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Share email" }));
    fireEvent.change(screen.getByLabelText("Expires after"), { target: { value: "48h" } });
    fireEvent.click(screen.getByRole("button", { name: /Create link/ }));

    expect(await screen.findByText("http://localhost:5173/shared?token=abc")).toBeTruthy();
    expect(requests(fetch, "POST", "/emails/email_1/share")[0].body).toEqual({ expires_in: "48h" });
  });

  it("links to the email's logs from the menu", async () => {
    stack(row(), []);
    visit(h(Email), "/emails/email_1", "/emails/:id");
    await screen.findByRole("heading", { name: "ada@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Email actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "View logs" }));
    expect((await screen.findByTestId("location")).textContent).toBe("/logs?email_id=email_1");
  });

  it("reschedules a scheduled email with PATCH", async () => {
    const fetch = stack(row({ last_event: "scheduled", scheduled_at: "2026-10-09T09:00:00.000Z" }), [event("email.scheduled")], {
      "PATCH /emails/email_1": { object: "email", id: "email_1" },
    });
    visit(h(Email), "/emails/email_1", "/emails/:id");
    await screen.findByRole("heading", { name: "ada@example.com" });

    fireEvent.click(screen.getByRole("button", { name: "Email actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit schedule" }));
    fireEvent.change(screen.getByLabelText("Send at"), { target: { value: "tomorrow at 9am" } });
    // The phrase is read in the browser's zone and shown before it can be saved.
    await screen.findByText(/^Sends .+ \(.+\)\.$/);
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));

    const expected = new Date();
    expected.setDate(expected.getDate() + 1);
    expected.setHours(9, 0, 0, 0);
    await waitFor(() => expect(requests(fetch, "PATCH", "/emails/email_1")[0]?.body).toEqual({ scheduled_at: expected.toISOString() }));
  });

  it("builds timeline nodes with the bounce reason as hover detail", () => {
    const nodes = timeline([event("email.delivery_delayed"), bounce]);
    expect(nodes.map((node) => node.label)).toEqual(["delivery delayed", "bounced"]);
    expect(nodes[1].detail).toBe("Permanent · NoEmail · 550 5.1.1 user unknown");
  });

  it("names only the address the event names, and never guesses among several recipients", () => {
    const named = problemOf(event("email.bounced", { email: "a@x.com", bounce: { type: "Permanent", subType: "General", message: "550" } }), ["a@x.com", "b@x.com"]);
    expect(named.recipients).toEqual(["a@x.com"]);
    // An older event with no address: two recipients, so there is no safe guess.
    expect(problemOf(bounce, ["a@x.com", "b@x.com"]).recipients).toEqual([]);
    expect(problemOf(bounce, ["a@x.com"]).recipients).toEqual(["a@x.com"]);
  });

  it("reads suppressed events and gives advice for each SES bounce type", () => {
    const suppressed = problemOf(
      event("email.suppressed", { email: "bob@example.com", suppressed: { type: "OnAccountSuppressionList", message: "On the list." } }),
      ["fallback@example.com"],
    );
    expect(suppressed).toMatchObject({ kind: "suppressed", recipients: ["bob@example.com"], type: "OnAccountSuppressionList" });
    expect(adviceFor({ type: "Transient", subType: "MailboxFull" })).toMatch(/full/);
    expect(adviceFor({ type: "Permanent", subType: "Unknown" })).toMatch(/not say why/);
  });
});
