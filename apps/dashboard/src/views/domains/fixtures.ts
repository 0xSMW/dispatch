// Shared domain fixtures for the domains page tests.
import type { Domain, DomainRecord } from "../../types";

export const records: DomainRecord[] = [
  { record: "DKIM", name: "abc._domainkey.send", type: "CNAME", value: "abc.dkim.amazonses.com", status: "verified", ttl: "Auto" },
  { record: "SPF", name: "send.send", type: "MX", value: "feedback-smtp.us-east-1.amazonses.com", status: "pending", ttl: "Auto", priority: 10 },
  { record: "SPF", name: "send.send", type: "TXT", value: "v=spf1 include:amazonses.com ~all", status: "pending", ttl: "Auto" },
  { record: "DMARC", name: "_dmarc.send", type: "TXT", value: "v=DMARC1; p=none;", status: "pending", ttl: "Auto" },
  { record: "Tracking", name: "links.send", type: "CNAME", value: "links.localhost", status: "pending", ttl: "Auto" },
];

export const domain = (patch: Partial<Domain> = {}): Domain => ({
  object: "domain",
  id: "domain_1",
  name: "send.acme.test",
  status: "pending",
  region: "us-east-1",
  created_at: "2026-09-30T10:00:00.000Z",
  custom_return_path: "send",
  open_tracking: false,
  click_tracking: false,
  tracking_subdomain: "links",
  tls: "opportunistic",
  capabilities: { sending: "enabled", receiving: "disabled" },
  records,
  checked_at: "2026-09-30T10:05:00.000Z",
  ...patch,
});
