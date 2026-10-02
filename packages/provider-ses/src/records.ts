export type DnsRecord = {
  record: "DKIM" | "SPF" | "DMARC" | "Tracking" | "Receiving MX";
  name: string;
  type: "CNAME" | "TXT" | "MX";
  value: string;
  status: string;
  ttl: string;
  priority?: number;
};

export const receivingRegions = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "af-south-1",
  "ap-southeast-3",
  "ap-south-1",
  "ap-northeast-3",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-south-1",
  "eu-west-3",
  "eu-north-1",
  "il-central-1",
  "me-south-1",
  "sa-east-1"
] as const;

export function canReceive(region: string) {
  return (receivingRegions as readonly string[]).includes(region);
}

const dkimStatus: Record<string, string> = {
  NOT_STARTED: "not_started",
  PENDING: "pending",
  SUCCESS: "verified",
  FAILED: "failed",
  TEMPORARY_FAILURE: "temporary_failure"
};

export function mapDkimStatus(status: string) {
  return dkimStatus[status] ?? "pending";
}

export function dnsRecords(input: {
  name: string;
  region: string;
  tokens: string[];
  returnPath?: string;
  trackingSubdomain?: string;
  trackingHost?: string;
  receiving?: boolean;
}): DnsRecord[] {
  const returnPath = input.returnPath || "send";
  const tracking = input.trackingSubdomain || "links";
  const mailFrom = `${returnPath}.${input.name}`;
  const records: DnsRecord[] = input.tokens.map((token) => ({
    record: "DKIM",
    name: `${token}._domainkey.${input.name}`,
    type: "CNAME",
    value: `${token}.dkim.amazonses.com`,
    status: "pending",
    ttl: "Auto"
  }));
  records.push(
    {
      record: "SPF",
      name: mailFrom,
      type: "MX",
      value: `feedback-smtp.${input.region}.amazonses.com`,
      status: "pending",
      ttl: "Auto",
      priority: 10
    },
    {
      record: "SPF",
      name: mailFrom,
      type: "TXT",
      value: "v=spf1 include:amazonses.com ~all",
      status: "pending",
      ttl: "Auto"
    },
    {
      record: "DMARC",
      name: `_dmarc.${input.name}`,
      type: "TXT",
      value: "v=DMARC1; p=none;",
      status: "pending",
      ttl: "Auto"
    },
    {
      record: "Tracking",
      name: `${tracking}.${input.name}`,
      type: "CNAME",
      value: input.trackingHost || "links.localhost",
      status: "pending",
      ttl: "Auto"
    }
  );
  if (input.receiving) {
    if (!canReceive(input.region)) {
      throw new Error(`SES cannot receive mail in ${input.region}`);
    }
    records.push({
      record: "Receiving MX",
      name: input.name,
      type: "MX",
      value: `inbound-smtp.${input.region}.amazonaws.com`,
      status: "pending",
      ttl: "Auto",
      priority: 10
    });
  }
  return records;
}

export function combineDomainStatus(input: {
  sendingStatus: string;
  receivingStatus: string | null;
  sendingEnabled: boolean;
  receivingEnabled: boolean;
}) {
  if (!input.sendingEnabled && input.receivingEnabled) return input.receivingStatus ?? "pending";
  if (input.sendingEnabled && input.receivingEnabled && input.receivingStatus) {
    const sendingOk = input.sendingStatus === "verified";
    const receivingOk = input.receivingStatus === "verified";
    if (sendingOk && receivingOk) return "verified";
    if (sendingOk || receivingOk) return "partially_verified";
  }
  return input.sendingStatus;
}

export function planDomainUpdate(input: {
  records: DnsRecord[];
  checks?: Array<{ name: string; type: string; status: string }>;
  dkimStatus: string;
  sendingEnabled: boolean;
  receivingEnabled: boolean;
  receivingVerified: boolean;
  verifyStartedAt: string | null;
  now: number;
}) {
  let sendingStatus = mapDkimStatus(input.dkimStatus);
  const age = input.verifyStartedAt ? input.now - Date.parse(input.verifyStartedAt) : 0;
  if ((sendingStatus === "pending" || sendingStatus === "not_started") && age > 72 * 60 * 60 * 1000) {
    sendingStatus = "failed";
  }
  const receivingStatus = input.receivingEnabled ? (input.receivingVerified ? "verified" : "pending") : null;
  const status = combineDomainStatus({
    sendingStatus,
    receivingStatus,
    sendingEnabled: input.sendingEnabled,
    receivingEnabled: input.receivingEnabled
  });
  const found = new Map((input.checks ?? []).map((check) => [`${check.type}:${check.name}`, check.status]));
  const records = input.records.map((record) => {
    // SES decides DKIM. Every other record is verified only by its own DNS lookup, so a passing
    // DKIM check never marks the tracking or DMARC record as published.
    if (record.record === "DKIM") {
      const status = sendingStatus === "verified" || sendingStatus === "failed" ? sendingStatus : record.status;
      return { ...record, status };
    }
    const check = found.get(`${record.type}:${record.name}`);
    if (!check) return record;
    return { ...record, status: check === "ok" ? "verified" : "pending" };
  });
  return { status, records };
}
