export interface EmailFrameProps {
  html: string;
  /** `phone` narrows the frame to 375 px for a mobile preview. */
  width?: "desktop" | "phone";
  /**
   * For mail from outside, such as received email. `block` loads nothing from the network, so a
   * tracking pixel cannot tell the sender that the message was opened. `allow` loads images only.
   */
  remote?: "block" | "allow";
  /** Static, clipped card preview; the full preview remains scrollable. */
  thumbnail?: boolean;
}

const policy = {
  block: "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:",
  allow: "default-src 'none'; img-src data: cid: http: https:; style-src 'unsafe-inline'; font-src data:",
};

/** The framed document: never sends the dashboard's address as Referer, and applies `remote`. */
export function framed(html: string, remote?: "block" | "allow", thumbnail = false): string {
  const csp = remote ? `<meta http-equiv="Content-Security-Policy" content="${policy[remote]}">` : "";
  // Parse the trusted head before any email content. Searching the email for a head tag could
  // match a comment or malformed markup, leaving the policy inactive or after a tracking pixel.
  const thumbnailStyle = thumbnail ? "<style>html,body{overflow:hidden!important;scrollbar-width:none!important}::-webkit-scrollbar{display:none!important}</style>" : "";
  return `<!doctype html><html><head><meta name="referrer" content="no-referrer">${csp}</head><body>${html}${thumbnailStyle}</body></html>`;
}

/**
 * Sandboxed preview of untrusted email HTML. The empty `sandbox` blocks scripts, forms,
 * popups, navigation, and the dashboard origin. Never add `allow-scripts` or `allow-same-origin`,
 * and never render email HTML with `dangerouslySetInnerHTML`.
 */
export function EmailFrame({ html, width = "desktop", remote, thumbnail = false }: EmailFrameProps) {
  return (
    <iframe
      title="Email preview"
      className={width === "phone" ? "emailFrame phone" : "emailFrame"}
      sandbox=""
      referrerPolicy="no-referrer"
      tabIndex={thumbnail ? -1 : undefined}
      scrolling={thumbnail ? "no" : undefined}
      srcDoc={framed(html, remote, thumbnail)}
    />
  );
}
