export type SendKind = "transactional" | "marketing";

/** Match reserved keys using the renderer's plain and triple-brace default grammar. */
export function contentKind(content: {
  html?: string | null;
  text?: string | null;
}): SendKind {
  const reserved = /\{\{\{\s*(?:UNSUBSCRIBE_URL|RESEND_UNSUBSCRIBE_URL|DISPATCH_UNSUBSCRIBE_URL)\s*(?:\|[^}]*)?\}\}\}|\{\{\s*(?:UNSUBSCRIBE_URL|RESEND_UNSUBSCRIBE_URL|DISPATCH_UNSUBSCRIBE_URL)\s*\}\}/;
  return [content.html, content.text].some((value) => value != null && reserved.test(value))
    ? "marketing" : "transactional";
}

/** Library metadata and reserved unsubscribe placeholders both require Marketing. */
export function templateKind(template: {
  source?: Record<string, unknown> | null;
  html?: string | null;
  text?: string | null;
}): SendKind {
  return template.source?.send_kind === "marketing" ? "marketing" : contentKind(template);
}
