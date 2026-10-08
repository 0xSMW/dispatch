// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { calls, list, show, Status, stubApi } from "../audience/stub";
import { estimateLabel, quotaLabel, quotaShare, Usage } from "./Usage";

function summary() {
  return { month: "2026-10", recipients: 2, ses_recipients: 2, api_requests: 120, unmeasured_sends: 0,
    ses_estimate_usd: 0.0002, ses_rate_per_1000_usd: 0.10,
    days: [{ date: "2026-10-01", recipients: 2, api_requests: 120 }, { date: "2026-10-02", recipients: 0, api_requests: 0 }] };
}

describe("Usage", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows usage counters and system state", async () => {
    const fetch = stubApi({
      "GET /usage/summary": summary(),
      "GET /usage": list([{ id: "use_1", name: "emails.sent", period: "2026-09-30", value: "12345", updated_at: "2026-09-30T00:00:00.000Z" }]),
      "GET /system": {
        object: "system",
        ok: true,
        provider: "fake",
        worker: { backlog: { queued: 3, sent: 40 }, concurrency: 5 },
        webhooks: { attempts: { failed: 1 }, enabled_webhooks: 2, disabled_webhooks: 1 },
        automations: {},
        logs: { count: 900, last_seen_at: "2026-09-30T00:00:00.000Z" },
      },
    });
    show(h(Usage), "/settings/usage");
    await screen.findByText("emails.sent");
    expect(calls(fetch)).toEqual(expect.arrayContaining(["GET /usage?limit=100", "GET /system"]));
    expect(screen.getByText("12,345")).toBeTruthy();
    expect(await screen.findByText("fake")).toBeTruthy();
    expect(screen.getByText("Queued 3")).toBeTruthy();
    expect(screen.getByText("2 enabled, 1 disabled")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText(/Could not read the provider's sending limits/)).toBeTruthy();
  });

  it("shows the 24-hour quota, the send rate, the region, and a sandbox badge", async () => {
    stubApi({
      "GET /usage/summary": summary(),
      "GET /usage": list([]),
      "GET /system": {
        object: "system",
        ok: true,
        provider: "ses",
        worker: { backlog: {}, concurrency: 5 },
        webhooks: { attempts: {} },
        automations: {},
        logs: null,
        sending: { region: "eu-west-1", max_24_hour: 50000, max_per_second: 14, sent_24_hour: 40000, sandbox: true },
        smtp: { host: null, port: 587, tls_port: 465 },
      },
    });
    show(h(Usage), "/settings/usage");
    expect(await screen.findByText("40,000 of 50,000")).toBeTruthy();
    expect(screen.getByText("14 per second")).toBeTruthy();
    expect(screen.getByText("Ireland")).toBeTruthy();
    expect(screen.getByText("Sandbox")).toBeTruthy();
    const meter = screen.getByRole("meter", { name: "24-hour quota used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("80");
    expect(meter.className).toContain("warning");
  });

  it("shows a failure for the system panel", async () => {
    stubApi({ "GET /usage/summary": summary(), "GET /usage": list([]), "GET /system": new Status(500, { name: "application_error", message: "Boom" }) });
    show(h(Usage), "/settings/usage");
    expect((await screen.findAllByText("Boom")).length).toBeGreaterThan(0);
    const quota = screen.getByRole("heading", { name: "AWS account sending quota" }).closest("section")!;
    expect(within(quota).getByText("Boom")).toBeTruthy();
    expect(screen.getByText(/No usage yet/)).toBeTruthy();
  });
  it("shows monthly recipients, a sub-cent estimate, and requests another UTC month", async () => {
    const fetch = stubApi({ "GET /usage/summary": summary(), "GET /usage": list([]), "GET /system": new Status(500, { message: "Unavailable" }) });
    show(h(Usage), "/settings/usage");
    expect(await screen.findByText("<$0.01")).toBeTruthy();
    expect(screen.getByLabelText("2026-10-01: 2 recipients, 120 API requests")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Month (UTC)"), { target: { value: "2026-09" } });
    await waitFor(() => expect(calls(fetch)).toContain("GET /usage/summary?month=2026-09"));
    expect(screen.getByRole("heading", { name: "System details" }).closest("details")).toBeNull();
    expect(screen.getByRole("heading", { name: "Raw usage counters" }).closest("details")).toBeNull();
    expect(screen.getByRole("heading", { name: "Daily totals" }).closest("details")).toBeNull();
    expect(screen.queryByRole("link", { name: "Send a test email" })).toBeNull();
  });

  it("discloses historical sends without recipient measurements", async () => {
    stubApi({ "GET /usage/summary": { ...summary(), unmeasured_sends: 3 }, "GET /usage": list([]), "GET /system": new Status(500, { message: "Unavailable" }) });
    show(h(Usage), "/settings/usage");
    expect(await screen.findByText(/3 older sends have no recorded recipient count/)).toBeTruthy();
  });

  it("distinguishes zero, sub-cent, and ordinary cost estimates", () => {
    expect(estimateLabel(0)).toBe("$0.00");
    expect(estimateLabel(0.0001)).toBe("<$0.01");
    expect(estimateLabel(0.01)).toBe("$0.01");
    expect(estimateLabel(1.23)).toBe("$1.23");
  });

});

describe("quotaShare", () => {
  it("keeps tiny nonzero shares and caps at 100", () => {
    expect(quotaShare({ max_24_hour: 200, sent_24_hour: 1 })).toBe(0.5);
    expect(quotaShare({ max_24_hour: 10, sent_24_hour: 20 })).toBe(100);
    expect(quotaShare({ max_24_hour: 0, sent_24_hour: 0 })).toBe(0);
    expect(quotaShare({ max_24_hour: 50000, sent_24_hour: 1 })).toBe(0.002);
    expect(quotaLabel(0.002)).toBe("<0.1%");
    expect(quotaLabel(0)).toBe("0%");
  });
});
