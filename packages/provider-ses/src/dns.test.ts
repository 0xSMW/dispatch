import { describe, expect, it } from "vitest";
import { dnsProvider } from "./dns.js";

const none = { resolveCname: async () => [], resolveMx: async () => [], resolveTxt: async () => [] };

describe("dnsProvider", () => {
  it("names the DNS host from the zone's name servers", async () => {
    const zones: Record<string, string[]> = {
      "acme.com": ["ns-12.awsdns-01.com", "ns-800.awsdns-36.net"],
      "example.org": ["Ada.NS.Cloudflare.com.", "bob.ns.cloudflare.com."],
      "shop.io": ["ns1.unknown-host.example"],
    };
    const resolveNs = async (host: string) => {
      if (!zones[host]) throw new Error("ENODATA");
      return zones[host];
    };
    const resolvers = { ...none, resolveNs };
    expect(await dnsProvider("acme.com", resolvers)).toBe("Route 53");
    // A subdomain has no name servers of its own: the zone above it answers.
    expect(await dnsProvider("mail.example.org", resolvers)).toBe("Cloudflare");
    expect(await dnsProvider("shop.io", resolvers)).toBeNull();
    expect(await dnsProvider("nothing.test", resolvers)).toBeNull();
  });

  it("is null when no name server lookup is available", async () => {
    expect(await dnsProvider("acme.com", none)).toBeNull();
  });
});
