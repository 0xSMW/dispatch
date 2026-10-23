export type EmailStatus =
  | "scheduled"
  | "queued"
  | "submitted"
  | "sent"
  | "delivery_delayed"
  | "delivered"
  | "bounced"
  | "complained"
  | "opened"
  | "clicked"
  | "suppressed"
  | "failed"
  | "cancelled";

export const eventTypes = [
  "email.scheduled",
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.opened",
  "email.clicked",
  "email.suppressed",
  "email.received",
  "email.unsubscribed",
  "automation.run.started",
  "automation.run.completed",
  "automation.run.failed",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "contact.topics.updated",
  "domain.created",
  "domain.updated",
  "domain.deleted",
  "suppression.added",
  "suppression.removed",
  "topic.created",
  "topic.updated",
  "topic.deleted"
] as const;

export type EventType = (typeof eventTypes)[number];

// Keep the existing mutable public array separate from the readonly catalog.
export const emailEvents: EventType[] = [...eventTypes];

export function statusFor(type: EventType): EmailStatus {
  switch (type) {
    case "email.sent": return "sent";
    case "email.delivered": return "delivered";
    case "email.delivery_delayed": return "delivery_delayed";
    case "email.bounced": return "bounced";
    case "email.complained": return "complained";
    case "email.failed": return "failed";
    case "email.opened": return "opened";
    case "email.clicked": return "clicked";
    case "email.suppressed": return "suppressed";
    default: return "queued";
  }
}
