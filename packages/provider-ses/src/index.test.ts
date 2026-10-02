import { CreateEmailIdentityCommand, GetAccountCommand, GetEmailIdentityCommand, PutEmailIdentityMailFromAttributesCommand, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ChangeResourceRecordSetsCommand, ListHostedZonesByNameCommand, ListResourceRecordSetsCommand } from "@aws-sdk/client-route-53";
import { describe, expect, it, vi } from "vitest";
import { ProviderError, type ProviderEmail } from "@dispatchmail/core";
import { checkRecords } from "./dns.js";
import { createIdentity, readIdentity } from "./identity.js";
import { canReceive, combineDomainStatus, dnsRecords, planDomainUpdate } from "./records.js";
import { publishRoute53 } from "./route53.js";
import { createSesProvider } from "./send.js";

const email = (): ProviderEmail => ({
  id: "email_1",
  tenant_id: "tenant_1",
  from: "Ada <ada@example.com>",
  recipients: [
    { email: "one@example.com", kind: "to" },
    { email: "two@example.com", kind: "cc" }
  ],
  reply_to: ["reply@example.com"],
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
  headers: { "X-Dispatch": "yes" },
  attachments: [],
  region: "us-east-1",
  tls: "enforced"
});

describe("dns records", () => {
  it("builds Easy DKIM CNAMEs, MAIL FROM, and a receiving MX only where SES can receive", () => {
    const records = dnsRecords({ name: "example.com", region: "eu-west-1", tokens: ["aaa", "bbb", "ccc"], receiving: true });
    expect(records.filter((record) => record.record === "DKIM")).toEqual([
      expect.objectContaining({ name: "aaa._domainkey.example.com", value: "aaa.dkim.amazonses.com", type: "CNAME" }),
      expect.objectContaining({ name: "bbb._domainkey.example.com", value: "bbb.dkim.amazonses.com" }),
      expect.objectContaining({ name: "ccc._domainkey.example.com", value: "ccc.dkim.amazonses.com" })
    ]);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ record: "SPF", type: "MX", name: "send.example.com", value: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 }),
      expect.objectContaining({ record: "SPF", type: "TXT", value: "v=spf1 include:amazonses.com ~all" }),
      expect.objectContaining({ record: "Receiving MX", value: "inbound-smtp.eu-west-1.amazonaws.com", priority: 10 })
    ]));
    expect(canReceive("us-east-1")).toBe(true);
    expect(canReceive("us-gov-west-1")).toBe(false);
    expect(() => dnsRecords({ name: "example.com", region: "us-gov-west-1", tokens: ["aaa"], receiving: true })).toThrow(/cannot receive/);
  });

  it("fails a domain that stays pending for 72 hours and marks a split sending and receiving setup partial", () => {
    const started = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
    const failed = planDomainUpdate({
      records: dnsRecords({ name: "example.com", region: "us-east-1", tokens: ["aaa"] }),
      dkimStatus: "PENDING",
      sendingEnabled: true,
      receivingEnabled: false,
      receivingVerified: false,
      verifyStartedAt: started,
      now: Date.now()
    });
    expect(failed.status).toBe("failed");
    const partial = planDomainUpdate({
      records: [],
      dkimStatus: "SUCCESS",
      sendingEnabled: true,
      receivingEnabled: true,
      receivingVerified: false,
      verifyStartedAt: new Date().toISOString(),
      now: Date.now()
    });
    expect(partial.status).toBe("partially_verified");
  });

  it("marks each record from its own DNS check, and DKIM from SES", () => {
    const records = dnsRecords({ name: "example.com", region: "us-east-1", tokens: ["aaa"], trackingHost: "t.dispatch.dev" });
    const plan = planDomainUpdate({
      records,
      checks: [
        { name: "send.example.com", type: "MX", status: "ok" },
        { name: "send.example.com", type: "TXT", status: "missing" },
        { name: "_dmarc.example.com", type: "TXT", status: "ok" },
        { name: "links.example.com", type: "CNAME", status: "missing" }
      ],
      dkimStatus: "SUCCESS",
      sendingEnabled: true,
      receivingEnabled: false,
      receivingVerified: false,
      verifyStartedAt: new Date().toISOString(),
      now: Date.now()
    });
    expect(plan.status).toBe("verified");
    const status = (record: string, type: string) => plan.records.find((item) => item.record === record && item.type === type)?.status;
    expect(status("DKIM", "CNAME")).toBe("verified");
    expect(status("SPF", "MX")).toBe("verified");
    expect(status("SPF", "TXT")).toBe("pending");
    expect(status("DMARC", "TXT")).toBe("verified");
    expect(status("Tracking", "CNAME")).toBe("pending");
  });

  it("uses the receiving status for a domain that only receives", () => {
    expect(combineDomainStatus({ sendingStatus: "pending", receivingStatus: "verified", sendingEnabled: false, receivingEnabled: true })).toBe("verified");
    expect(combineDomainStatus({ sendingStatus: "verified", receivingStatus: "pending", sendingEnabled: false, receivingEnabled: true })).toBe("pending");
  });
});

