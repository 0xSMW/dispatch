import type { Domain } from "../../types";

const encoder = new TextEncoder();
const decimal = (byte: number) => `\\${String(byte).padStart(3, "0")}`;

/** Escape names as single BIND tokens, keeping DNS label separators. */
function name(value: string): string {
  return Array.from(encoder.encode(value), (byte) => {
    const char = String.fromCharCode(byte);
    return /^[a-z0-9._*-]$/i.test(char) ? char : decimal(byte);
  }).join("");
}

function absolute(value: string): string {
  return name(value.endsWith(".") ? value : `${value}.`);
}

/** TXT character strings hold at most 255 bytes, not 255 JavaScript characters. */
function txt(value: string): string {
  const bytes = encoder.encode(value);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length || offset === 0; offset += 255) {
    const chunk = Array.from(bytes.slice(offset, offset + 255), (byte) => {
      if (byte === 34 || byte === 92) return `\\${String.fromCharCode(byte)}`;
      return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : decimal(byte);
    }).join("");
    chunks.push(`"${chunk}"`);
  }
  return chunks.join(" ");
}

/** A BIND import fragment of the actual records, without invented SOA or NS records. */
export function toZone(domain: Pick<Domain, "name" | "records">): string {
  const origin = domain.name.replace(/\.$/, "");
  const lines = [`$ORIGIN ${absolute(origin)}`, "$TTL 300"];
  for (const record of domain.records) {
    const owner = record.name === "@" ? absolute(origin)
      : record.name.endsWith(".") || record.name.toLowerCase() === origin.toLowerCase() || record.name.toLowerCase().endsWith(`.${origin.toLowerCase()}`)
        ? absolute(record.name)
        : absolute(`${record.name}.${origin}`);
    const ttl = record.ttl && /^(?:\d+[wdhms]?)+$/i.test(record.ttl) ? record.ttl : "300";
    const type = record.type.toUpperCase();
    const value = type === "TXT" ? txt(record.value)
      : type === "CNAME" ? absolute(record.value)
        : type === "MX" ? `${record.priority ?? 0} ${absolute(record.value)}`
          : record.value;
    lines.push(`${owner} ${ttl} IN ${type} ${value}`);
  }
  return `${lines.join("\n")}\n`;
}
