import { themeVariables } from "./theme.js";
import { brandTextColor, themeContext, type BrandRecord } from "./brand.js";
import { ApiError } from "./errors.js";

export const reservedVariables = [
  "FIRST_NAME", "LAST_NAME", "EMAIL", "UNSUBSCRIBE_URL",
  "RESEND_UNSUBSCRIBE_URL", "DISPATCH_UNSUBSCRIBE_URL", "contact", "this",
  "PRODUCT_NAME", "PRODUCT_URL", "LOGO_URL", "BRAND_COLOR", "BRAND_TEXT_COLOR",
  "SUPPORT_EMAIL", "SUPPORT_URL", "PRIVACY_URL", "COMPANY_NAME", "COMPANY_ADDRESS", "CURRENT_YEAR",
  ...themeVariables
];

// Throws 422 when the subject, HTML, or text has an unclosed or crossed block.
export function assertBlocks(fields: { subject?: string | null; html?: string | null; text?: string | null }) {
  for (const name of ["subject", "html", "text"] as const) {
    const problem = fields[name] ? blockProblem(fields[name]!) : null;
    if (problem) throw new ApiError("validation_error", 422, `${name}: ${problem}`);
  }
}

export function brandContext(
  brand: BrandRecord,
  fallback: { tenantName: string; domain?: string | null; from?: string | null; year?: number }
) {
  const color = brand.color || "#171717";
  const productName = brand.product_name || fallback.tenantName;
  return {
    ...themeContext(brand),
    PRODUCT_NAME: productName,
    PRODUCT_URL: brand.product_url || (fallback.domain ? `https://${fallback.domain}` : ""),
    LOGO_URL: brand.logo_url || "",
    BRAND_COLOR: color,
    BRAND_TEXT_COLOR: brandTextColor(color),
    SUPPORT_EMAIL: brand.support_email || "",
    SUPPORT_URL: brand.support_url || "",
    PRIVACY_URL: brand.privacy_url || "",
    COMPANY_NAME: brand.company_name || productName,
    COMPANY_ADDRESS: brand.company_address || "",
    CURRENT_YEAR: String(fallback.year ?? new Date().getFullYear())
  };
}

export type TemplateVariable = {
  key: string;
  type?: "string" | "number" | "list";
  fallback_value?: string | number | null;
};

type NormalizedVariable = { key: string; type: "string" | "number" | "list"; fallback_value: string | number | null };

function placeholderPattern() {
  return /\{\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|([^}]*))?\}\}\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

// Own properties only. `in` and plain indexing walk the prototype chain, so a placeholder named
// `constructor` would otherwise print a function.
export function own(value: unknown, key: string) {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function variableAt(key: string, variables: Record<string, unknown>, context: Record<string, unknown>) {
  if (Object.hasOwn(variables, key)) return variables[key];
  return key.split(".").reduce<unknown>((value, part) => own(value, part), context);
}

function normalizeVariables(value: unknown): NormalizedVariable[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [{ key: item, type: "string" as const, fallback_value: null }];
    if (!item || typeof item !== "object" || typeof (item as { key?: unknown }).key !== "string") return [];
    const variable = item as TemplateVariable;
    const type = variable.type === "number" || variable.type === "list" ? variable.type : "string";
    return [{
      key: variable.key,
      type,
      fallback_value: variable.fallback_value ?? null
    }];
  });
}

type BlockKind = "if" | "unless" | "each";
export type BlockNode = string | { kind: BlockKind; key: string; children: BlockNode[] };

