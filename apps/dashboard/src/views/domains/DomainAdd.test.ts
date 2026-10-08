import { changeControl } from "../../testingControls";
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { api, requests, visit } from "../emails/visit";
import { DomainAdd } from "./DomainAdd";
import { domain } from "./fixtures";

describe("DomainAdd", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("step 1 posts name, region, and return path, then step 2 shows the records", async () => {
    const fetch = api({ "POST /domains": domain(), "/domains/domain_1": domain() });
    visit(h(DomainAdd), "/domains/add");

    changeControl(screen.getByLabelText("Name"), { target: { value: " send.acme.test " } });
    changeControl(screen.getByLabelText("Region"), { target: { value: "eu-west-1" } });
    changeControl(screen.getByLabelText("Custom return path"), { target: { value: "bounce" } });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));

    await waitFor(() => expect(requests(fetch, "POST", "/domains")).toHaveLength(1));
    expect(requests(fetch, "POST", "/domains")[0].body).toEqual({ name: "send.acme.test", region: "eu-west-1", custom_return_path: "bounce" });

    expect(await screen.findByText("DNS records for send.acme.test")).toBeTruthy();
    expect(screen.getByRole("region", { name: "DKIM records" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "SPF records" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "DMARC records" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Tracking records" })).toBeNull();
    expect(screen.getByText("abc.dkim.amazonses.com")).toBeTruthy();
  });

  it("verifies and publishes to Route 53, listing skipped records with reasons", async () => {
    const fetch = api({
      "/domains/domain_1": domain(),
      "POST /domains/domain_1/verify": { object: "domain", id: "domain_1" },
      "POST /domains/domain_1/publish-route53": {
        hosted_zone_id: "/hostedzone/Z123",
        changes: 3,
        skipped: [{ name: "_dmarc.send.acme.test", type: "TXT", record: "DMARC", reason: "A different DMARC record already exists" }],
      },
    });
    visit(h(DomainAdd), "/domains/add?domain=domain_1", "/domains/add");
    await screen.findByText("DNS records for send.acme.test");

    fireEvent.click(screen.getByRole("button", { name: /Publish to Route 53/ }));
    const dialog = await screen.findByRole("dialog", { name: "Published to Route 53" });
    expect(within(dialog).getByText("A different DMARC record already exists")).toBeTruthy();
    expect(within(dialog).getByText("_dmarc.send.acme.test")).toBeTruthy();
    expect(within(dialog).getByText("3")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));

    fireEvent.click(screen.getByRole("button", { name: "Verify DNS records" }));
    await waitFor(() => expect(requests(fetch, "POST", "/domains/domain_1/verify")).toHaveLength(1));
  });
});
