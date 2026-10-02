// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { broadcast, segment, topic } from "../templates/fixtures";
import { api, calls, list, renderAt } from "../templates/harness";
import { Broadcast, metricsQuery, timeline } from "./Broadcast";

const sent = broadcast({ status: "sent", recipient_count: 120, sent_count: 118, sent_at: "2026-09-30T12:00:00.000Z" });

function setup(row = sent) {
  const fetch = api({
    "GET /broadcasts/broadcast_1": row,
    "GET /segments": list([segment]),
    "GET /topics": list([topic]),
    "GET /brand": { object: "brand" },
    "GET /emails/metrics": {
      object: "metrics",
      totals: { delivered: 110, delivery_rate: 93.2, bounced: 8, bounce_rate: 6.8, unique_opened: 55, open_rate: 50, unique_clicked: 11, click_rate: 10, unsubscribed: 2, unsubscribe_rate: 1.8, complained: 0, complaint_rate: 0 },
      data: [],
    },
    "GET /broadcasts/broadcast_1/recipients": (url: URL) => ({
      body: list(url.searchParams.get("type") === "bounced" ? [{ id: "br_2", email: "gone@x.test", status: "sent", email_id: "email_2", created_at: "2026-09-30T12:00:00.000Z" }] : [{ id: "br_1", email: "ada@x.test", status: "sent", email_id: "email_1", created_at: "2026-09-30T12:00:00.000Z" }]),
    }),
    "GET /broadcasts/broadcast_1/clicked-links": list([{ object: "clicked_link", id: "link_a", url: "https://acme.test/new", clicks: 14, unique_clicks: 11 }]),
    "POST /broadcasts/broadcast_1/cancel": broadcast({ status: "draft" }),
    "POST /broadcasts/broadcast_1/pause": broadcast({ status: "queued", paused: true }),
  });
  renderAt("/broadcasts/broadcast_1", [{ path: "/broadcasts/:id", element: h(Broadcast) }]);
  return fetch;
}

describe("Broadcast", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows facts, analytics for this broadcast, and the top clicked links", async () => {
    const fetch = setup();
    expect(await screen.findByRole("heading", { name: "October update" })).toBeTruthy();
    const stats = await screen.findByLabelText("Analytics");
    await within(stats).findByText("110");
    expect(within(stats).getByText(/Delivered · 93.2%/)).toBeTruthy();
    expect(within(stats).getByText(/Opened · 50%/)).toBeTruthy();
    const query = calls(fetch, "GET /emails/metrics")[0]!.url.searchParams;
    expect(query.get("broadcast_id")).toBe("broadcast_1");
    expect(query.get("metrics")).toContain("unique_opened");
    const links = screen.getByRole("heading", { name: "Top clicked links" }).closest("section")!;
    expect(await within(links).findByText("https://acme.test/new")).toBeTruthy();
    expect(within(links).getByText("14")).toBeTruthy();
    expect(await screen.findByText("Customers")).toBeTruthy();
  });

  it("loads recipients by type and searches by email", async () => {
    const fetch = setup();
    const panel = (await screen.findByRole("heading", { name: "Recipients" })).closest("section")!;
    expect(await within(panel).findByText("ada@x.test")).toBeTruthy();
    expect(calls(fetch, "GET /broadcasts/broadcast_1/recipients")[0]!.url.searchParams.get("type")).toBe("opened");
    fireEvent.click(within(panel).getByRole("tab", { name: "Bounced" }));
    expect(await within(panel).findByText("gone@x.test")).toBeTruthy();
    expect(calls(fetch, "GET /broadcasts/broadcast_1/recipients").at(-1)!.url.searchParams.get("type")).toBe("bounced");
    fireEvent.change(within(panel).getByLabelText("Search recipients"), { target: { value: "gone" } });
    await waitFor(() => expect(calls(fetch, "GET /broadcasts/broadcast_1/recipients").at(-1)!.url.searchParams.get("email")).toBe("gone"));
  });

  it("pauses a sending broadcast and cancels it after typing CANCEL", async () => {
    const fetch = setup(broadcast({ status: "queued" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(calls(fetch, "POST /broadcasts/broadcast_1/pause")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel broadcast" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Confirmation phrase"), { target: { value: "CANCEL" } });
    fireEvent.click(dialog.getByRole("button", { name: /Cancel broadcast/ }));
    await waitFor(() => expect(calls(fetch, "POST /broadcasts/broadcast_1/cancel")).toHaveLength(1));
  });

  it("skips analytics for a draft and links to the editor", async () => {
    const fetch = setup(broadcast());
    expect(await screen.findByRole("link", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByLabelText("Analytics")).toBeNull();
    expect(calls(fetch, "GET /emails/metrics")).toHaveLength(0);
  });
});

describe("Broadcast helpers", () => {
  it("builds the status timeline from timestamps", () => {
    expect(timeline(sent).map((event) => event.label)).toEqual(["Created", "Sent"]);
    expect(timeline(broadcast({ status: "queued", paused: true, scheduled_at: "2026-10-02T00:00:00.000Z" })).map((event) => event.label)).toEqual([
      "Created",
      "Scheduled",
      "Paused",
    ]);
    expect(timeline(broadcast({ status: "canceled" })).map((event) => event.label)).toEqual(["Created", "Canceled"]);
  });

  it("asks for metrics from just before creation until now", () => {
    const query = metricsQuery({ id: "broadcast_1", created_at: "2026-09-30T10:00:00.000Z" }, new Date("2026-10-01T00:00:00.000Z"));
    expect(query).toMatchObject({ broadcast_id: "broadcast_1", start_date: "2026-09-30T09:59:00.000Z", end_date: "2026-10-01T00:00:00.000Z" });
  });
});
