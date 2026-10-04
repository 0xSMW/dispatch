import type { SendKind } from "../types";

export const kindLabels: Record<SendKind, string> = { transactional: "Transactional", marketing: "Marketing" };

export type TemplateContent = { kind?: SendKind; source?: Record<string, unknown> | null; html?: string | null; text?: string | null };

/** Match the API's reserved unsubscribe placeholders, in HTML or plain text. */
export function contentKind(content: TemplateContent): SendKind {
  return /\{\{\{?\s*(?:UNSUBSCRIBE_URL|RESEND_UNSUBSCRIBE_URL|DISPATCH_UNSUBSCRIBE_URL)\s*\}\}\}?/.test(`${content.html ?? ""} ${content.text ?? ""}`)
    ? "marketing" : "transactional";
}

export function templateKind(template: TemplateContent): SendKind {
  return template.kind === "marketing" || template.source?.send_kind === "marketing" ? "marketing" : contentKind(template);
}

/** Legacy steps without an explicit kind used the topic to choose their send behavior. */
export function sendKind(config: Record<string, unknown>): SendKind {
  return config.kind === "marketing" || (config.kind === undefined && Boolean(config.topic_id)) ? "marketing" : "transactional";
}

export const sendSemantics: Record<SendKind, string> = {
  transactional: "Always sent, regardless of contact or topic opt-outs. No unsubscribe header is added. Bounces and suppressions still apply.",
  marketing: "Respects contact and topic opt-outs and adds an unsubscribe header. Choose a topic before starting; drafts can be saved without one.",
};