describe("dns checks", () => {
  it("reports the value found in DNS next to the expected value", async () => {
    const records = dnsRecords({ name: "example.com", region: "us-east-1", tokens: ["aaa"] });
    const checks = await checkRecords(records, {
      resolveCname: async (host) => (host.startsWith("aaa.") ? ["aaa.dkim.amazonses.com"] : ["wrong.example.net"]),
      resolveMx: async () => [{ exchange: "feedback-smtp.us-east-1.amazonses.com", priority: 10 }],
      resolveTxt: async (host) => (host.startsWith("_dmarc") ? [["v=DMARC1; p=none;"]] : [["v=spf1 include:example.net ~all"]])
    });
    expect(checks.find((check) => check.record === "DKIM")).toMatchObject({ status: "ok", found: "aaa.dkim.amazonses.com" });
    expect(checks.find((check) => check.record === "Tracking")).toMatchObject({ status: "mismatch", found: "wrong.example.net" });
    expect(checks.find((check) => check.type === "TXT" && check.record === "SPF")?.message).toMatch(/expects/);
  });

  it("accepts the owner's stricter DMARC policy and an SPF record that lists other senders", async () => {
    const records = dnsRecords({ name: "example.com", region: "us-east-1", tokens: ["aaa"] });
    const checks = await checkRecords(records, {
      resolveCname: async () => [],
      resolveMx: async () => [],
      resolveTxt: async (host) =>
        host.startsWith("_dmarc")
          ? [["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"]]
          : [["v=spf1 include:_spf.google.com include:amazonses.com -all"]]
    });
    expect(checks.find((check) => check.record === "DMARC")).toMatchObject({ status: "ok", found: "v=DMARC1; p=reject; rua=mailto:dmarc@example.com" });
    expect(checks.find((check) => check.type === "TXT" && check.record === "SPF")).toMatchObject({ status: "ok" });
  });
});

describe("ses identity", () => {
  it("creates an identity, sets MAIL FROM, and reads DKIM status", async () => {
    const sent: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command);
        if (command instanceof CreateEmailIdentityCommand) return { DkimAttributes: { Tokens: ["t1", "t2", "t3"] } };
        if (command instanceof GetEmailIdentityCommand) {
          return { DkimAttributes: { Status: "SUCCESS" }, MailFromAttributes: { MailFromDomainStatus: "SUCCESS" }, VerifiedForSendingStatus: true };
        }
        return {};
      })
    };
    await expect(createIdentity(client, { name: "example.com", mailFromDomain: "send.example.com" })).resolves.toEqual(["t1", "t2", "t3"]);
    expect(sent[0]).toBeInstanceOf(CreateEmailIdentityCommand);
    expect((sent[0] as CreateEmailIdentityCommand).input).toMatchObject({ EmailIdentity: "example.com", ConfigurationSetName: "dispatch-default" });
    expect(sent[1]).toBeInstanceOf(PutEmailIdentityMailFromAttributesCommand);
    expect((sent[1] as PutEmailIdentityMailFromAttributesCommand).input.BehaviorOnMxFailure).toBe("USE_DEFAULT_VALUE");
    await expect(readIdentity(client, "example.com")).resolves.toEqual({
      dkimStatus: "SUCCESS",
      mailFromStatus: "SUCCESS",
      verifiedForSending: true
    });
  });
});

describe("ses send", () => {
  it("tags the message, picks the TLS configuration set, and caches quota", async () => {
    const sent: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command);
        if (command instanceof GetAccountCommand) {
          return { SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 3 }, ProductionAccessEnabled: false };
        }
        return { MessageId: "sesmsg" };
      })
    };
    let clock = 1_000;
    const provider = createSesProvider({ clientFor: () => client, now: () => clock });
    const result = await provider.send(email());
    expect(result).toMatchObject({
      provider_message_id: "sesmsg",
      message_id: "<sesmsg@us-east-1.amazonses.com>",
      events: [expect.objectContaining({ type: "email.sent", provider_event_id: "sesmsg:sent" })]
    });
    const command = sent[0] as SendEmailCommand;
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input.ConfigurationSetName).toBe("dispatch-tls-required");
    expect(command.input.EmailTags).toEqual([
      { Name: "dispatch_email_id", Value: "email_1" },
      { Name: "dispatch_tenant_id", Value: "tenant_1" }
    ]);
    expect(command.input.Content?.Simple?.Subject?.Data).toBe("Hello");
    await expect(provider.quota("us-east-1")).resolves.toEqual({ max_24_hour: 200, max_per_second: 1, sent_24_hour: 3, sandbox: true });
    clock += 1_000;
    await provider.quota("us-east-1");
    expect(sent.filter((command) => command instanceof GetAccountCommand)).toHaveLength(1);
    clock += 61_000;
    await provider.quota("us-east-1");
    expect(sent.filter((command) => command instanceof GetAccountCommand)).toHaveLength(2);
  });

  it("sends raw MIME when the email has an attachment and fails a rejected message at once", async () => {
    const sent: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command);
        return { MessageId: "rawmsg" };
      })
    };
    const provider = createSesProvider({ clientFor: () => client });
    const withFile = email();
    withFile.tls = "opportunistic";
    withFile.attachments = [{ filename: "note.txt", content_type: "text/plain", disposition: "attachment", bytes: Buffer.from("hello") }];
    await provider.send(withFile);
    const raw = (sent[0] as SendEmailCommand).input.Content?.Raw?.Data;
    expect(Buffer.from(raw as Uint8Array).toString("utf8")).toContain("note.txt");
    expect((sent[0] as SendEmailCommand).input.ConfigurationSetName).toBe("dispatch-default");

    const rejecting = createSesProvider({
      clientFor: () => ({
        send: async () => {
          const error = new Error("rejected") as Error & { name: string };
          error.name = "MessageRejected";
          throw error;
        }
      })
    });
    await expect(rejecting.send(email())).rejects.toBeInstanceOf(ProviderError);
    await expect(rejecting.send(email())).rejects.toMatchObject({ retryable: false, reason: "MessageRejected" });
  });
});

