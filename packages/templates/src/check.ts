import { missingVariables, renderTemplate, reservedVariables } from "@dispatchmail/core";
import { stages } from "./types";

const reserved = [
  "PRODUCT_NAME",
  "PRODUCT_URL",
  "LOGO_URL",
  "BRAND_COLOR",
  "BRAND_TEXT_COLOR",
  "SUPPORT_EMAIL",
  "SUPPORT_URL",
  "PRIVACY_URL",
  "COMPANY_NAME",
  "COMPANY_ADDRESS",
  "CURRENT_YEAR",
  "UNSUBSCRIBE_URL",
] as const;

const reservedNames = new Set<string>(reservedVariables);

const actionKeys = new Set(["ACTION_URL", "SECURE_ACCOUNT_URL", "REVOKE_URL", "CONFIRM_URL"]);

export type ThemePair = {
  name?: string;
  light: { foreground: string; background: string };
  dark: { foreground: string; background: string };
};

type Variable = {
  key: string;
  type: string;
  fallback_value?: string | number | null;
  fields?: string[];
};

type Entry = {
  slug: string;
  category?: string;
  track: boolean;
  kind: string;
  stage?: string | null;
  when?: string;
  subject: string;
  html: string;
  text: string;
  preview?: string;
  variables: Variable[];
  sample?: Record<string, unknown>;
};

const placeholderRe = /\{\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|[^}]*)?\}\}\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

function placeholderKeys(source: string) {
  return [...source.matchAll(placeholderRe)].map((match) => match[1] || match[2]).filter((key): key is string => Boolean(key));
}

function linear(channel: number) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrast(foreground: string, background: string) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function visibleText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function readPreview(html: string) {
  const match = html.match(/data-skip-in-text="true"[^>]*>([\s\S]*?)<div/i);
  return match?.[1]?.trim();
}

