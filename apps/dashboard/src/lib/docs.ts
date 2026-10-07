import { version } from "../../package.json";

// Only public Learn targets are included. Missing pages stay absent from this build.
const documents = import.meta.glob<string>(
  [
    "../../../../docs/automations.md",
    "../../../../docs/templates.md",
    "../../../../docs/audience.md",
    "../../../../docs/domains.md",
    "../../../../docs/deliverability/README.md",
    "../../../../docs/automations/README.md",
  ],
  { query: "?raw", import: "default", eager: true },
);

const shippedDocs = Object.fromEntries(
  Object.entries(documents).map(([path, content]) => [path.replace("../../../../docs/", ""), content]),
);

const targets = {
  automations: [
    { label: "Triggers", target: "automations.md#triggers" },
    { label: "Conditions", target: "automations.md#conditions" },
    { label: "Lifecycle recipes", target: "automations/README.md" },
  ],
  templates: [
    { label: "Variables", target: "templates.md#variables" },
    { label: "Visual editor", target: "templates.md#visual-editor" },
    { label: "Brand", target: "templates.md#brand" },
  ],
  audience: [
    { label: "Properties", target: "audience.md#properties" },
    { label: "Segments", target: "audience.md#segments" },
    { label: "Topics", target: "audience.md#topics" },
  ],
  domains: [
    { label: "DNS records", target: "domains.md#dns-records" },
    { label: "Route 53", target: "domains.md#route-53" },
    { label: "Deliverability", target: "deliverability/README.md" },
  ],
};

/** Documentation is pinned to the running dashboard, never the repository's latest branch. */
export function docsBase(configured = import.meta.env.VITE_DOCS_URL): string {
  return `${configured?.trim().replace(/\/+$/, "") || `https://github.com/0xSMW/dispatch/blob/v${version}/docs`}/`;
}

function hasTarget(docs: Record<string, string>, target: string): boolean {
  const [path, anchor] = target.split("#");
  const content = docs[path!];
  if (content === undefined) return false;
  if (!anchor) return true;
  const headings = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "").matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm);
  return [...headings].some(([, heading]) =>
    heading!.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, "").replace(/\s/g, "-") === anchor,
  );
}

/** Availability comes from the public docs bundled with this version, not a remote request. */
export function learnLinks(area: keyof typeof targets, docs = shippedDocs, configured?: string): Array<{ label: string; href: string }> {
  return targets[area]
    .filter(({ target }) => hasTarget(docs, target))
    .map(({ label, target }) => ({ label, href: `${docsBase(configured)}${target}` }));
}
