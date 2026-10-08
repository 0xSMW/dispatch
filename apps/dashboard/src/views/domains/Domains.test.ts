// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { api, list, requests, visit } from "../emails/visit";
import { Domains } from "./Domains";
import { domain } from "./fixtures";

describe("Domains", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists domains with status and region city", async () => {
    const fetch = api({ "/domains": list([domain(), domain({ id: "domain_2", name: "mail.acme.test", status: "verified", region: "eu-west-1" })]) });
    visit(h(Domains), "/domains");
    expect(await screen.findByText("send.acme.test")).toBeTruthy();
    expect(screen.getByText("North Virginia")).toBeTruthy();
    expect(screen.getByText("Ireland")).toBeTruthy();
    expect(screen.getAllByText("Verified").find((node) => node.classList.contains("badge"))?.className).toContain("success");
    expect(requests(fetch, "GET", "/domains")[0].url.searchParams.get("limit")).toBe("40");
    const learn = within(screen.getByRole("navigation", { name: "Learn more" }));
    expect(learn.getByRole("link", { name: "DNS records" }).getAttribute("href")).toContain("domains.md#dns-records");
    expect(learn.getByRole("link", { name: "Route 53" }).getAttribute("href")).toContain("domains.md#route-53");
    expect(learn.getByRole("link", { name: "Deliverability" }).getAttribute("href")).toContain("deliverability/README.md");
  });

  it("sends search, status, and region from the URL", async () => {
    const fetch = api({ "/domains": list([domain()]) });
    visit(h(Domains), "/domains?q=acme&status=verified&region=eu-west-1");
    await screen.findByText("send.acme.test");
    const url = requests(fetch, "GET", "/domains")[0].url;
    expect(url.searchParams.get("q")).toBe("acme");
    expect(url.searchParams.get("status")).toBe("verified");
    expect(url.searchParams.get("region")).toBe("eu-west-1");
    fireEvent.click(screen.getByRole("combobox", { name: "Regions" }));
    expect(screen.getByRole("option", { name: "Ireland (eu-west-1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeTruthy();
  });

  it("deletes the selected domains one by one after typing the phrase", async () => {
    const fetch = api({
      "/domains": list([domain(), domain({ id: "domain_2", name: "mail.acme.test" })]),
      "DELETE /domains/domain_1": { object: "domain", id: "domain_1", deleted: true },
      "DELETE /domains/domain_2": { object: "domain", id: "domain_2", deleted: true },
    });
    visit(h(Domains), "/domains");
    await screen.findByText("send.acme.test");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Bulk actions" })).getByRole("button", { name: /Delete/ }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "DELETE 2 DOMAINS" } });
    fireEvent.click(screen.getByRole("button", { name: /^Delete domains/ }));

    await waitFor(() => expect(requests(fetch, "DELETE", "/domains/domain_2")).toHaveLength(1));
    expect(requests(fetch, "DELETE", "/domains/domain_1")).toHaveLength(1);
    await waitFor(() => expect(requests(fetch, "GET", "/domains")).toHaveLength(2));
  });

  it("opens delete for the selection with the backspace key", async () => {
    api({ "/domains": list([domain()]) });
    visit(h(Domains), "/domains");
    await screen.findByText("send.acme.test");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row" }));
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(screen.getByRole("dialog", { name: "Delete domain" })).toBeTruthy();
  });
});
