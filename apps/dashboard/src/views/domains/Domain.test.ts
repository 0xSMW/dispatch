// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { api, requests, visit } from "../emails/visit";
import { Domain, verification } from "./Domain";
import { domain } from "./fixtures";

describe("Domain", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("opens a pending domain on Records and marks wrong values after Doctor", async () => {
    const fetch = api({
      "/domains/domain_1": domain(),
      "/domains/domain_1/doctor": {
        domain: "domain_1",
        checks: [
          { name: "_dmarc.send.acme.test", type: "TXT", record: "DMARC", expected: "v=DMARC1; p=none;", found: "v=DMARC1; p=reject;", status: "mismatch", message: "Found v=DMARC1; p=reject; instead" },
          { name: "abc._domainkey.send.acme.test", type: "CNAME", record: "DKIM", expected: "abc.dkim.amazonses.com", found: "abc.dkim.amazonses.com", status: "ok", message: "OK" },
        ],
      },
    });
    visit(h(Domain), "/domains/domain_1", "/domains/:id");

    expect(await screen.findByRole("heading", { name: "send.acme.test" })).toBeTruthy();
    // No DNS host has been read for this domain yet.
    expect(screen.getByText("Not detected")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Records" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Receiving records" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Tracking records" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Doctor/ }));
    expect(await screen.findByText("Found v=DMARC1; p=reject; instead")).toBeTruthy();
    expect(requests(fetch, "GET", "/domains/domain_1/doctor")).toHaveLength(1);
    const dmarc = screen.getByRole("region", { name: "DMARC records" });
    expect(within(dmarc).getByText("mismatch")).toBeTruthy();
  });

  it("shows where the domain's DNS is hosted", async () => {
    api({ "/domains/domain_1": { ...domain(), dns_provider: "Cloudflare" } });
    visit(h(Domain), "/domains/domain_1", "/domains/:id");
    expect(await screen.findByText("Cloudflare")).toBeTruthy();
    expect(screen.getByText("Provider")).toBeTruthy();
  });

  it("opens a verified domain on Configuration and saves toggles with PATCH", async () => {
    const verified = domain({ status: "verified" });
    const fetch = api({
      "/domains/domain_1": verified,
      "PATCH /domains/domain_1": (_url: URL, init: RequestInit) => ({ body: { ...verified, ...JSON.parse(String(init.body)) } }),
    });
    visit(h(Domain), "/domains/domain_1", "/domains/:id");

    await screen.findByRole("heading", { name: "send.acme.test" });
    expect(screen.getByRole("tab", { name: "Configuration" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: /Click tracking/ }));
    await waitFor(() => expect(requests(fetch, "PATCH", "/domains/domain_1")[0]?.body).toEqual({ click_tracking: true }));
    await waitFor(() => expect(screen.getByRole("switch", { name: /Click tracking/ }).getAttribute("aria-checked")).toBe("true"));

    fireEvent.change(screen.getByLabelText("TLS"), { target: { value: "enforced" } });
    await waitFor(() => expect(requests(fetch, "PATCH", "/domains/domain_1")[1]?.body).toEqual({ tls: "enforced" }));

    fireEvent.click(screen.getByRole("switch", { name: /Receiving/ }));
    await waitFor(() => expect(requests(fetch, "PATCH", "/domains/domain_1")[2]?.body).toEqual({ capabilities: { receiving: "enabled" } }));
  });

  it("deletes the domain after typing its name and goes back to the list", async () => {
    const fetch = api({ "/domains/domain_1": domain(), "DELETE /domains/domain_1": { object: "domain", id: "domain_1", deleted: true } });
    visit(h(Domain), "/domains/domain_1", "/domains/:id");
    await screen.findByRole("heading", { name: "send.acme.test" });

    fireEvent.click(screen.getByRole("button", { name: "Domain actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete domain" }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "send.acme.test" } });
    fireEvent.click(screen.getByRole("button", { name: /^Delete domain/ }));

    expect((await screen.findByTestId("location")).textContent).toBe("/domains");
    expect(requests(fetch, "DELETE", "/domains/domain_1")).toHaveLength(1);
  });

  it("colors the verification steps by status", () => {
    const steps = (status: string) => verification({ status, created_at: "2026-09-30T10:00:00.000Z", checked_at: null }).map((step) => step.variant);
    expect(steps("not_started")).toEqual(["success", "info", "neutral", "neutral", "neutral"]);
    expect(steps("pending")).toEqual(["success", "success", "info", "neutral", "neutral"]);
    expect(steps("failed")).toEqual(["success", "danger", "neutral", "neutral", "neutral"]);
    expect(steps("verified")).toEqual(["success", "success", "success", "success", "success"]);
  });
});
