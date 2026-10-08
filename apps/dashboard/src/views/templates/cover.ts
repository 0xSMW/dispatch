export type Cover = {
  brand: string;
  heading: string;
  lead: string;
  action: string;
  code: string;
  details: Array<{ label: string; value: string }>;
};

function text(element: Node | null | undefined) {
  return (element?.textContent ?? "").replace(/[\u200b-\u200f\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

/** A cover is a short composition of the email's own copy, rather than a clipped document. */
export function coverOf(html: string | null | undefined): Cover | null {
  if (!html?.trim() || typeof document === "undefined") return null;
  // Template contents stay inert and are never attached: no scripts, image requests or email CSS
  // enter the dashboard. Only the extracted strings are rendered by React.
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;
  const title = text(root.querySelector("title"));
  root.querySelectorAll("script, style, title, meta, link, iframe, object, embed, svg, noscript, [hidden], [aria-hidden='true'], [data-skip-in-text]").forEach((node) => node.remove());
  root.querySelectorAll<HTMLElement>("[style]").forEach((node) => {
    if (node.style.display === "none" || node.style.visibility === "hidden" || node.style.opacity === "0") node.remove();
  });

  const footer = Array.from(root.querySelectorAll<HTMLElement>(".dm-divider, footer")).find((node) =>
    node.tagName === "FOOTER" || /border-top\s*:/i.test(node.getAttribute("style") ?? ""),
  );
  footer?.remove();
  const heading = root.querySelector("h1, h2, h3");
  const paragraphs = Array.from(root.querySelectorAll("p"));
  const beforeHeading = (node: Element) => Boolean(heading && node.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING);
  const brand = text(paragraphs.find(beforeHeading)) || Array.from(root.querySelectorAll("img[alt]")).find(beforeHeading)?.getAttribute("alt")?.trim() || "";
  const body = paragraphs.filter((node) => !beforeHeading(node));
  const code = root.querySelector("[data-code], pre, code") || body.find((node) => /letter-spacing\s*:\s*[2-9]/i.test(node.getAttribute("style") ?? ""));
  const action = root.querySelector("a.dm-button, a[style*='inline-block'], button") || Array.from(root.querySelectorAll("a")).find((node) =>
    !beforeHeading(node) && !/^mailto:/i.test(node.getAttribute("href") ?? ""),
  );
  const lead = body.find((node) => node !== code && text(node) && !node.contains(action ?? null));
  const details = Array.from(root.querySelectorAll("tr")).flatMap((row) => {
    const cells = Array.from(row.children).filter((node) => /^(TD|TH)$/.test(node.tagName));
    // Layout tables have one cell; line-item tables have three. Only compact label/value rows
    // belong here, keeping invoices and account notices recognizable without copying their table.
    if (cells.length !== 2 || cells.some((cell) => cell.querySelector("table, p, h1, h2, h3, a"))) return [];
    const label = text(cells[0]);
    const value = text(cells[1]);
    return label && value ? [{ label, value }] : [];
  }).slice(0, 2);
  const fallback = text(root.querySelector("p, div, td")) || text(root);
  const headingText = text(heading) || title || text(body[0]) || fallback;
  if (!headingText && !brand) return null;
  return {
    brand,
    heading: headingText,
    lead: !heading && !title && lead === body[0] ? text(body[1]) : text(lead),
    action: text(action),
    code: text(code),
    details,
  };
}

/** Word-aware excerpts keep long tenant copy inside the compact cover. */
export function excerpt(value: string, limit: number) {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > limit / 2 ? cut.slice(0, space) : cut}…`;
}
