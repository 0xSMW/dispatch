import { changeControl, controlValue } from "../../testingControls";
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import type { Email as EmailRow, EmailEvent, EmailInsights } from "../../types";
import { Email, timeline } from "./Email";
import { adviceFor, problemOf } from "./Problem";
import { api, list, requests, visit } from "./visit";

const row = (patch: Partial<EmailRow> = {}): EmailRow => ({
  object: "email",
  id: "email_1",
  sandbox: false,
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
    await screen.findByText("Delivered", { selector: ".eventNode .badge" });

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
    expect(screen.getByRole("heading", { name: "Checks" })).toBeTruthy();
    expect(screen.getAllByRole("list", { name: "Checks" })).toHaveLength(1);
    expect(screen.getByText("No DMARC record found.")).toBeTruthy();
    expect(screen.getByText("A valid DMARC record exists").closest("li")?.className).toBe("fail");
    expect(screen.getByText("A plain text version is included").closest("li")?.className).toBe("ok");
    expect(screen.getByText("A valid DMARC record exists").closest("li")?.getAttribute("data-check-id")).toBe("dmarc");
    expect(screen.getByText("Possible improvements").querySelector(".badge")?.textContent).toBe("0");
    expect(screen.getByText("Nothing here.")).toBeTruthy();
  });

  it("shows every server-provided insight with its existing severity for a viewer", async () => {
    signIn("sess_test", ["read"]);
    const insights: EmailInsights = {
      object: "email_insights",
      email_id: "email_1",
      needs_attention: [
        { id: "dmarc", title: "A valid DMARC record exists", detail: "No DMARC record found." },
        { id: "links", title: "Links work", detail: "https://acme.test/broken returned 404." },
      ],
      possible_improvements: [{ id: "preview", title: "Preview text is included", detail: "<img src=x onerror=alert(1)>" }],
      doing_great: [{ id: "plain_text", title: "A plain text version is included", detail: "Yes." }],
    };
    const fetch = stack(row(), [], { "/emails/email_1/insights": insights });
    visit(h(Email), "/emails/email_1", "/emails/:id");
    await screen.findByRole("heading", { name: "ada@example.com" });
    fireEvent.click(screen.getByRole("tab", { name: "Insights" }));
    await screen.findByText("Links work");
    const checks = screen.getByRole("list", { name: "Checks" });
    expect(checks.querySelectorAll("[data-check-id]")).toHaveLength(4);
    for (const [key, tone] of [["needs_attention", "fail"], ["possible_improvements", "warn"], ["doing_great", "ok"]] as const) {
      for (const item of insights[key]) {
        const text = within(checks).getByText(item.title);
        expect(text.closest("li")?.getAttribute("data-check-id")).toBe(item.id);
        expect(text.closest("li")?.className).toBe(tone);
        expect(within(checks).getByText(item.detail)).toBeTruthy();
      }
    }
    expect(checks.querySelector("img")).toBeNull();
    expect(requests(fetch, "GET", "/emails/email_1/insights")).toHaveLength(1);
    expect(fetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("keeps the insights loading state instead of showing empty or successful checks", async () => {
    const fetch = stack(row(), [], {
      "/emails/email_1/insights": { object: "email_insights", email_id: "email_1", needs_attention: [], possible_improvements: [], doing_great: [] },
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const reply = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === "/emails/email_1/insights") await pending;
      return reply(input, init);
    });
    visit(h(Email), "/emails/email_1", "/emails/:id");
    await screen.findByRole("heading", { name: "ada@example.com" });
    fireEvent.click(screen.getByRole("tab", { name: "Insights" }));
    const panel = screen.getByRole("heading", { name: "Checks" }).closest(".panel")!;
    expect(panel.querySelectorAll(".skeleton")).toHaveLength(4);
    expect(within(panel as HTMLElement).queryByRole("list")).toBeNull();
    expect(screen.queryByText("Nothing here.")).toBeNull();
    release();
    await screen.findByRole("list", { name: "Checks" });
    expect(screen.getAllByText("Nothing here.")).toHaveLength(3);
    expect(panel.querySelectorAll("[data-check-id]")).toHaveLength(0);
  });

  it("preserves insights errors and retries the same GET endpoint", async () => {
    let attempts = 0;
    const fetch = stack(row(), [], {
      "/emails/email_1/insights": () => ++attempts === 1
        ? { status: 500, body: { name: "internal_error", message: "Insights unavailable" } }
        : { body: { object: "email_insights", email_id: "email_1", needs_attention: [], possible_improvements: [], doing_great: [{ id: "text", title: "Plain text included", detail: "Yes." }] } },
    });
    visit(h(Email), "/emails/email_1", "/emails/:id");
    await screen.findByRole("heading", { name: "ada@example.com" });
    fireEvent.click(screen.getByRole("tab", { name: "Insights" }));
    expect(within(await screen.findByRole("alert")).getByText("Insights unavailable")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Checks" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Plain text included")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(requests(fetch, "GET", "/emails/email_1/insights")).toHaveLength(2);
  });

  it.each(["full", "read"])("distinguishes simulated delivery for %s users without changing status", async (permission) => {
    signIn("sess_test", [permission]);
    stack(row({ sandbox: true, message_id: null }), [event("email.delivered", { sandbox: true })]);
    visit(h(Email), "/emails/email_1", "/emails/:id");

    expect(await screen.findByText("Sandbox")).toBeTruthy();
    expect(screen.getByText("Sandbox delivery is simulated. No email is sent externally.")).toBeTruthy();
    expect(screen.getByText("Delivered", { selector: ".pageHeader .badge" })).toBeTruthy();
    expect(await screen.findByText("Delivered (simulated)")).toBeTruthy();
    expect(screen.queryByText("Message ID")).toBeNull();
  });

  it("marks sandbox recipients separately in a mixed send, including CC and BCC", async () => {
    const recipients = [
      { id: "rcpt_1", email: "ada@acme.com", kind: "to" as const, status: "delivered", sandbox: false, created_at: row().created_at },
      { id: "rcpt_2", email: "cc@example.com", kind: "cc" as const, status: "delivered", sandbox: true, created_at: row().created_at },
      { id: "rcpt_3", email: "bcc@example.com", kind: "bcc" as const, status: "queued", sandbox: true, created_at: row().created_at },
    ];
    stack(row({ to: ["ada@acme.com"], cc: ["cc@example.com"], bcc: ["bcc@example.com"], recipients }), [event("email.delivered")]);
    visit(h(Email), "/emails/email_1", "/emails/:id");

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).queryByText("Sandbox")).toBeNull();
    expect(within(rows[1]).getByText("Delivered")).toBeTruthy();
    expect(within(rows[2]).getByText("Sandbox")).toBeTruthy();
    expect(within(rows[2]).getByText("CC")).toBeTruthy();
    expect(within(rows[3]).getByText("Sandbox")).toBeTruthy();
    expect(within(rows[3]).getByText("Queued")).toBeTruthy();
    expect(within(rows[3]).getByText("BCC")).toBeTruthy();
    expect(screen.getByText(/Sandbox recipients are simulated and are never sent externally/)).toBeTruthy();
    expect(screen.queryByText("delivered (simulated)")).toBeNull();
    expect(document.querySelector(".pageHeader")?.textContent).not.toContain("Sandbox");
  });

  it("identifies sandbox timeline events without changing their event status", () => {
    const simulated = timeline([event("email.delivered", { sandbox: true })])[0];
    expect(simulated.label).toBe("Delivered (simulated)");
    expect(simulated.status).toBe("email.delivered");
    expect(simulated.detail).toContain("No email is sent externally.");
    expect(timeline([event("email.delivered", { sandbox: false })])[0].label).toBe("Delivered");
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
    changeControl(screen.getByLabelText("Expires after"), { target: { value: "48h" } });
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
    changeControl(screen.getByLabelText("Send at"), { target: { value: "tomorrow at 9am" } });
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
    expect(nodes.map((node) => node.label)).toEqual(["Delivery delayed", "Bounced"]);
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