function contentKeys(source: string, listFields: Map<string, Set<string>>) {
  const placeholders = new Set<string>();
  const controls = new Set<string>();
  const rest = source.replace(/\{\{\{#each\s+([A-Za-z0-9_.]+)\s*\}\}\}([\s\S]*?)\{\{\{\/each\}\}\}/g, (_match, key: string, inner: string) => {
    controls.add(key);
    const fields = listFields.get(key) ?? new Set<string>();
    for (const match of inner.matchAll(/\{\{\{#(?:if|unless)\s+([A-Za-z0-9_.]+)\s*\}\}\}/g)) {
      const ifKey = match[1];
      if (ifKey && !fields.has(ifKey)) controls.add(ifKey);
    }
    for (const found of placeholderKeys(inner)) {
      if (!fields.has(found)) placeholders.add(found);
    }
    return "";
  });
  for (const match of rest.matchAll(/\{\{\{#(?:if|unless)\s+([A-Za-z0-9_.]+)\s*\}\}\}/g)) {
    if (match[1]) controls.add(match[1]);
  }
  for (const found of placeholderKeys(rest)) placeholders.add(found);
  return { placeholders, controls };
}

function required(variable: Variable) {
  return variable.fallback_value === null || variable.fallback_value === undefined;
}

// Pass only fields supplied by the actual trigger or recipient context, not preview samples.
// Preset builds use this check for each send step against their declared trigger data.
export function checkTemplateVariables(entry: Pick<Entry, "slug" | "variables" | "subject" | "html" | "text">, supplied: readonly string[]) {
  const available = new Set(supplied);
  const missing = new Set(entry.variables
    .filter((variable) => required(variable) && !available.has(variable.key) && !reservedNames.has(variable.key))
    .map((variable) => variable.key));
  const values = Object.fromEntries(supplied.map((key) => {
    const variable = entry.variables.find((item) => item.key === key);
    return [key, variable?.type === "number" ? 0 : variable?.type === "list" ? [] : "supplied"];
  }));
  try {
    renderTemplate(entry, values, brandContext());
  } catch (error) {
    const keys = missingVariables(error);
    if (!keys.length) return [`${entry.slug}: ${error instanceof Error ? error.message : "render failed"}`];
    for (const key of keys) missing.add(key);
  }
  return [...missing].map((key) => `${entry.slug}: required variable ${key} has no fallback or supplied value`);
}

function brandContext() {
  return Object.fromEntries(reserved.map((key) => [key, "Brand"]));
}

function renderEntry(entry: Entry, variables: Record<string, unknown>) {
  return renderTemplate(
    {
      subject: entry.subject,
      html: entry.html,
      text: entry.text,
      variables: entry.variables,
    },
    variables,
    brandContext()
  );
}

export function checkLibrary(library: { templates: Entry[] }, pairs: readonly ThemePair[]) {
  const failures: string[] = [];
  const fail = (slug: string, check: number, message: string) => failures.push(`${slug} check ${check}: ${message}`);

  for (const pair of pairs) {
    for (const mode of ["light", "dark"] as const) {
      const ratio = contrast(pair[mode].foreground, pair[mode].background);
      if (ratio < 4.5) {
        failures.push(`theme check 8: ${pair.name ?? "pair"} ${mode} contrast is ${ratio.toFixed(2)}`);
      }
    }
  }

  for (const entry of library.templates) {
    const html = entry.html ?? "";
    const text = entry.text ?? "";
    if (Buffer.byteLength(html, "utf8") > 80000) fail(entry.slug, 1, `html is ${Buffer.byteLength(html, "utf8")} bytes`);

    const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? "";
    if (!/\blang\s*=/.test(htmlTag) || !/\bdir\s*=/.test(htmlTag)) fail(entry.slug, 2, "<html> is missing lang or dir");

    for (const table of html.match(/<table\b[^>]*>/gi) ?? []) {
      if (!/\brole\s*=\s*["']presentation["']/i.test(table)) fail(entry.slug, 3, `table is missing role="presentation": ${table}`);
    }

    for (const image of html.match(/<img\b[^>]*>/gi) ?? []) {
      if (!/\balt\s*=\s*["'][^"']*["']/.test(image) || !/\bwidth\s*=/.test(image)) {
        fail(entry.slug, 4, `img is missing alt or width: ${image}`);
      }
    }

    if (!/<title\b/i.test(html)) fail(entry.slug, 5, "missing <title>");
    const headings = html.match(/<h1\b/gi)?.length ?? 0;
    if (headings !== 1) fail(entry.slug, 5, `found ${headings} h1 elements`);

    const parsedPreview = readPreview(html);
    const preview = parsedPreview || entry.preview || "";
    if (!parsedPreview && entry.preview && !html.includes(entry.preview)) {
      fail(entry.slug, 6, "preview text is not in the html");
    }
    if (preview.length < 40 || preview.length > 90) {
      fail(entry.slug, 6, `preview is ${preview.length} characters`);
    }

    if (!/name\s*=\s*["']color-scheme["']/i.test(html)) fail(entry.slug, 7, "missing color-scheme");
    if (!/name\s*=\s*["']supported-color-schemes["']/i.test(html)) fail(entry.slug, 7, "missing supported-color-schemes");

    if (!text.trim()) fail(entry.slug, 9, "text is empty");
    const htmlKeys = new Set(placeholderKeys(html));
    const textKeys = new Set(placeholderKeys(text));
    for (const variable of entry.variables) {
      if (!required(variable)) continue;
      if (htmlKeys.has(variable.key) && !textKeys.has(variable.key)) {
        fail(entry.slug, 9, `text is missing required placeholder ${variable.key}`);
      }
    }

    const listFields = new Map(entry.variables.filter((variable) => variable.type === "list").map((variable) => [variable.key, new Set(variable.fields ?? [])]));
    const found = new Set<string>();
    for (const source of [entry.subject, html, text]) {
      const collected = contentKeys(source ?? "", listFields);
      for (const key of collected.placeholders) found.add(key);
      for (const key of collected.controls) found.add(key);
    }
    const declared = new Set(entry.variables.map((variable) => variable.key));
    for (const key of found) {
      if (!declared.has(key) && !reservedNames.has(key)) fail(entry.slug, 10, `${key} is not a declared variable or reserved name`);
    }
    for (const key of declared) {
      if (!found.has(key)) fail(entry.slug, 10, `${key} never appears`);
    }

    try {
      const requiredVars: Record<string, unknown> = {};
      for (const variable of entry.variables) {
        if (!required(variable)) continue;
        if (variable.type === "list") requiredVars[variable.key] = [];
        else if (variable.type === "number") {
          const sample = entry.sample?.[variable.key];
          requiredVars[variable.key] = typeof sample === "number" ? sample : 0;
        } else {
          const sample = entry.sample?.[variable.key];
          requiredVars[variable.key] = typeof sample === "string" ? sample : "sample";
        }
      }
      const rendered = renderEntry(entry, requiredVars);
      for (const field of ["subject", "html", "text"] as const) {
        if (String(rendered[field] ?? "").includes("{{{")) fail(entry.slug, 11, `${field} still contains {{{`);
      }
    } catch (error) {
      fail(entry.slug, 11, error instanceof Error ? error.message : "render failed");
    }

    try {
      const sampleVars: Record<string, unknown> = {};
      for (const variable of entry.variables) {
        const sample = entry.sample?.[variable.key];
        if (variable.type === "list") {
          sampleVars[variable.key] = Array.isArray(sample) ? sample : [];
          continue;
        }
        if (sample !== undefined && sample !== null) sampleVars[variable.key] = sample;
        else if (required(variable)) sampleVars[variable.key] = variable.type === "number" ? 0 : "sample";
      }
      // The comparison against a stored snapshot is in check.test.ts. Here the sample only has to
      // render with nothing left unfilled.
      const rendered = renderEntry(entry, sampleVars);
      for (const field of ["subject", "html", "text"] as const) {
        if (String(rendered[field] ?? "").includes("{{{")) fail(entry.slug, 12, `sample ${field} still contains {{{`);
      }
    } catch (error) {
      fail(entry.slug, 12, error instanceof Error ? error.message : "render failed");
    }

    if (/<script\b/i.test(html)) fail(entry.slug, 13, "contains script");
    if (/<svg\b/i.test(html)) fail(entry.slug, 13, "contains svg");
    if (/<form\b/i.test(html)) fail(entry.slug, 13, "contains form");
    if (/<iframe\b/i.test(html)) fail(entry.slug, 13, "contains iframe");
    if (/<link\b[^>]*stylesheet/i.test(html)) fail(entry.slug, 13, "contains a linked stylesheet");
    if (/display\s*:\s*flex/i.test(html)) fail(entry.slug, 13, "contains display:flex");
    if (/display\s*:\s*grid/i.test(html)) fail(entry.slug, 13, "contains display:grid");

    const textContent = visibleText(html);
    for (const match of html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
      const href = match[2] ?? "";
      if (href && !textContent.includes(href)) fail(entry.slug, 14, `href is not visible text: ${href}`);
    }

    // Authentication emails carry one-time links. Click tracking would route those through a redirect.
    if (entry.category === "authentication" && entry.track !== false) {
      fail(entry.slug, 15, "an authentication template must set track to false");
    }
    if (!entry.track) {
      const allowed = new Set(["{{{PRODUCT_URL}}}", "{{{SUPPORT_URL}}}", "{{{PRIVACY_URL}}}", "mailto:{{{SUPPORT_EMAIL}}}"]);
      for (const variable of entry.variables) {
        if (actionKeys.has(variable.key)) allowed.add(`{{{${variable.key}}}}`);
      }
      for (const match of html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
        const href = match[2] ?? "";
        if (!allowed.has(href)) fail(entry.slug, 15, `href is not allowed on an authentication template: ${href}`);
      }
    }

    if (entry.kind === "marketing") {
      if (!/\bhref\s*=\s*(["'])\{\{\{UNSUBSCRIBE_URL\}\}\}\1/i.test(html)) fail(entry.slug, 16, "missing UNSUBSCRIBE_URL link");
      if (!text.includes("{{{UNSUBSCRIBE_URL}}}")) fail(entry.slug, 16, "text is missing UNSUBSCRIBE_URL");
      if (!textContent.includes("{{{COMPANY_ADDRESS}}}")) fail(entry.slug, 16, "missing visible COMPANY_ADDRESS");
      if (!text.includes("{{{COMPANY_ADDRESS}}}")) fail(entry.slug, 16, "text is missing COMPANY_ADDRESS");
    }
    if (entry.kind !== "transactional" && entry.kind !== "marketing") fail(entry.slug, 17, "invalid kind");
    if (entry.stage !== null && !stages.some((stage) => stage === entry.stage)) fail(entry.slug, 17, "invalid or missing stage");
    if (!entry.when?.trim()) fail(entry.slug, 17, "missing when guidance");
  }

  return failures;
}
