import {
  ChangeResourceRecordSetsCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
  Route53Client
} from "@aws-sdk/client-route-53";
import { ApiError } from "@dispatchmail/core";
import type { DnsRecord } from "./records.js";

export type Route53Sender = {
  send(command: unknown): Promise<{
    HostedZones?: Array<{ Id?: string; Name?: string }>;
    ResourceRecordSets?: Array<{ Name?: string; Type?: string; ResourceRecords?: Array<{ Value?: string }> }>;
  }>;
};

export type SkippedRecord = { name: string; type: string; record: string; reason: string };

const clients = new Map<string, Route53Client>();

export function route53Client(region = "us-east-1") {
  return clients.get(region) ?? clients.set(region, new Route53Client({ region })).get(region)!;
}

function recordValue(record: DnsRecord) {
  if (record.type === "MX") return `${record.priority ?? 10} ${record.value}`;
  if (record.type === "TXT") return `"${record.value}"`;
  return record.value;
}

function hostname(value?: string) {
  return (value ?? "").replace(/\.$/, "").toLowerCase();
}

async function existingValues(client: Route53Sender, zoneId: string, record: DnsRecord) {
  const listed = await client.send(new ListResourceRecordSetsCommand({
    HostedZoneId: zoneId,
    StartRecordName: record.name,
    StartRecordType: record.type,
    MaxItems: 1
  }));
  const set = (listed.ResourceRecordSets ?? [])[0];
  if (!set || set.Type !== record.type || hostname(set.Name) !== hostname(record.name)) return null;
  return (set.ResourceRecords ?? []).map((item) => item.Value ?? "");
}

// UPSERT replaces the whole record set. A DMARC policy or the root MX set usually belongs to the
// domain owner already, so those are left alone when they exist.
async function skipReason(client: Route53Sender, zoneId: string, record: DnsRecord) {
  if (record.record === "Tracking") {
    const target = hostname(record.value);
    if (!target.includes(".") || target === "localhost" || target.endsWith(".localhost")) {
      return "No tracking host is configured. Set TRACKING_DOMAIN first.";
    }
    return null;
  }
  if (record.record !== "DMARC" && record.record !== "Receiving MX") return null;
  const existing = await existingValues(client, zoneId, record);
  if (!existing || existing.length === 0) return null;
  if (record.record === "DMARC") return "The zone already has a DMARC record. It was left as it is.";
  const ours = recordValue(record).toLowerCase();
  if (existing.length === 1 && hostname(existing[0]) === hostname(ours)) return null;
  return "The zone already has MX records. Replacing them would stop mail to the existing mailboxes.";
}

export async function publishRoute53(client: Route53Sender, input: { name: string; records: DnsRecord[] }) {
  const listed = await client.send(new ListHostedZonesByNameCommand({ DNSName: input.name, MaxItems: 1 }));
  const zone = (listed.HostedZones ?? []).find((item) => item.Name === input.name || item.Name === `${input.name}.`);
  if (!zone?.Id) throw new ApiError("not_found", 404, "Hosted zone not found");
  const publish: DnsRecord[] = [];
  const skipped: SkippedRecord[] = [];
  for (const record of input.records) {
    const reason = await skipReason(client, zone.Id, record);
    if (reason) skipped.push({ name: record.name, type: record.type, record: record.record, reason });
    else publish.push(record);
  }
  if (publish.length > 0) {
    await client.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: zone.Id,
      ChangeBatch: {
        Changes: publish.map((record) => ({
          Action: "UPSERT" as const,
          ResourceRecordSet: {
            Name: record.name,
            Type: record.type,
            TTL: 300,
            ResourceRecords: [{ Value: recordValue(record) }]
          }
        }))
      }
    }));
  }
  return { hosted_zone_id: zone.Id, changes: publish.length, skipped };
}
