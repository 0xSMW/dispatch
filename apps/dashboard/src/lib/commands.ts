import type { Client } from "./client";
import { ApiError } from "./client";
import { emailStatuses } from "./events";
import type { List } from "../types";

export type Command = {
  id: string;
  label: string;
  detail: string;
  group: string;
  to?: string;
  action?: () => void;
  related?: Command[];
};

/** All query words must match; exact names and prefixes sort ahead of loose matches. */
export function rankCommands(commands: Command[], query: string): Command[] {
  const text = query.trim().toLowerCase();
  if (!text) return commands;
  const words = text.split(/\s+/);
  return commands.map((command, index) => {
    const label = command.label.toLowerCase();
    const haystack = `${label} ${command.detail} ${command.id}`.toLowerCase();
    const score = label === text ? 0 : label.startsWith(text) ? 1 : words.every((word) => haystack.includes(word)) ? 2 : 3;
    return { command, score, index };
  }).filter(({ score }) => score < 3).sort((a, b) => a.score - b.score || a.index - b.index).map(({ command }) => command);
}

/** Interpret only requests the existing Emails filters can faithfully express. */
export function emailCommand(query: string, now = new Date()): Command | null {
  let text = query.trim().toLowerCase().replace(/[?!.]+$/, "");
  if (!/\b(emails?|messages?)\b/.test(text)) return null;
  const params = new URLSearchParams();
  const details: string[] = [];
  const period = text.match(/\b(this week|today|yesterday|last (?:3|7|15|30) days)\b/);
  if (period) {
    const value = period[0];
    if (value === "this week") {
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
      const day = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      params.set("range", "custom"); params.set("start", day(monday)); params.set("end", day(now));
    } else params.set("range", value.startsWith("last") ? `${value.split(" ")[1]}d` : value);
    details.push(value.replace(/^./, (letter) => letter.toUpperCase()));
    text = text.replace(value, "");
  }
  const status = emailStatuses.find((value) => new RegExp(`\\b${value}\\b`).test(text));
  if (status) {
    params.set("status", status); details.unshift(`Status: ${status}`); text = text.replace(status, "");
  }
  const recipient = text.match(/\b(?:to|for)\s+([^\s]+@[^\s]+\.[^\s]+)/);
  if (recipient) { params.set("q", recipient[1]); details.push(`Recipient or subject: ${recipient[1]}`); text = text.replace(recipient[0], ""); }
  // Unknown words remain an ordinary record search rather than silently dropped intent.
  text = text.replace(/\b(show|find|view|open|me|my|all|the|emails?|messages?|from|in|during|that|were|are)\b/g, "").trim();
  if (text || !details.length) return null;
  return { id: "filtered-emails", label: "Emails", detail: details.join(" · "), group: "Matching view", to: `/emails?${params}` };
}

type RecordRow = { id: string; name?: string; subject?: string; email?: string; first_name?: string; last_name?: string; alias?: string; to?: string[]; cc?: string[]; bcc?: string[]; status?: string; last_event?: string };
const sources = [
  { path: "/emails", label: "Email", prefix: "email", href: (r: RecordRow) => `/emails/${encodeURIComponent(r.id)}` },
  { path: "/broadcasts", label: "Broadcast", prefix: "broadcast", href: (r: RecordRow) => `/broadcasts/${encodeURIComponent(r.id)}${r.status === "draft" ? "/editor" : ""}` },
  { path: "/automations", label: "Automation", prefix: "automation", href: (r: RecordRow) => `/automations/${encodeURIComponent(r.id)}/editor` },
  { path: "/templates", label: "Template", prefix: "template", href: (r: RecordRow) => `/templates/${encodeURIComponent(r.id)}` },
  { path: "/contacts", label: "Contact", prefix: "contact", href: (r: RecordRow) => `/audience/contacts/${encodeURIComponent(r.id)}` },
  { path: "/domains", label: "Domain", prefix: "domain", href: (r: RecordRow) => `/domains/${encodeURIComponent(r.id)}` },
];

/** Bounded server-side search; no full mailbox download or write requests. */
export async function searchRecords(client: Client, query: string): Promise<{ commands: Command[]; failed: string[] }> {
  const exact = sources.find((source) => query.startsWith(`${source.prefix}_`) && /^[a-zA-Z0-9_-]+$/.test(query));
  const selected = exact ? [exact] : sources;
  const results = await Promise.allSettled(selected.map(async (source) => {
    const rows = exact
      ? [await client.get<RecordRow>(`${source.path}/${encodeURIComponent(query)}`)]
      : (await client.get<List<RecordRow>>(source.path, { q: query, limit: 5 })).data;
    return rows.map((row): Command => {
      const to = source.href(row);
      const label = row.name || row.email || row.subject || row.id;
      const detail = [source.label, [row.first_name, row.last_name].filter(Boolean).join(" "), [...(row.to ?? []), ...(row.cc ?? []), ...(row.bcc ?? [])].join(", "), row.name ? row.subject : undefined, row.alias, row.status || row.last_event, row.id].filter(Boolean).join(" · ");
      const related: Command[] = source.prefix === "automation" ? [
        { id: `${row.id}:editor`, label: "Open editor", detail: label, group: "Actions", to },
        { id: `${row.id}:runs`, label: "View runs", detail: label, group: "Actions", to: `${to}?tab=runs` },
        { id: `${row.id}:metrics`, label: "View metrics", detail: label, group: "Actions", to: `${to}?tab=metrics` },
      ] : source.prefix === "broadcast" ? [
        { id: `${row.id}:view`, label: row.status === "draft" ? "Open draft" : "View broadcast", detail: label, group: "Actions", to },
        { id: `${row.id}:metrics`, label: "View results", detail: label, group: "Actions", to: `/broadcasts/${encodeURIComponent(row.id)}` },
      ] : [];
      return { id: row.id, label, detail, group: "Records", to, related };
    });
  }));
  const commands: Command[] = [];
  const failed: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") commands.push(...result.value);
    else if (!(result.reason instanceof ApiError && result.reason.statusCode === 404 && exact)) failed.push(selected[index].label);
  });
  const ranked = exact ? commands : rankCommands(commands, query);
  // The server may match fields absent from a compact display label. Never drop its matches.
  return { commands: [...ranked, ...commands.filter((command) => !ranked.includes(command))], failed };
}
