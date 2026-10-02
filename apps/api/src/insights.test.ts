import { describe, expect, it, vi } from "vitest";
import { insightChecks, links, lookupDmarc, presentInsights } from "./insights.js";

const dmarc = { name: "_dmarc.send.acme.com", record: "v=DMARC1; p=quarantine" };
const domain = {
  name: "send.acme.com",
  open_tracking: true,
  click_tracking: true,
  tracking_subdomain: "links",
  records: [{ record: "Tracking", status: "verified" }],
};

const failed = (checks: ReturnType<typeof insightChecks>) => checks.filter((check) => !check.passed).map((check) => check.id);

describe("email insights", () => {
  it("passes a well-formed email from a subdomain", () => {
    const checks = insightChecks(
      { from_email: "hello@send.acme.com", html: '<a href="https://www.acme.com/a">A</a><a href="https://acme.com/b">B</a>', text: "Hi" },
      domain,
      dmarc,
    );
    expect(failed(checks)).toEqual([]);
    expect(checks.find((check) => check.id === "dmarc")?.detail).toContain("p=quarantine");
  });

  it("flags each rule that fails", () => {
    const html = `<a href="https://elsewhere.io/x">x</a><a href='https://youtu.be/abc'>v</a>${"x".repeat(103 * 1024)}`;
    const checks = insightChecks(
      { from_email: "no-reply@acme.com", html, text: "" },
      { ...domain, name: "acme.com", records: [{ record: "Tracking", status: "pending" }] },
      { name: "_dmarc.acme.com", record: null },
    );
    expect(failed(checks).sort()).toEqual(
      ["dmarc", "gmail_clip", "link_domain", "no_reply", "plain_text", "subdomain", "tracking_subdomain", "youtube_links"].sort(),
    );
    const grouped = presentInsights("email_1", checks);
    expect(grouped.needs_attention.map((item) => item.id).sort()).toEqual(["dmarc", "gmail_clip", "link_domain"]);
    expect(grouped.doing_great).toEqual([]);
  });

  it("treats tracking that is off as fine", () => {
    const checks = insightChecks({ from_email: "a@send.acme.com", html: "", text: "t" }, { ...domain, open_tracking: false, click_tracking: false, records: [] }, dmarc);
    expect(failed(checks)).toEqual([]);
  });

  it("extracts only http and https links", () => {
    expect(links('<a href="mailto:a@b.com">m</a><a href=https://acme.com/x>x</a><a href="{{{URL}}}">t</a>').map(String)).toEqual(["https://acme.com/x"]);
  });

  it("looks up DMARC on the sending domain, then the root domain", async () => {
    const resolver = vi.fn(async (name: string) => {
      if (name === "_dmarc.acme.com") return [["v=DMARC1; ", "p=reject"]];
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    });
    expect(await lookupDmarc("send.acme.com", resolver)).toEqual({ name: "_dmarc.acme.com", record: "v=DMARC1; p=reject" });
    expect(resolver).toHaveBeenNthCalledWith(1, "_dmarc.send.acme.com");
    expect(await lookupDmarc("other.io", async () => [["v=spf1 -all"]])).toEqual({ name: "_dmarc.other.io", record: null });
  });
});
