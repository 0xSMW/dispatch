import { resolveTxt } from "node:dns/promises";
import { emailDetail, type Queryable } from "@dispatchmail/db";
import type { FastifyInstance } from "fastify";

export type TxtResolver = (name: string) => Promise<string[][]>;

export type InsightEmail = {
  from_email: string;
  html?: string | null;
  text?: string | null;
};

export type InsightDomain = {
  name: string;
  open_tracking?: boolean | null;
  click_tracking?: boolean | null;
  tracking_subdomain?: string | null;
  records?: Array<{ record?: string; status?: string }> | null;
};

export type Dmarc = { name: string; record: string | null };

type Check = {
  id: string;
  passed: boolean;
  severity: "attention" | "improvement";
  title: string;
  detail: string;
};

export const gmailClipBytes = 102 * 1024;

export function registerInsights(app: FastifyInstance, deps: { db: Queryable; resolver?: TxtResolver }) {
  app.get("/emails/:id/insights", async (request) => {
    const tenantId = request.auth!.tenant_id;
    const email = (await emailDetail(deps.db, tenantId, (request.params as { id: string }).id)) as unknown as InsightEmail & { id: string };
    const domainName = senderDomain(email.from_email);
    const domain = await deps.db.query<InsightDomain>(
      `select name, open_tracking, click_tracking, tracking_subdomain, records
       from domains where tenant_id = $1 and name = $2 and deleted_at is null
       limit 1`,
      [tenantId, domainName],
    );
    const dmarc = await lookupDmarc(domainName, deps.resolver);
    return presentInsights(email.id, insightChecks(email, domain.rows[0] ?? null, dmarc));
  });
}

export function presentInsights(emailId: string, checks: Check[]) {
  const item = (check: Check) => ({ id: check.id, title: check.title, detail: check.detail });
  return {
    object: "email_insights" as const,
    email_id: emailId,
    needs_attention: checks.filter((check) => !check.passed && check.severity === "attention").map(item),
    possible_improvements: checks.filter((check) => !check.passed && check.severity === "improvement").map(item),
    doing_great: checks.filter((check) => check.passed).map(item),
  };
}

export function senderDomain(address: string) {
  return (address.split("@")[1] ?? "").toLowerCase();
}

// Last two labels. Without a public suffix list, example.co.uk reads as co.uk.
export function rootDomain(domain: string) {
  return domain.split(".").slice(-2).join(".");
}

export function links(html: string | null | undefined) {
  const found: URL[] = [];
  for (const match of (html ?? "").matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") found.push(url);
    } catch {
      continue;
    }
  }
  return found;
}

export async function lookupDmarc(domain: string, resolver: TxtResolver = resolveTxt): Promise<Dmarc> {
  const names = [...new Set([`_dmarc.${domain}`, `_dmarc.${rootDomain(domain)}`])];
  for (const name of names) {
    try {
      const records = await resolver(name);
      const record = records.map((parts) => parts.join("")).find((value) => /^v=DMARC1\b/i.test(value.trim()));
      if (record) return { name, record };
    } catch {
      continue;
    }
  }
  return { name: names[0], record: null };
}

export function insightChecks(email: InsightEmail, domain: InsightDomain | null, dmarc: Dmarc): Check[] {
  const sender = senderDomain(email.from_email);
  const root = rootDomain(sender);
  const urls = links(email.html);
  const foreign = [...new Set(urls.map((url) => url.hostname.toLowerCase()).filter((host) => host !== root && !host.endsWith(`.${root}`)))];
  const shortYoutube = urls.filter((url) => url.hostname.toLowerCase() === "youtu.be");
  const local = email.from_email.split("@")[0]?.toLowerCase() ?? "";
  const noReply = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply)/.test(local);
  const bytes = Buffer.byteLength(email.html ?? "", "utf8");
  const tracking = Boolean(domain?.open_tracking || domain?.click_tracking);
  const trackingRecord = (domain?.records ?? []).find((record) => record.record === "Tracking");
  const customTracking = Boolean(domain?.tracking_subdomain && trackingRecord && ["verified", "valid"].includes(trackingRecord.status ?? ""));
  const policy = dmarc.record?.match(/\bp\s*=\s*(\w+)/i)?.[1]?.toLowerCase();

  return [
    {
      id: "link_domain",
      passed: foreign.length === 0,
      severity: "attention",
      title: "Links match the sending domain",
      detail: foreign.length === 0 ? `Every link points at ${root}.` : `Links point to other domains: ${foreign.join(", ")}.`,
    },
    {
      id: "dmarc",
      passed: Boolean(dmarc.record),
      severity: "attention",
      title: "A valid DMARC record exists",
      detail: dmarc.record ? `${dmarc.name} has a DMARC record${policy ? ` with p=${policy}` : ""}.` : `No DMARC record found at ${dmarc.name}.`,
    },
    {
      id: "plain_text",
      passed: Boolean(email.text?.trim()),
      severity: "improvement",
      title: "A plain text version is included",
      detail: email.text?.trim() ? "The email has a plain text part." : "Add a plain text part for clients that do not render HTML.",
    },
    {
      id: "no_reply",
      passed: !noReply,
      severity: "improvement",
      title: "The sender is not no-reply",
      detail: noReply ? `${email.from_email} discourages replies. Use an address people can answer.` : "The sender accepts replies.",
    },
    {
      id: "gmail_clip",
      passed: bytes <= gmailClipBytes,
      severity: "attention",
      title: "The body is under Gmail's 102 KB clipping limit",
      detail: `The HTML is ${Math.ceil(bytes / 1024)} KB.`,
    },
    {
      id: "youtube_links",
      passed: shortYoutube.length === 0,
      severity: "improvement",
      title: "YouTube links use full URLs",
      detail: shortYoutube.length === 0 ? "No shortened YouTube links." : "Replace youtu.be links with youtube.com/watch links.",
    },
    {
      id: "subdomain",
      passed: sender !== root,
      severity: "improvement",
      title: "The sender uses a subdomain",
      detail: sender !== root ? `${sender} keeps sending reputation apart from ${root}.` : `Send from a subdomain such as send.${root} to protect ${root}.`,
    },
    {
      id: "tracking_subdomain",
      passed: !tracking || customTracking,
      severity: "improvement",
      title: "Click and open tracking use a custom subdomain",
      detail: !tracking
        ? "Tracking is off for this domain."
        : customTracking
          ? `Tracking links use ${domain?.tracking_subdomain}.${domain?.name}.`
          : "Tracking links use the shared host. Verify the tracking subdomain record.",
    },
  ];
}
