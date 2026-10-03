// The round-trip guard for the visual editor. Nothing here imports the editor
// package, so the code editor can use these checks without loading it.
import { encodeInlineDefaults, mapText } from "./inline";

/** `{{{KEY}}}`, `{{{KEY|fallback}}}`, block tags such as `{{{#if X}}}`, and `{{key}}`, in source order. */
const tokenPattern = /\{\{\{[\s\S]*?\}\}\}|\{\{[^{}]+\}\}/g;
const blockPattern = /^\{\{\{\s*[#/]/;

// The editor writes `&` in an attribute as `&amp;`. Both mean the same URL once parsed, so they compare equal.
function decode(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function tokens(html: string | null | undefined): string[] {
  const out: string[] = [];
  const collect = (source: string, attribute: boolean) => {
    for (const match of source.matchAll(tokenPattern)) out.push(attribute ? decode(match[0]) : match[0]);
    return source;
  };
  mapText(html ?? "", (text) => collect(text, false), (markup) => collect(markup, true));
  return out;
}

export function blocks(html: string | null | undefined): string[] {
  return tokens(html).filter((token) => blockPattern.test(token));
}

/** Items of `before` that `after` has fewer of, counting repeats. */
function missing(before: string[], after: string[]) {
  const left = new Map<string, number>();
  for (const item of after) left.set(item, (left.get(item) ?? 0) + 1);
  const out: string[] = [];
  for (const item of before) {
    const count = left.get(item) ?? 0;
    if (count > 0) left.set(item, count - 1);
    else out.push(item);
  }
  return out;
}

function same(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

type Parts = { links: string[]; images: string[]; styles: string[] };

function parts(html: string): Parts {
  const doc = new DOMParser().parseFromString(encodeInlineDefaults(html), "text/html");
  return {
    links: [...doc.querySelectorAll("a[href]")].map((element) => element.getAttribute("href") ?? ""),
    images: [...doc.querySelectorAll("img[src]")].map((element) => element.getAttribute("src") ?? ""),
    styles: [...doc.querySelectorAll("style")].map((element) => (element.textContent ?? "").trim()).filter(Boolean),
  };
}

// A block tag between list items, table rows, or table cells. The editor wraps such a tag in a list
// item or paragraph of its own (and the HTML parser moves it out of a table), so the loop or condition
// would come back around different markup.
const opensRow = /(?:<(?:table|thead|tbody|tfoot|tr|ul|ol)\b[^>]*>|<\/(?:tr|td|th|li|thead|tbody|tfoot|caption|colgroup)>)$/i;
const closesRow = /^(?:<(?:tr|td|th|li|thead|tbody|tfoot)\b|<\/(?:tr|table|tbody|thead|tfoot|ul|ol)>)/i;
const leadingBlocks = /^(?:\s|\{\{\{\s*[#/][^}]*\}\}\})*/;

// Drops whitespace and block tags from the end, so a run of tags such as `{{{/if}}}{{{/each}}}` is seen as one.
function trimBlocksEnd(text: string) {
  let out = text.trimEnd();
  while (out.endsWith("}}}")) {
    const start = out.lastIndexOf("{{{");
    if (start < 0 || !blockPattern.test(out.slice(start))) break;
    out = out.slice(0, start).trimEnd();
  }
  return out;
}

/** The first block tag that sits between list items or table rows, or null. */
export function stranded(source: string): string | null {
  // A comment between a row and a block tag must not hide the tag: the browser still moves the
  // tag out of the table, and the loop would come back empty.
  const html = source.replace(/<!--[\s\S]*?-->/g, "");
  for (const match of html.matchAll(tokenPattern)) {
    if (!blockPattern.test(match[0])) continue;
    const start = match.index ?? 0;
    const left = trimBlocksEnd(html.slice(0, start));
    const right = html.slice(start + match[0].length).replace(leadingBlocks, "");
    if (opensRow.test(left) && closesRow.test(right)) return decode(match[0]);
  }
  return null;
}

// The editor shows the email's own markup inside the dashboard page, not inside the sandboxed
// preview frame. HTML that could cover the page, or carry a script link, is never loaded into it.
const safeLink = /^(?:https?:\/\/|mailto:|tel:|#|\/|\{\{)/i;
const overPage = /(?:^|;)\s*(?:position\s*:\s*(?:fixed|absolute|sticky)|z-index\s*:)/i;

function unsafe(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const element of doc.querySelectorAll("[style]")) {
    if (overPage.test(element.getAttribute("style") ?? "")) {
      return "This HTML places content over the page with position or z-index, which visual mode does not open.";
    }
  }
  for (const element of doc.querySelectorAll("a[href], area[href]")) {
    // Browsers ignore whitespace and control characters inside a scheme, so they are removed first.
    const href = (element.getAttribute("href") ?? "").replace(/[\u0000-\u0020]/g, "");
    if (href && !safeLink.test(href)) return `Visual mode does not open the link ${href.slice(0, 40)}.`;
  }
  for (const element of doc.querySelectorAll("img[src]")) {
    if (/^(?:data|blob):/i.test((element.getAttribute("src") ?? "").trim())) {
      return "This HTML holds an image as data, which mail clients block. Use an image URL to edit it in visual mode.";
    }
  }
  if (doc.querySelector("script, iframe, object, embed, form")) return "This HTML has a script, frame, or form, which visual mode does not open.";
  return null;
}

/** The part of the check that needs no editor, so the page can refuse before loading the package. */
export function blocked(html: string): string | null {
  const tag = stranded(html);
  if (tag) return `${tag} sits between list items or table rows, which visual mode cannot keep.`;
  // Saved documents load defaults as literal text; native clipboard HTML does not.
  return unsafe(encodeInlineDefaults(html));
}

/** Check raw clipboard HTML, since native paste/drop consumes it without shielding inline defaults. */
export function unsafePaste(html: string): boolean {
  return unsafe(html) !== null;
}

/**
 * The part of a document the editor wrote that it should load again: the 600 px container inside
 * its outer table. Loading the whole document instead nests one more container on every visit.
 * Null when `html` is not shaped like the editor's own output.
 */
export function unwrap(html: string): string | null {
  const doc = new DOMParser().parseFromString(encodeInlineDefaults(html), "text/html");
  const outer = doc.body.children.length === 1 ? doc.body.children[0]! : null;
  if (!outer || outer.tagName !== "TABLE" || outer.getAttribute("role") !== "presentation") return null;
  const cell = outer.querySelector(":scope > tbody > tr > td");
  const inner = cell && cell.children.length === 1 ? cell.children[0]! : null;
  if (!cell || !inner || inner.tagName !== "TABLE" || !/max-width/.test(inner.getAttribute("style") ?? "")) return null;
  return cell.innerHTML;
}

// Whitespace around tags is layout from the formatter, not content.
function squash(html: string) {
  return html.replace(/>\s+/g, ">").replace(/\s+</g, "<").replace(/\s*\/>/g, "/>").replace(/\s+/g, " ").trim();
}

/** True when two HTML strings differ only in the whitespace a formatter adds. */
export function sameMarkup(left: string, right: string) {
  return squash(left) === squash(right);
}

function some(items: string[]) {
  const first = items[0]!;
  return items.length === 1 ? first : `${items.length}, such as ${first}`;
}

/**
 * Why the editor's HTML (`after`) loses something from the source (`before`), in one line, or null
 * when every placeholder and block tag is kept in the same order, and every link, image, and
 * style block is kept.
 */
export function loss(before: string, after: string): string | null {
  const lostTokens = missing(tokens(before), tokens(after));
  if (lostTokens.length > 0) return `Visual mode would change ${lostTokens.length === 1 ? "the placeholder" : "placeholders"} ${some(lostTokens)}.`;
  if (!same(blocks(before), blocks(after))) return "Visual mode would reorder the block tags.";
  // The whole sequence, not only the counts. A placeholder that moves out of its loop keeps the
  // counts and breaks the email. Text that was escaped braces and comes back as a live
  // placeholder adds one.
  const added = missing(tokens(after), tokens(before));
  if (added.length > 0) return `Visual mode would turn text into ${added.length === 1 ? "the placeholder" : "placeholders"} ${some(added)}.`;
  if (!same(tokens(before), tokens(after))) return "Visual mode would move placeholders in or out of their blocks.";
  const early = blocked(before);
  if (early) return early;
  const source = parts(before);
  const result = parts(after);
  const lostLinks = missing(source.links, result.links);
  if (lostLinks.length > 0) return `Visual mode would drop ${lostLinks.length === 1 ? "the link" : "links"} ${some(lostLinks)}.`;
  const lostImages = missing(source.images, result.images);
  if (lostImages.length > 0) return `Visual mode would drop ${lostImages.length === 1 ? "the image" : "images"} ${some(lostImages)}.`;
  if (source.styles.some((style) => !result.styles.includes(style))) return "Visual mode would drop the <style> block.";
  return null;
}

/**
 * The HTML to store from the editor's output. The formatted copy reads better in Code mode, but the
 * formatter wraps long lines at spaces and can split a tag such as `{{{#if PRODUCT_URL}}}` in two.
 * When it changes any token, the unformatted copy is stored instead.
 */
export function pick(out: { html: string; unformattedHtml: string }) {
  return same(tokens(out.html), tokens(out.unformattedHtml)) ? out.html : out.unformattedHtml;
}
