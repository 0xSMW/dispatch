import { changeControl, controlValue } from "../../testingControls";
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { h, signIn } from "../../testing";
import { api, requests, visit } from "../emails/visit";
import { Domain, verification } from "./Domain";
import { domain } from "./fixtures";
import { toZone } from "./zone";

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

  it.each(["full", "read"])("downloads the current domain's zone without API mutation for %s users", async (permission) => {
    signIn("sess_test", [permission]);
    const row = domain({ dns_provider: "Cloudflare" });
    const fetch = api({ "/domains/domain_1": row });
    const saved = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    const createObjectURL = vi.fn((_blob: Blob) => "blob:zone");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const links: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      links.push(this);
    });
    onTestFinished(() => {
      Object.assign(URL, saved);
      click.mockRestore();
    });
    visit(h(Domain), "/domains/domain_1", "/domains/:id");
    await screen.findByRole("heading", { name: row.name });
    const callsBefore = fetch.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Download zone file" }));
    expect(links[0]?.download).toBe("send.acme.test.zone");
    expect(links[0]?.href).toBe("blob:zone");
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/plain;charset=utf-8");
    const content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(content).toBe(toZone(row));
    expect(content).toContain('IN TXT "v=DMARC1; p=none;"');
    expect(content).toContain("IN CNAME links.localhost.");
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:zone"));
    expect(fetch.mock.calls).toHaveLength(callsBefore);
    if (permission === "read") {
      expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Domain actions" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Publish to Route 53/ })).toBeNull();
    }
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
    expect(screen.getByRole("button", { name: "Download zone file" })).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: /Click tracking/ }));
    await waitFor(() => expect(requests(fetch, "PATCH", "/domains/domain_1")[0]?.body).toEqual({ click_tracking: true }));
    await waitFor(() => expect(screen.getByRole("switch", { name: /Click tracking/ }).getAttribute("aria-checked")).toBe("true"));

    changeControl(screen.getByLabelText("TLS"), { target: { value: "enforced" } });
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
    changeControl(screen.getByLabelText("Confirmation phrase"), { target: { value: "send.acme.test" } });
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
