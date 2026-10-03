// Webhook event types, mirrored from `emailEvents` in packages/core. The dashboard does not
// import core, which pulls in Node modules.
export const webhookEvents = [
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
  "topic.deleted",
] as const;

export const emailStatuses = [
  "queued",
  "scheduled",
  "sent",
  "delivered",
  "delivery_delayed",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
  "suppressed",
  "canceled",
] as const;

export const domainStatuses = ["not_started", "pending", "verified", "failed", "temporary_failure"] as const;

export const domainRegions = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;
