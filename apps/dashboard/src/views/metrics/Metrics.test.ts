// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { h, mockFetch, signIn } from "../../testing";
import { dateKey } from "./range";
import { Metrics, summarize } from "./Metrics";

const today = dateKey(new Date());

const totals = {
  sent: 1000,
  delivered: 950,
  bounced: 50,
  bounced_transient: 10,
  bounced_permanent: 30,
  bounced_undetermined: 0,
  complained: 2,
  unique_opened: 475,
  unique_clicked: 95,
};

function Where() {
  const location = useLocation();
  return h("p", { "data-testid": "location" }, location.search);
}

function open(path = "/metrics") {
  return render(h(MemoryRouter, { initialEntries: [path] }, h(SessionProvider, null, h(Metrics), h(Where))));
}

function api(empty = false) {
  return mockFetch((raw) => {
    const url = new URL(raw);
    if (url.pathname === "/domains") {
      return { body: { object: "list", has_more: false, data: [{ id: "domain_1", name: "acme.com" }, { id: "domain_2", name: "mail.acme.com" }] } };
    }
    const dimension = url.searchParams.get("dimensions");
    const sums = empty ? {} : totals;
    const data =
      dimension === "period"
        ? empty
          ? []
          : [{ period: today, ...totals }]
        : empty
          ? []
          : [
              { domain_id: "domain_1", domain_name: "acme.com", ...totals },
              { domain_id: null, domain_name: null, sent: 3 },
            ];
    return { body: { object: "metrics", metrics: [], dimensions: [dimension], granularity: url.searchParams.get("granularity"), totals: sums, data } };
  });
}

const metricCalls = (fetch: ReturnType<typeof api>) =>
  fetch.mock.calls.map(([url]) => new URL(String(url))).filter((url) => url.pathname === "/emails/metrics");

describe("Metrics", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("asks for the last 7 days by period and by domain, and renders tiles, charts, and the breakdown", async () => {
    const fetch = api();
    open();
    await screen.findAllByText("1,000");
    const calls = metricCalls(fetch);
    expect(calls.map((url) => url.searchParams.get("dimensions")).sort()).toEqual(["domain", "period"]);
    const query = calls[0]!.searchParams;
    expect(query.get("granularity")).toBe("daily");
    expect(query.get("timezone")).toBeTruthy();
    const days = (new Date(query.get("end_date")!).getTime() - new Date(query.get("start_date")!).getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThanOrEqual(7);
    expect(query.get("domain_id")).toBeNull();

    const bounced = screen.getByRole("region", { name: "Bounced" });
    expect(within(bounced).getByText("50")).toBeTruthy();
    expect(within(bounced).getByText("5.0% of sent")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Complained" })).getByText("0.21% of delivered")).toBeTruthy();
    expect(screen.getAllByLabelText("Emails by event over time").length).toBeGreaterThan(0);
    expect(screen.getByText("4% risk")).toBeTruthy();
    expect(screen.getByText("0.08% limit")).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
    expect(screen.getAllByText("acme.com").length).toBeGreaterThan(0);
  });

  it("switches to 1D hourly and filters by domain through the URL", async () => {
    const fetch = api();
    open();
    await screen.findAllByText("1,000");
    fireEvent.click(screen.getByRole("button", { name: "1D" }));
    await waitFor(() => expect(metricCalls(fetch).some((url) => url.searchParams.get("granularity") === "hourly")).toBe(true));
    expect(screen.getByTestId("location").textContent).toBe("?range=1d");

    fireEvent.click(screen.getByRole("button", { name: "All domains" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Domains" })).getByLabelText("mail.acme.com"));
    await waitFor(() => expect(metricCalls(fetch).some((url) => url.searchParams.get("domain_id") === "domain_2")).toBe(true));
    expect(screen.getByTestId("location").textContent).toContain("domain=domain_2");
  });

  it("refuses a custom range over 30 days without asking the API", async () => {
    const fetch = api();
    open("/metrics?range=custom&start=2026-01-01&end=2026-03-01");
    expect(await screen.findByText("Pick 30 days or fewer.")).toBeTruthy();
    expect(metricCalls(fetch)).toHaveLength(0);
  });

  it("shows an empty state when nothing happened in the range", async () => {
    api(true);
    open();
    expect(await screen.findByText("No email activity")).toBeTruthy();
  });
});

describe("summarize", () => {
  it("uses the API's denominators and counts untyped bounces as undetermined", () => {
    const stats = summarize({ ...totals, bounced_undetermined: 0 });
    expect(stats.undetermined).toBe(10);
    expect(stats.bounceRate).toBe(5);
    expect(stats.openRate).toBe(50);
    expect(stats.complaintRate).toBeCloseTo(0.2105, 3);
  });
});
