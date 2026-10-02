export type BadgeVariant = "success" | "danger" | "warning" | "info" | "accent" | "neutral";

// Green is reserved for a confirmed outcome, so `sent` is gray and `queued` is amber.
const variants: Record<string, BadgeVariant> = {
  delivered: "success", verified: "success", subscribed: "success", enabled: "success", completed: "success", success: "success", published: "success",
  bounced: "danger", failed: "danger", complained: "danger", unsubscribed: "danger", bounce: "danger", partially_failed: "danger",
  pending: "warning", scheduled: "warning", queued: "warning", complaint: "warning", temporary_failure: "warning", delivery_delayed: "warning", waiting: "warning",
  opened: "info", running: "info", attempting: "info", sending: "info",
  clicked: "accent",
  sent: "neutral", suppressed: "neutral", not_started: "neutral", disabled: "neutral", manual: "neutral", draft: "neutral", canceled: "neutral", cancelled: "neutral",
  // Dispatch-only states
  ok: "success", done: "success", opt_in: "success",
  error: "danger", revoked: "danger", opt_out: "danger",
  paused: "warning", ready: "warning", retrying: "warning",
  stopped: "neutral",
};

/** Maps a status, event type, or HTTP code to a badge color. Event types use their last part. */
export function statusToVariant(status: string | number): BadgeVariant {
  const value = String(status).toLowerCase();
  if (/^\d{3}$/.test(value)) {
    const code = Number(value);
    if (code >= 200 && code < 300) return "success";
    if (code >= 400) return "danger";
    return "neutral";
  }
  if (/^[1-5]xx$/.test(value)) return value.startsWith("2") ? "success" : value.startsWith("4") || value.startsWith("5") ? "danger" : "neutral";
  return variants[value] ?? variants[value.split(".").at(-1) ?? ""] ?? "neutral";
}

export interface BadgeProps {
  value: string | number;
  variant?: BadgeVariant;
  /** Text to show instead of `value`. */
  label?: string;
  className?: string;
}

export function Badge({ value, variant, label, className = "" }: BadgeProps) {
  const tone = variant ?? statusToVariant(value);
  return <span className={`badge ${tone} ${className}`.trim()}>{label ?? String(value).replaceAll("_", " ")}</span>;
}

