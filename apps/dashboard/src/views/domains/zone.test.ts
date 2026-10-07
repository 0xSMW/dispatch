import { describe, expect, it } from "vitest";
import type { DomainRecord } from "../../types";
import { domain } from "./fixtures";
import { toZone } from "./zone";

describe("toZone", () => {
  it("exports realistic SES API records, including receiving and tracking", () => {
    // Matches provider-ses dnsRecords and the relative names returned by presentDomain.
    const records: DomainRecord[] = [
      ...["aaa", "bbb", "ccc"].map((token) => ({
        record: "DKIM", name: `${token}._domainkey`, type: "CNAME", value: `${token}.dkim.amazonses.com`, status: "pending", ttl: "Auto",
      })),
      { record: "SPF", name: "bounce", type: "MX", value: "feedback-smtp.eu-west-1.amazonses.com", status: "pending", ttl: "Auto", priority: 10 },
      { record: "SPF", name: "bounce", type: "TXT", value: "v=spf1 include:amazonses.com ~all", status: "pending", ttl: "Auto" },
      { record: "DMARC", name: "_dmarc", type: "TXT", value: "v=DMARC1; p=none;", status: "pending", ttl: "Auto" },
      { record: "Tracking", name: "click", type: "CNAME", value: "track.dispatch.test", status: "pending", ttl: "Auto" },
      { record: "Receiving MX", name: "@", type: "MX", value: "inbound-smtp.eu-west-1.amazonaws.com", status: "pending", ttl: "Auto", priority: 10 },
    ];
    const row = domain({ name: "mail.acme.test", records });
    const zone = toZone(row);
    expect(zone).toBe([
      "$ORIGIN mail.acme.test.",
      "$TTL 300",
      "aaa._domainkey.mail.acme.test. 300 IN CNAME aaa.dkim.amazonses.com.",
      "bbb._domainkey.mail.acme.test. 300 IN CNAME bbb.dkim.amazonses.com.",
      "ccc._domainkey.mail.acme.test. 300 IN CNAME ccc.dkim.amazonses.com.",
      "bounce.mail.acme.test. 300 IN MX 10 feedback-smtp.eu-west-1.amazonses.com.",
      'bounce.mail.acme.test. 300 IN TXT "v=spf1 include:amazonses.com ~all"',
      '_dmarc.mail.acme.test. 300 IN TXT "v=DMARC1; p=none;"',
      "click.mail.acme.test. 300 IN CNAME track.dispatch.test.",
      "mail.acme.test. 300 IN MX 10 inbound-smtp.eu-west-1.amazonaws.com.",
      "",
    ].join("\n"));
    // The same full names in storage must not acquire a second copy of the origin.
    expect(toZone({
      name: row.name,
      records: records.map((record) => ({ ...record, name: record.name === "@" ? row.name : `${record.name}.${row.name}` })),
    })).toBe(zone);
    expect(zone).not.toMatch(/\b(?:SOA|NS)\b/);
  });

  it("uses dashboard records exactly, even when tracking is off", () => {
    const row = domain();
    const zone = toZone(row);
    expect(zone).toContain("abc._domainkey.send.send.acme.test. 300 IN CNAME abc.dkim.amazonses.com.\n");
    expect(zone).toContain("send.send.send.acme.test. 300 IN MX 10 feedback-smtp.us-east-1.amazonses.com.\n");
    expect(zone).toContain("links.send.send.acme.test. 300 IN CNAME links.localhost.\n");
    expect(zone.split("\n")).toHaveLength(row.records.length + 3);
  });

  it("handles apex, relative and absolute names, explicit TTLs and MX priorities", () => {
    expect(toZone({
      name: "acme.test.",
      records: [
        { name: "@", type: "MX", value: "inbound.example.net.", priority: 20, ttl: "3600" },
        { name: "bounce", type: "MX", value: "feedback.example.net", priority: 5, ttl: "1h" },
        { name: "DKIM._domainkey.ACME.TEST", type: "CNAME", value: "selector.example.net." },
        { name: "outside.example.net.", type: "CNAME", value: "target.example.net", ttl: "Auto" },
      ],
    })).toBe([
      "$ORIGIN acme.test.",
      "$TTL 300",
      "acme.test. 3600 IN MX 20 inbound.example.net.",
      "bounce.acme.test. 1h IN MX 5 feedback.example.net.",
      "DKIM._domainkey.ACME.TEST. 300 IN CNAME selector.example.net.",
      "outside.example.net. 300 IN CNAME target.example.net.",
      "",
    ].join("\n"));
  });

  it("quotes TXT without losing quotes, backslashes, semicolons or control bytes", () => {
    const zone = toZone({ name: "acme.test", records: [{ name: "_test", type: "TXT", value: 'a"b\\c;d\n\r\t\0' }] });
    expect(zone).toContain('_test.acme.test. 300 IN TXT "a\\"b\\\\c;d\\010\\013\\009\\000"\n');
    expect(toZone({ name: "acme.test", records: [{ name: "@", type: "TXT", value: "" }] })).toContain('IN TXT ""\n');
  });

  it("chunks long TXT by decoded UTF-8 byte length and preserves every byte", () => {
    const value = `v=DKIM1; p=${"a".repeat(500)}${"é🙂".repeat(90)}`;
    const zone = toZone({ name: "acme.test", records: [{ name: "selector._domainkey", type: "TXT", value }] });
    const chunks = zone.match(/"([^"]*)"/g)!;
    expect(chunks.length).toBeGreaterThan(2);
    const decoded = chunks.map((chunk) => Array.from(chunk.slice(1, -1).matchAll(/\\(\d{3})|([^\\])/g), (match) => match[1] ? Number(match[1]) : match[2]!.charCodeAt(0)));
    expect(decoded.every((chunk) => chunk.length <= 255)).toBe(true);
    expect(decoded[0]).toHaveLength(255);
    expect(decoded.flat()).toEqual(Array.from(new TextEncoder().encode(value)));
    expect(zone.split("\n").filter((line) => line.includes(" IN TXT "))).toHaveLength(1);
  });

  it("escapes owner and target tokens so punctuation cannot inject zone directives", () => {
    const zone = toZone({ name: "acme.test", records: [{ name: "a b;$INCLUDE", type: "CNAME", value: "x\nexample.net" }] });
    expect(zone).toContain("a\\032b\\059\\036INCLUDE.acme.test. 300 IN CNAME x\\010example.net.\n");
  });
});
