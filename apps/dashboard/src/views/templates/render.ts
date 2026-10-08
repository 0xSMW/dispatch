// Client-side preview fill for template and broadcast HTML. It matches `renderTemplate` in
// packages/core, blocks included, and a test compares the two. The server is the source of truth at send time; this only feeds EmailFrame.
import type { Brand, TemplateVariable } from "../../types";
import { brandTextColor, themeContext, themeVariables, type BrandRecord } from "../../../../../packages/core/src/brand";

export type VariableType = "string" | "number" | "list";

export type Variable = { key: string; type: VariableType; fallback_value: string | number | null };

/** Names a template cannot declare: contact fields, unsubscribe URLs, and brand values. */
export const reservedVariables = [
  "FIRST_NAME", "LAST_NAME", "EMAIL", "UNSUBSCRIBE_URL",
  "RESEND_UNSUBSCRIBE_URL", "DISPATCH_UNSUBSCRIBE_URL", "contact", "this",
  "PRODUCT_NAME", "PRODUCT_URL", "LOGO_URL", "BRAND_COLOR", "BRAND_TEXT_COLOR",
  "SUPPORT_EMAIL", "SUPPORT_URL", "PRIVACY_URL", "COMPANY_NAME", "COMPANY_ADDRESS", "CURRENT_YEAR",
  ...themeVariables,
];

