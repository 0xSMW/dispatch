// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { calls, list, show, stubApi } from "../audience/stub";
import { Timeline, timelineHref } from "./Timeline";

const item = (kind: string, id: string, summary = "") => ({ kind, id, name: "x", summary, created_at: "2026-09-30T12:00:00.000Z" });

describe("Timeline", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("loads the stream and shows absolute times", async () => {
    const fetch = stubApi({
      "GET /timeline": list([{ kind: "api_log", id: "log_1", request_id: "req_1", name: "POST 200", summary: "/emails", created_at: "2026-09-30T12:00:00.000Z" }]),
    });
    show(h(Timeline), "/timeline");
    await screen.findByText("/emails");
    expect(calls(fetch)).toContain("GET /timeline?limit=40");
    expect(screen.getByText("API call")).toBeTruthy();
    expect(screen.getByText("req_1")).toBeTruthy();
    expect(screen.getByText(/Sep 30, 2026/)).toBeTruthy();
  });
});

describe("timelineHref", () => {
  it("links each kind to its page", () => {
    expect(timelineHref(item("email", "email_1"))).toBe("/emails/email_1");
    expect(timelineHref(item("email_event", "ev_1", "email_1"))).toBe("/emails/email_1");
    expect(timelineHref(item("received_email", "rcv_1"))).toBe("/emails/receiving/rcv_1");
    expect(timelineHref(item("webhook_attempt", "att_1", "wh_1"))).toBe("/webhooks/wh_1");
    expect(timelineHref(item("automation_run", "run_1", "auto_1"))).toBe("/automations/auto_1/editor?tab=runs&run=run_1");
    expect(timelineHref(item("api_log", "log_1"))).toBe("/logs/log_1");
    expect(timelineHref(item("custom_event", "evt_1"))).toBeNull();
  });

  it("preserves the selected automation run and safely encodes its identifiers", () => {
    expect(timelineHref(item("automation_run", "run/1", "auto?1"))).toBe("/automations/auto%3F1/editor?tab=runs&run=run%2F1");
    expect(timelineHref(item("automation_run", "run_1"))).toBeNull();
  });
});
