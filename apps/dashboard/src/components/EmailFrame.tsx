export interface EmailFrameProps {
  html: string;
  /** `phone` narrows the frame to 375 px for a mobile preview. */
  width?: "desktop" | "phone";
  /**
   * For mail from outside, such as received email. `block` loads nothing from the network, so a
   * tracking pixel cannot tell the sender that the message was opened. `allow` loads images only.
   */
  remote?: "block" | "allow";
}

const policy = {
  block: "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:",
  allow: "default-src 'none'; img-src data: cid: http: https:; style-src 'unsafe-inline'; font-src data:",
};

/**
 * Adds tags to the document's head. They go after an existing <head>, <html>, or doctype, since a
 * tag placed before the doctype would switch the preview to quirks mode.
 */
export function withHead(html: string, tags: string): string {
  for (const pattern of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(html);
    if (match) return `${html.slice(0, match.index + match[0].length)}${tags}${html.slice(match.index + match[0].length)}`;
  }
  return `${tags}${html}`;
}

/** The framed document: never sends the dashboard's address as Referer, and applies `remote`. */
export function framed(html: string, remote?: "block" | "allow"): string {
  const csp = remote ? `<meta http-equiv="Content-Security-Policy" content="${policy[remote]}">` : "";
  return withHead(html, `<meta name="referrer" content="no-referrer">${csp}`);
}

/**
 * Sandboxed preview of untrusted email HTML. The empty `sandbox` blocks scripts, forms,
 * popups, navigation, and the dashboard origin. Never add `allow-scripts` or `allow-same-origin`,
 * and never render email HTML with `dangerouslySetInnerHTML`.
 */
export function EmailFrame({ html, width = "desktop", remote }: EmailFrameProps) {
  return (
    <iframe
      title="Email preview"
      className={width === "phone" ? "emailFrame phone" : "emailFrame"}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={framed(html, remote)}
    />
  );
}
