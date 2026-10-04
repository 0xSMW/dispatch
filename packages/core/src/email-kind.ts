export type SendKind = "transactional" | "marketing";

/** Library metadata and reserved unsubscribe placeholders both require Marketing. */
export function templateKind(template: {
  source?: Record<string, unknown> | null;
  html?: string | null;
  text?: string | null;
}): SendKind {
  return template.source?.send_kind === "marketing" ||
    /\{\{\{?\s*(?:UNSUBSCRIBE_URL|RESEND_UNSUBSCRIBE_URL|DISPATCH_UNSUBSCRIBE_URL)\s*\}\}\}?/.test(`${template.html ?? ""} ${template.text ?? ""}`)
    ? "marketing" : "transactional";
}
