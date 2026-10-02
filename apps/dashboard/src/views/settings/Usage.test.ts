// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { calls, list, show, Status, stubApi } from "../audience/stub";
import { quotaShare, Usage } from "./Usage";

describe("Usage", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows usage counters and system state", async () => {
    const fetch = stubApi({
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
    expect(screen.getByText("queued 3")).toBeTruthy();
    expect(screen.getByText("2 enabled, 1 disabled")).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText(/Could not read the provider's sending limits/)).toBeTruthy();
  });

  it("shows the 24-hour quota, the send rate, the region, and a sandbox badge", async () => {
    stubApi({
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
    stubApi({ "GET /usage": list([]), "GET /system": new Status(500, { name: "application_error", message: "Boom" }) });
    show(h(Usage), "/settings/usage");
    expect(await screen.findByText("Boom")).toBeTruthy();
    expect(screen.getByText(/No usage yet/)).toBeTruthy();
  });
});

describe("quotaShare", () => {
  it("rounds to one decimal and caps at 100", () => {
    expect(quotaShare({ max_24_hour: 200, sent_24_hour: 1 })).toBe(0.5);
    expect(quotaShare({ max_24_hour: 10, sent_24_hour: 20 })).toBe(100);
    expect(quotaShare({ max_24_hour: 0, sent_24_hour: 0 })).toBe(0);
  });
});
