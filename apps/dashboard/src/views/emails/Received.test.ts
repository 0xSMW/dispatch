// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { Received } from "./Received";
import { ReceivedEmail } from "./ReceivedEmail";
import { api, list, requests, visit } from "./visit";

const detail = {
  object: "email",
  id: "inbound_1",
  from: "sender@example.net",
  to: ["inbox@acme.test"],
  cc: ["cc@acme.test"],
  subject: "Question about my order",
  html: "<p>Where is it?</p>",
  text: "Where is it?",
  headers: { "x-mailer": "Mail 1.0" },
  message_id: "<m1@example.net>",
  reply_to: [],
  authentication: { spf: "pass", dkim: "fail", dmarc: "none" },
  attachments: [{ id: "ratt_1", filename: "photo.png", content_type: "image/png", size: 10, download_url: "http://localhost:3100/files/p", created_at: "2026-09-30T10:00:00.000Z" }],
  raw: { download_url: "http://localhost:3100/files/raw", expires_at: "2026-10-01T10:00:00.000Z" },
  created_at: "2026-09-30T10:00:00.000Z",
};

describe("Received", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists received emails from GET /emails/receiving", async () => {
    const fetch = api({ "/emails/receiving": list([{ id: "inbound_1", from: "sender@example.net", to: ["inbox@acme.test"], subject: "Question", created_at: "2026-09-30T10:00:00.000Z" }]) });
    visit(h(Received), "/emails/receiving");
    expect(await screen.findByText("sender@example.net")).toBeTruthy();
    expect(screen.getByText("inbox@acme.test")).toBeTruthy();
    expect(requests(fetch, "GET", "/emails/receiving")[0].url.searchParams.get("limit")).toBe("40");
  });

  it("sends search and the date range as from and to", async () => {
    const fetch = api({ "/emails/receiving": list([]) });
    visit(h(Received), "/emails/receiving?q=order&range=custom&start=2026-09-01&end=2026-09-02");
    await screen.findByText("No results");
    const url = requests(fetch, "GET", "/emails/receiving")[0].url;
    expect(url.searchParams.get("q")).toBe("order");
    expect(new Date(url.searchParams.get("from")!).getDate()).toBe(1);
    expect(new Date(url.searchParams.get("to")!).getDate()).toBe(2);
    expect(screen.getByRole("searchbox", { name: "Search by sender or subject" })).toBeTruthy();
  });

  it("simulates an inbound email", async () => {
    const fetch = api({ "/emails/receiving": list([]), "POST /emails/receiving/simulate": { object: "email", id: "inbound_2" } });
    visit(h(Received), "/emails/receiving");
    await screen.findByText("No received emails yet");
    fireEvent.click(screen.getByRole("button", { name: "Simulate inbound" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "a@example.net" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "inbox@acme.test, sales@acme.test" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hi" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Simulate/ }));
    await waitFor(() => expect(requests(fetch, "POST", "/emails/receiving/simulate")).toHaveLength(1));
    expect(requests(fetch, "POST", "/emails/receiving/simulate")[0].body).toMatchObject({
      from: "a@example.net",
      to: ["inbox@acme.test", "sales@acme.test"],
      subject: "Hi",
    });
  });
});

describe("ReceivedEmail", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows facts, verdicts, preview, headers, attachments, and the raw link", async () => {
    const fetch = api({ "/emails/receiving/inbound_1": detail });
    visit(h(ReceivedEmail), "/emails/receiving/inbound_1", "/emails/receiving/:id");

    expect(await screen.findByRole("heading", { name: "Question about my order" })).toBeTruthy();
    expect(requests(fetch, "GET", "/emails/receiving/inbound_1")).toHaveLength(1);
    expect(screen.getByText("SPF pass").className).toContain("success");
    expect(screen.getByText("DKIM fail").className).toContain("danger");
    expect(screen.getByTitle("Email preview").getAttribute("sandbox")).toBe("");
    expect(screen.getByRole("link", { name: /Raw/ }).getAttribute("href")).toBe("http://localhost:3100/files/raw");

    fireEvent.click(screen.getByRole("tab", { name: "Headers" }));
    expect(screen.getByText("x-mailer")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Attachments/ }));
    expect(screen.getByRole("link", { name: "photo.png" }).getAttribute("href")).toBe("http://localhost:3100/files/p");
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    expect(screen.getByRole("link", { name: /Download message.eml/ })).toBeTruthy();
  });

  it("shares a received email", async () => {
    const fetch = api({
      "/emails/receiving/inbound_1": detail,
      "POST /emails/inbound_1/share": { object: "email", id: "inbound_1", url: "http://localhost:5173/shared?token=r" },
    });
    visit(h(ReceivedEmail), "/emails/receiving/inbound_1", "/emails/receiving/:id");
    await screen.findByRole("heading", { name: "Question about my order" });
    fireEvent.click(screen.getByRole("button", { name: "Email actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Share email" }));
    fireEvent.click(screen.getByRole("button", { name: /Create link/ }));
    expect(await screen.findByText("http://localhost:5173/shared?token=r")).toBeTruthy();
    expect(requests(fetch, "POST", "/emails/inbound_1/share")[0].body).toEqual({ expires_in: "24h" });
  });
});
