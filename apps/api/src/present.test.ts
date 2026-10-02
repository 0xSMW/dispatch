import { describe, expect, it } from "vitest";
import { presentDomain, presentEmail } from "./present.js";

describe("presentEmail", () => {
  it("returns a flat email with a display name, tag array, and last_event", () => {
    const email = presentEmail({
      id: "email_1",
      message_id: null,
      from_email: "hello@example.com",
      from_name: "Acme",
      created_at: "2026-10-01T00:00:00.000Z",
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      reply_to: ["ada@example.com"],
      status: "cancelled",
      scheduled_at: null,
      tags: { category: "welcome" },
      recipients: [
        { email: "you@example.net", kind: "to" },
        { email: "cc@example.net", kind: "cc" },
        { email: "bcc@example.net", kind: "bcc" },
      ],
    });

    expect(email).toMatchObject({
      object: "email",
      id: "email_1",
      from: "Acme <hello@example.com>",
      to: ["you@example.net"],
      cc: ["cc@example.net"],
      bcc: ["bcc@example.net"],
      reply_to: ["ada@example.com"],
      last_event: "canceled",
      tags: [{ name: "category", value: "welcome" }],
    });
    expect(email).not.toHaveProperty("recipients");
  });
});

describe("presentDomain", () => {
  it("uses Resend field names and strips the domain from record names", () => {
    const domain = presentDomain({
      id: "domain_1",
      name: "example.com",
      region: "us-east-1",
      status: "not_started",
      created_at: "2026-10-01T00:00:00.000Z",
      return_path: "send",
      open_tracking: false,
      click_tracking: true,
      tracking_subdomain: "links",
      tls: "enforced",
      sending: "enabled",
      receiving: "disabled",
      records: [
        { record: "DKIM", name: "tok._domainkey.example.com", type: "CNAME", value: "tok.dkim.amazonses.com", status: "pending", ttl: "Auto" },
        { record: "Receiving MX", name: "example.com", type: "MX", value: "inbound-smtp.us-east-1.amazonaws.com", status: "pending", ttl: "Auto", priority: 10 },
      ],
    });
    expect(domain).toMatchObject({
      object: "domain",
      custom_return_path: "send",
      open_tracking: false,
      click_tracking: true,
      tls: "enforced",
      capabilities: { sending: "enabled", receiving: "disabled" },
    });
    expect(domain.records.map((record) => record.name)).toEqual(["tok._domainkey", "@"]);
  });
});
