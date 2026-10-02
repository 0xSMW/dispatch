import { resolveCname, resolveMx, resolveNs, resolveTxt } from "node:dns/promises";
import type { DnsRecord } from "./records.js";

export type Resolvers = {
  resolveCname(hostname: string): Promise<string[]>;
  resolveMx(hostname: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveNs?(hostname: string): Promise<string[]>;
};

export const nodeResolvers: Resolvers = { resolveCname, resolveMx, resolveTxt, resolveNs };

// Name server suffixes of the DNS hosts people use most. The dashboard shows the name so the
// user knows where to add the records.
const hosts: Array<[RegExp, string]> = [
  [/\.awsdns-\d+\.(com|net|org|co\.uk)$/, "Route 53"],
  [/\.cloudflare\.com$/, "Cloudflare"],
  [/\.domaincontrol\.com$/, "GoDaddy"],
  [/\.registrar-servers\.com$/, "Namecheap"],
  [/\.googledomains\.com$|\.google\.com$/, "Google"],
  [/\.vercel-dns\.com$/, "Vercel"],
  [/\.digitalocean\.com$/, "DigitalOcean"],
  [/\.azure-dns\.(com|net|org|info)$/, "Azure"],
  [/\.nsone\.net$/, "NS1"],
  [/\.dnsimple\.com$|\.dnsimple-edge\.(net|org)$/, "DNSimple"],
  [/\.squarespacedns\.com$/, "Squarespace"],
  [/\.porkbun\.com$/, "Porkbun"],
  [/\.gandi\.net$/, "Gandi"],
  [/\.hetzner\.(com|de)$/, "Hetzner"],
  [/\.linode\.com$/, "Linode"],
  [/\.name\.com$/, "Name.com"],
  [/\.netlify\.com$/, "Netlify"],
];

// The DNS host of a domain, from the name servers of the nearest zone above it. Null when the
// lookup fails or the name servers are not ones this list knows.
export async function dnsProvider(domain: string, resolvers: Resolvers = nodeResolvers): Promise<string | null> {
  if (!resolvers.resolveNs) return null;
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    let servers: string[];
    try {
      servers = await resolvers.resolveNs(labels.slice(index).join("."));
    } catch {
      continue;
    }
    if (!servers.length) continue;
    for (const server of servers) {
      const name = `.${server.toLowerCase().replace(/\.$/, "")}`;
      const known = hosts.find(([pattern]) => pattern.test(name));
      if (known) return known[1];
    }
    return null;
  }
  return null;
}

export type DnsCheck = {
  name: string;
  type: string;
  record: string;
  expected: string;
  found: string | null;
  status: "ok" | "mismatch" | "missing";
  message: string;
};

function flattenTxt(chunks: string[][]) {
  return chunks.map((chunk) => chunk.join(""));
}

function clean(value: string) {
  return value.replace(/\.$/, "").replaceAll("\"", "");
}

// A domain owner may already publish a stricter DMARC policy or an SPF record that lists other
// senders. Both satisfy SES, so they count as a match.
function matches(record: DnsRecord, value: string, expected: string) {
  const found = clean(value);
  if (record.record === "DMARC") return /^v=DMARC1\b/i.test(found);
  if (record.record === "SPF" && record.type === "TXT") {
    return /^v=spf1\b/i.test(found) && /\binclude:amazonses\.com\b/i.test(found);
  }
  return found.toLowerCase() === expected.toLowerCase();
}

export async function checkRecords(records: DnsRecord[], resolvers: Resolvers = nodeResolvers): Promise<DnsCheck[]> {
  const checks: DnsCheck[] = [];
  for (const record of records) {
    let found: string[] = [];
    try {
      if (record.type === "CNAME") found = await resolvers.resolveCname(record.name);
      else if (record.type === "MX") {
        const rows = await resolvers.resolveMx(record.name);
        found = rows
          .filter((row) => row.priority === (record.priority ?? 10))
          .map((row) => row.exchange.replace(/\.$/, ""));
      } else found = flattenTxt(await resolvers.resolveTxt(record.name));
    } catch {
      found = [];
    }
    const expected = record.value.replace(/\.$/, "");
    const matched = found.find((value) => matches(record, value, expected));
    const match = matched !== undefined;
    if (found.length === 0) {
      checks.push({
        name: record.name,
        type: record.type,
        record: record.record,
        expected: record.value,
        found: null,
        status: "missing",
        message: `No ${record.type} record at ${record.name}. Add ${record.value}.`
      });
    } else if (!match) {
      checks.push({
        name: record.name,
        type: record.type,
        record: record.record,
        expected: record.value,
        found: found[0],
        status: "mismatch",
        message: `${record.name} has ${found[0]}, and SES expects ${record.value}.`
      });
    } else {
      checks.push({
        name: record.name,
        type: record.type,
        record: record.record,
        expected: record.value,
        found: clean(matched ?? expected),
        status: "ok",
        message: `${record.record} matches.`
      });
    }
  }
  return checks;
}