describe("ses addresses", () => {
  it("quotes and encodes display names for the SES header fields", async () => {
    const sent: unknown[] = [];
    const provider = createSesProvider({
      clientFor: () => ({
        send: async (command: unknown) => {
          sent.push(command);
          return { MessageId: "m1" };
        }
      })
    });
    await provider.send({ ...email(), from: "Acme, Inc <hello@example.com>", reply_to: ["José <jose@example.com>", "plain@example.com"] });
    const input = (sent[0] as SendEmailCommand).input;
    expect(input.FromEmailAddress).toBe('"Acme, Inc" <hello@example.com>');
    expect(input.ReplyToAddresses).toEqual([`=?UTF-8?B?${Buffer.from("José").toString("base64")}?= <jose@example.com>`, "plain@example.com"]);
  });
});

describe("route 53", () => {
  it("upserts the records into the hosted zone SES would publish", async () => {
    const sent: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command);
        if (command instanceof ListHostedZonesByNameCommand) return { HostedZones: [{ Id: "/hostedzone/Z1", Name: "example.com." }] };
        return {};
      })
    };
    const records = dnsRecords({ name: "example.com", region: "us-east-1", tokens: ["aaa"], trackingHost: "t.dispatch.dev" });
    await expect(publishRoute53(client, { name: "example.com", records })).resolves.toEqual({ hosted_zone_id: "/hostedzone/Z1", changes: records.length, skipped: [] });
    const change = sent.find((command) => command instanceof ChangeResourceRecordSetsCommand) as ChangeResourceRecordSetsCommand;
    expect(change.input.HostedZoneId).toBe("/hostedzone/Z1");
    const mx = change.input.ChangeBatch?.Changes?.find((item) => item.ResourceRecordSet?.Type === "MX");
    expect(mx?.ResourceRecordSet?.ResourceRecords?.[0].Value).toBe("10 feedback-smtp.us-east-1.amazonses.com");
  });

  it("leaves an existing DMARC policy and existing mailboxes alone, and skips a tracking record with no host", async () => {
    const sent: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command);
        if (command instanceof ListHostedZonesByNameCommand) return { HostedZones: [{ Id: "/hostedzone/Z1", Name: "example.com." }] };
        if (command instanceof ListResourceRecordSetsCommand) {
          if (command.input.StartRecordType === "TXT") {
            return { ResourceRecordSets: [{ Name: "_dmarc.example.com.", Type: "TXT", ResourceRecords: [{ Value: "\"v=DMARC1; p=reject\"" }] }] };
          }
          return { ResourceRecordSets: [{ Name: "example.com.", Type: "MX", ResourceRecords: [{ Value: "1 aspmx.l.google.com." }] }] };
        }
        return {};
      })
    };
    const records = dnsRecords({ name: "example.com", region: "us-east-1", tokens: ["aaa"], receiving: true });
    const result = await publishRoute53(client, { name: "example.com", records });
    expect(result.skipped.map((item) => item.record).sort()).toEqual(["DMARC", "Receiving MX", "Tracking"]);
    expect(result.changes).toBe(records.length - 3);
    const change = sent.find((command) => command instanceof ChangeResourceRecordSetsCommand) as ChangeResourceRecordSetsCommand;
    const names = (change.input.ChangeBatch?.Changes ?? []).map((item) => `${item.ResourceRecordSet?.Type}:${item.ResourceRecordSet?.Name}`);
    expect(names).not.toContain("TXT:_dmarc.example.com");
    expect(names).not.toContain("MX:example.com");
  });
});
