export const inlinePattern = () => /\{\{\{\s*[A-Za-z0-9_.]+\s*\|[^}]*\}\}\}/g;

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

/** Consume complete inline defaults before tags. Their contents are literal text, not HTML. */
export function mapText(html: string, replace: (text: string) => string, markup: (html: string) => string = (html) => html) {
  const token = new RegExp(inlinePattern().source, "y");
  const tagStart = /^<(?:[A-Za-z][^\s/>]*|\/[A-Za-z][^\s/>]*|!|\?)/;
  let out = "";
  let start = 0;
  let index = 0;
  while (index < html.length) {
    token.lastIndex = index;
    const match = html.startsWith("{{{", index) ? token.exec(html) : null;
    if (match) {
      index += match[0].length;
      continue;
    }
    if (html[index] !== "<" || !tagStart.test(html.slice(index))) {
      index++;
      continue;
    }
    let end = index + 1;
    if (html.startsWith("<!--", index)) {
      const close = html.indexOf("-->", end);
      end = close < 0 ? html.length : close + 3;
    } else {
      let quote = "";
      for (; end < html.length; end++) {
        const char = html[end]!;
        if (quote) {
          if (char === quote) quote = "";
        } else if (char === '"' || char === "'") quote = char;
        else if (char === ">") {
          end++;
          break;
        }
      }
    }
    out += replace(html.slice(start, index)) + markup(html.slice(index, end));
    const raw = html.slice(index, end).match(/^<(script|style|textarea|title)(?:\s|>)/i)?.[1];
    if (raw) {
      const close = new RegExp(`</${raw}(?:\\s|>)`, "i").exec(html.slice(end));
      const until = close ? end + close.index : html.length;
      out += markup(html.slice(end, until));
      end = until;
    }
    start = index = end;
  }
  return out + replace(html.slice(start));
}

/** A safe parsing copy only. Never decode or rewrite the stored source. */
export function encodeInlineDefaults(html: string) {
  return mapText(html, (text) => text.replace(inlinePattern(), escapeHtml));
}