function blockToken() {
  return /\{\{\{(?:#(each|if|unless)\s+([A-Za-z0-9_.]+)|\/(each|if|unless))\s*\}\}\}/g;
}

// Blocks nest, so opening and closing tags are matched with a stack. A regex that pairs each
// opening tag with the first closing tag of its kind closes an outer block at an inner tag.
function parseBlocks(source: string): BlockNode[] {
  const root: BlockNode[] = [];
  const stack: Array<{ kind: BlockKind; key: string; children: BlockNode[] }> = [];
  const push = (node: BlockNode) => (stack.length > 0 ? stack[stack.length - 1].children : root).push(node);
  let last = 0;
  for (const match of source.matchAll(blockToken())) {
    const index = match.index ?? 0;
    if (index > last) push(source.slice(last, index));
    last = index + match[0].length;
    if (match[1]) {
      stack.push({ kind: match[1] as BlockKind, key: match[2], children: [] });
      continue;
    }
    const open = stack.pop();
    if (!open) throw new ApiError("validation_error", 422, `Template has {{{/${match[3]}}}} with no opening block`);
    if (open.kind !== match[3]) {
      throw new ApiError("validation_error", 422, `Template block {{{#${open.kind} ${open.key}}}} is closed by {{{/${match[3]}}}}`);
    }
    push(open);
  }
  const open = stack.pop();
  if (open) throw new ApiError("validation_error", 422, `Template block {{{#${open.kind} ${open.key}}}} is never closed`);
  if (last < source.length) push(source.slice(last));
  return root;
}

// The reason a template's blocks do not balance, or null when they do.
export function blockProblem(source: string) {
  try {
    parseBlocks(source);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Template blocks are not balanced";
  }
}

function present(value: unknown) {
  return !(value === undefined || value === null || value === "" || value === false || (Array.isArray(value) && value.length === 0));
}

function listItem(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string" || typeof item === "number");
}

export function renderBlocks(
  nodes: BlockNode[],
  scope: Record<string, unknown>,
  peek: (key: string, scope: Record<string, unknown>) => unknown,
  fill: (text: string, scope: Record<string, unknown>) => string
) {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      out += fill(node, scope);
      continue;
    }
    const value = peek(node.key, scope);
    // `unless` is the other half of `if`: it lets a template fall back to another variable.
    if (node.kind === "if" || node.kind === "unless") {
      if (present(value) === (node.kind === "if")) out += renderBlocks(node.children, scope, peek, fill);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value.slice(0, 200)) {
      const fields = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      out += renderBlocks(node.children, { ...scope, ...fields }, peek, fill);
    }
  }
  return out;
}

// A field of the contact a broadcast goes to. A broadcast prints a blank for one the contact
// lacks, so a contact with no first name still gets the email. Other sends fail on it.
export function contactField(key: string) {
  return key.startsWith("contact.") || key === "FIRST_NAME" || key === "LAST_NAME";
}

// `blank` names the keys that print as an empty string when nothing fills them, instead of failing.
export function renderTemplate(
  fields: {
    subject?: string | null;
    html?: string | null;
    text?: string | null;
    variables?: unknown;
  },
  variables: Record<string, unknown>,
  context: Record<string, unknown> = {},
  options: { blank?: (key: string) => boolean } = {}
) {
  const declared = new Map(normalizeVariables(fields.variables).map((item) => [item.key, item]));
  const missing = new Set<string>();

  for (const item of declared.values()) {
    const value = own(variables, item.key);
    if (value === undefined || value === null) continue;
    if (item.type === "list") {
      if (!Array.isArray(value) || value.some((entry) => !listItem(entry))) {
        throw new ApiError("validation_error", 422, `Template variable ${item.key} must be a list`);
      }
    } else if (typeof value !== item.type) {
      throw new ApiError("validation_error", 422, `Template variable ${item.key} must be a ${item.type}`);
    }
  }

  // A field of the current list item wins, even when it is an empty string: the item said so.
  const resolve = (key: string, inline: string | undefined, scope: Record<string, unknown>) => {
    const field = own(scope, key);
    if (field !== undefined && field !== null) return String(field);
    const value = variableAt(key, variables, context);
    if (value !== undefined && value !== null && value !== "") return String(value);
    if (inline !== undefined) return inline;
    const fallback = declared.get(key)?.fallback_value;
    if (fallback !== undefined && fallback !== null) return String(fallback);
    if (options.blank?.(key)) return "";
    missing.add(key);
    return "";
  };

  const peek = (key: string, scope: Record<string, unknown>) => {
    const field = own(scope, key);
    if (field !== undefined && field !== null) return field;
    const value = variableAt(key, variables, context);
    if (value !== undefined && value !== null && value !== "") return value;
    const fallback = declared.get(key)?.fallback_value;
    if (fallback !== undefined && fallback !== null) return fallback;
    return undefined;
  };

  const fill = (source: string | null | undefined, escape: boolean) => {
    if (!source) return undefined;
    const substitute = (text: string, scope: Record<string, unknown>) =>
      text.replace(placeholderPattern(), (_match, triple: string | undefined, inline: string | undefined, double: string | undefined) => {
        const value = resolve((triple ?? double)!, inline, scope);
        return escape ? escapeHtml(value) : value;
      });
    return renderBlocks(parseBlocks(source), {}, peek, substitute);
  };

  const rendered = { subject: fill(fields.subject, false), html: fill(fields.html, true), text: fill(fields.text, false) };
  // The error names the first one. The full list rides along for callers that sort them.
  if (missing.size > 0) {
    throw Object.assign(new ApiError("validation_error", 422, `Missing template variable: ${[...missing][0]}`), { missing: [...missing] });
  }
  return rendered;
}

// Every variable a failed render found no value for, or an empty list for any other error.
export function missingVariables(error: unknown): string[] {
  const listed = (error as { missing?: unknown } | null)?.missing;
  return Array.isArray(listed) ? listed.filter((item): item is string => typeof item === "string") : [];
}
