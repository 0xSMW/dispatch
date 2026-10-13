import { lookup as lookupCallback, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as agentFetch } from "undici";

export async function normalizeWebhookUrl(value: string, options: { requireHttps?: boolean; allowPrivate?: boolean } = {}) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid webhook URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Webhook URL must be http or https");
  if (options.requireHttps && url.protocol !== "https:") throw new Error("Webhook URL must use https in production");
  if (!options.allowPrivate) await assertPublicWebhookTarget(url.hostname);
  url.hash = "";
  return url.toString();
}

export async function assertPublicWebhookTarget(host: string) {
  if (blockedWebhookHost(host)) throw new Error("Webhook URL host is not allowed");
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(value)) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(value, { all: true, verbatim: true });
  } catch {
    throw new Error("Webhook URL host could not be resolved");
  }
  if (addresses.some((address) => blockedWebhookHost(address.address))) throw new Error("Webhook URL host is not allowed");
}

type LookupDone = (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

// The lookup a connection uses when it is made through publicFetch(). Checking a host and then
// connecting leaves a moment in which its DNS can be pointed at a private address. Here the
// address that is checked is the address that is dialed, on every connection and every redirect.
export function publicLookup(hostname: string, options: { all?: boolean; family?: number } | undefined, done: LookupDone) {
  lookupCallback(hostname, { family: options?.family ?? 0, all: true, verbatim: true }, (error, addresses) => {
    if (error) return done(error);
    const found = addresses as LookupAddress[];
    if (found.length === 0 || found.some((entry) => blockedWebhookHost(entry.address))) {
      return done(Object.assign(new Error(`${hostname} resolves to an address that is not allowed`), { code: "EHOSTBLOCKED" }));
    }
    if (options?.all) done(null, found);
    else done(null, found[0]!.address, found[0]!.family);
  });
}

let publicAgent: Agent | undefined;

// fetch() for a URL someone else chose: a webhook endpoint, a remote attachment, a link to
// check. A host given as an IP address is never looked up, so callers still run
// assertPublicWebhookTarget() first.
export function publicFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  publicAgent ??= new Agent({ connect: { lookup: publicLookup as never } });
  return agentFetch(input, { ...(init as object), dispatcher: publicAgent }) as unknown as Promise<Response>;
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

function ipv6Groups(value: string): number[] | null {
  let text = value;
  const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const bytes = dotted.slice(2).map(Number);
    if (bytes.some((byte) => byte > 255)) return null;
    text = `${dotted[1]}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...Array<string>(fill).fill("0"), ...right].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

// An IPv6 address can carry an IPv4 address: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d),
// NAT64 (64:ff9b::/96), and 6to4 (2002::/16). Each must be judged by the IPv4 address inside it.
function embeddedIpv4(groups: number[]) {
  const dotted = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  const zero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (zero(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) return dotted(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return dotted(groups[6], groups[7]);
  if (groups[0] === 0x2002) return dotted(groups[1], groups[2]);
  return null;
}

export function blockedWebhookHost(host: string) {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "").replace(/\.$/, "");
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  const kind = isIP(value);
  if (kind === 4) return blockedAddresses.check(value, "ipv4");
  if (kind === 6) {
    const groups = ipv6Groups(value);
    if (!groups) return true;
    const inner = embeddedIpv4(groups);
    return inner ? blockedAddresses.check(inner, "ipv4") : blockedAddresses.check(value, "ipv6");
  }
  return false;
}
