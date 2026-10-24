export { eventTypes as webhookEvents } from "../../../../packages/core/src/events";

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