const placeholder = /\{\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|([^}]*))?\}\}\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const blockToken = () => /\{\{\{(?:#(each|if|unless)\s+([A-Za-z0-9_.]+)|\/(each|if|unless))\s*\}\}\}/g;

type Scope = Record<string, unknown>;
type BlockKind = "if" | "unless" | "each";
type BlockNode = string | { kind: BlockKind; key: string; children: BlockNode[] };

/** Accepts the old string array and the object array. */
export function normalizeVariables(variables: TemplateVariable[] | null | undefined): Variable[] {
  return (variables ?? []).map((item) =>
    typeof item === "string"
      ? { key: item, type: "string", fallback_value: null }
      : {
          key: item.key,
          type: item.type === "number" || item.type === "list" ? item.type : "string",
          fallback_value: item.fallback_value ?? null,
        },
  );
}

/** True for names the API provides itself: reserved names and dotted paths such as `contact.first_name`. */
export function builtIn(key: string) {
  return reservedVariables.includes(key) || key.includes(".");
}

const unsafeVariables = ["constructor", "prototype", "__proto__", "toString", "valueOf", "hasOwnProperty"];

/** True for a name the API accepts as a declared variable: letters, digits, and underscores, 50 at most. */
export function declarable(key: string) {
  return /^[A-Za-z0-9_]{1,50}$/.test(key) && !unsafeVariables.includes(key);
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

// Own properties only, as on the server, so a placeholder named `constructor` prints nothing.
function own(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key) ? (value as Scope)[key] : undefined;
}

function lookup(key: string, values: Scope): unknown {
  if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  return key.split(".").reduce<unknown>((value, part) => own(value, part), values);
}

function present(value: unknown) {
  return !(value === undefined || value === null || value === "" || value === false || (Array.isArray(value) && value.length === 0));
}

// The same parser as `parseBlocks` in @dispatchmail/core, which cannot be imported into the browser.
// Blocks nest, so tags are matched with a stack. Keep the two in step: render.test.ts runs the
// library templates through both.
function parseBlocks(source: string): BlockNode[] {
  const root: BlockNode[] = [];
  const stack: Array<{ kind: BlockKind; key: string; children: BlockNode[] }> = [];
  const push = (node: BlockNode) => (stack.length > 0 ? stack[stack.length - 1]!.children : root).push(node);
  let last = 0;
  for (const match of source.matchAll(blockToken())) {
    const index = match.index ?? 0;
    if (index > last) push(source.slice(last, index));
    last = index + match[0].length;
    if (match[1]) {
      stack.push({ kind: match[1] as BlockKind, key: match[2]!, children: [] });
      continue;
    }
    const open = stack.pop();
    if (!open) throw new Error(`{{{/${match[3]}}}} has no opening block`);
    if (open.kind !== match[3]) throw new Error(`{{{#${open.kind} ${open.key}}}} is closed by {{{/${match[3]}}}}`);
    push(open);
  }
  const open = stack.pop();
  if (open) throw new Error(`{{{#${open.kind} ${open.key}}}} is never closed`);
  if (last < source.length) push(source.slice(last));
  return root;
}

/** Why the blocks in a source do not pair up, or null when they do. The API refuses to publish or send such a template. */
export function blockProblem(...sources: Array<string | null | undefined>): string | null {
  for (const source of sources) {
    if (!source) continue;
    try {
      parseBlocks(source);
    } catch (error) {
      return error instanceof Error ? error.message : "Blocks are not balanced";
    }
  }
  return null;
}

export type Filled = { subject: string; html: string; text: string; missing: string[]; problem: string | null };

/** A field of the contact a broadcast goes to, as `contactField` in @dispatchmail/core. A broadcast prints a blank for one the contact lacks. */
export function contactField(key: string) {
  return key.startsWith("contact.") || key === "FIRST_NAME" || key === "LAST_NAME";
}

/**
 * Fills `{{{KEY}}}`, `{{{KEY|fallback}}}`, `{{key}}`, `{{{#if}}}`, `{{{#unless}}}`, and `{{{#each}}}` the way
 * the API does. Values are escaped in HTML. Unlike the API, which refuses the send, a placeholder with no
 * value and no fallback stays visible and is listed in `missing`. A key that `blank` accepts prints as an
 * empty string instead, as the API prints a broadcast's contact fields. Blocks that do not pair up are left
 * as written and reported in `problem`.
 */
export function fill(
  fields: { subject?: string | null; html?: string | null; text?: string | null },
  values: Scope,
  variables: Variable[] = [],
  options: { blank?: (key: string) => boolean } = {},
): Filled {
  const declared = new Map(variables.map((item) => [item.key, item]));
  const missing = new Set<string>();
  let problem: string | null = null;

  // A field of the current list item wins, even when it is an empty string: the item said so.
  const peek = (key: string, scope: Scope) => {
    const field = own(scope, key);
    if (field !== undefined && field !== null) return field;
    const value = lookup(key, values);
    if (value !== undefined && value !== null && value !== "") return value;
    return declared.get(key)?.fallback_value ?? undefined;
  };

  const resolve = (key: string, inline: string | undefined, scope: Scope) => {
    const field = own(scope, key);
    if (field !== undefined && field !== null) return String(field);
    const value = lookup(key, values);
    if (value !== undefined && value !== null && value !== "") return String(value);
    if (inline !== undefined) return inline;
    const fallback = declared.get(key)?.fallback_value;
    if (fallback !== undefined && fallback !== null) return String(fallback);
    if (options.blank?.(key)) return "";
    missing.add(key);
    return null;
  };

  const substitute = (escape: boolean) => (text: string, scope: Scope) =>
    text.replace(placeholder, (match, triple: string | undefined, inline: string | undefined, double: string | undefined) => {
      const value = resolve((triple ?? double)!, inline, scope);
      if (value === null) return match;
      return escape ? escapeHtml(value) : value;
    });

  const render = (nodes: BlockNode[], scope: Scope, put: (text: string, scope: Scope) => string): string => {
    let out = "";
    for (const node of nodes) {
      if (typeof node === "string") {
        out += put(node, scope);
        continue;
      }
      const value = peek(node.key, scope);
      if (node.kind === "if" || node.kind === "unless") {
        if (present(value) === (node.kind === "if")) out += render(node.children, scope, put);
        continue;
      }
      if (!Array.isArray(value)) continue;
      for (const item of value.slice(0, 200)) {
        out += render(node.children, { ...scope, ...(item && typeof item === "object" ? (item as Scope) : {}) }, put);
      }
    }
    return out;
  };

  const run = (source: string | null | undefined, escape: boolean) => {
    if (!source) return "";
    let nodes: BlockNode[];
    try {
      nodes = parseBlocks(source);
    } catch (error) {
      problem ??= error instanceof Error ? error.message : "Blocks are not balanced";
      nodes = [source];
    }
    return render(nodes, {}, substitute(escape));
  };

  const filled = { subject: run(fields.subject, false), html: run(fields.html, true), text: run(fields.text, false) };
  return { ...filled, missing: [...missing], problem };
}

export type Found = { key: string; type: VariableType; inline: boolean };

/** Every variable a source uses, in order. Fields inside `#each` belong to the list item and are skipped. */
export function scan(...sources: Array<string | null | undefined>): Found[] {
  const found = new Map<string, Found>();
  const add = (key: string, type: VariableType, inline: boolean) => {
    const current = found.get(key);
    if (!current) found.set(key, { key, type, inline });
    else found.set(key, { key, type: current.type === "list" || type === "list" ? "list" : current.type, inline: current.inline || inline });
  };
  const plain = (text: string) => {
    for (const match of text.matchAll(placeholder)) add((match[1] ?? match[3])!, "string", match[2] !== undefined);
  };
  const walk = (nodes: BlockNode[]) => {
    for (const node of nodes) {
      if (typeof node === "string") plain(node);
      else {
        add(node.key, node.kind === "each" ? "list" : "string", false);
        if (node.kind !== "each") walk(node.children);
      }
    }
  };
  for (const source of sources) {
    if (!source) continue;
    try {
      walk(parseBlocks(source));
    } catch {
      // Blocks that do not pair up yet, while the user is typing: read the tags one by one.
      for (const match of source.matchAll(blockToken())) if (match[1]) add(match[2]!, match[1] === "each" ? "list" : "string", false);
      plain(source);
    }
  }
  return [...found.values()];
}

/**
 * True when a source prints one of `keys` with no fallback after a bar. A placeholder inside an
 * `#if` that tests one of the keys never prints a blank, so it does not count.
 */
export function noFallback(keys: string[], ...sources: Array<string | null | undefined>) {
  const bare = (text: string) =>
    [...text.matchAll(placeholder)].some((match) => keys.includes((match[1] ?? match[3])!) && match[2] === undefined);
  const walk = (nodes: BlockNode[]): boolean =>
    nodes.some((node) => (typeof node === "string" ? bare(node) : !(node.kind === "if" && keys.includes(node.key)) && walk(node.children)));
  return sources.some((source) => {
    if (!source) return false;
    try {
      return walk(parseBlocks(source));
    } catch {
      return bare(source);
    }
  });
}

/** The `contact.*` fields a source names, without the prefix. */
export function contactKeys(...sources: Array<string | null | undefined>) {
  return [...new Set(sources.flatMap((source) => [...(source ?? "").matchAll(/contact\.([A-Za-z0-9_]+)/g)].map((match) => match[1]!)))];
}

/** The reserved brand names from `GET /brand`, as the API passes them to the renderer. */
export function brandValues(brand: Brand | null | undefined): Scope {
  // The API sends the values exactly as a preview render uses them, fallbacks included.
  const resolved = brand?.variables;
  if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) return { ...(resolved as Scope) };
  const value = (key: string) => (typeof brand?.[key] === "string" && brand[key] ? (brand[key] as string) : undefined);
  const product = value("product_name");
  return {
    ...themeContext((brand ?? {}) as BrandRecord),
    PRODUCT_NAME: product,
    PRODUCT_URL: value("product_url"),
    LOGO_URL: value("logo_url") ?? "",
    BRAND_COLOR: value("color") ?? "#171717",
    BRAND_TEXT_COLOR: value("button_text_color") ?? brandTextColor(value("color") ?? "#171717"),
    SUPPORT_EMAIL: value("support_email"),
    SUPPORT_URL: value("support_url") ?? "",
    PRIVACY_URL: value("privacy_url") ?? "",
    COMPANY_NAME: value("company_name") ?? product,
    COMPANY_ADDRESS: value("company_address") ?? "",
    CURRENT_YEAR: String(new Date().getFullYear()),
  };
}

/** A sample recipient for broadcast previews and test sends. */
export const sampleContact: Scope = {
  contact: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
  FIRST_NAME: "Ada",
  LAST_NAME: "Lovelace",
  EMAIL: "ada@example.com",
  UNSUBSCRIBE_URL: "https://example.com/unsubscribe",
  DISPATCH_UNSUBSCRIBE_URL: "https://example.com/unsubscribe",
  RESEND_UNSUBSCRIBE_URL: "https://example.com/unsubscribe",
};

/** Absolute http and https links in HTML, skipping any that still hold a placeholder. At most 50, the API's limit. */
export function links(html: string | null | undefined) {
  const urls = new Set<string>();
  for (const match of (html ?? "").matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const url = (match[1] ?? match[2] ?? "").trim().replaceAll("&amp;", "&");
    if (/^https?:\/\//i.test(url) && !url.includes("{{")) urls.add(url);
  }
  return [...urls].slice(0, 50);
}

/** True when the HTML links to one of the unsubscribe placeholders. */
export function hasUnsubscribe(html: string | null | undefined) {
  return /\{\{\{?\s*(?:RESEND_|DISPATCH_)?UNSUBSCRIBE_URL\b/.test(html ?? "");
}
