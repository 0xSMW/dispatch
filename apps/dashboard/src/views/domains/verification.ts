import type { BadgeVariant } from "../../components/Badge";
import type { Domain } from "../../types";

/** Statuses where verification stopped short, so the next step is to fix DNS and retry. */
export const failing = ["failed", "temporary_failure", "partially_failed"];

export type VerificationState = {
  tone: BadgeVariant;
  /** What is true now. */
  summary: string;
  /** What to do next. */
  next: string;
  /** Whether the domain can send: verified, with sending on. */
  ready: boolean;
};

/**
 * Where a domain's verification stands and what to do next, from its status alone. Dispatch
 * stores no history of verification steps, so this never shows steps it cannot know about.
 */
export function verificationState(domain: Pick<Domain, "name" | "status" | "capabilities">): VerificationState {
  switch (domain.status) {
    case "verified":
      return domain.capabilities.sending === "disabled"
        ? {
            tone: "success",
            ready: false,
            summary: `${domain.name} is verified.`,
            next: "Sending is turned off for this domain. Turn on sending in its configuration to send from it.",
          }
        : { tone: "success", ready: true, summary: `${domain.name} is verified.`, next: `You can send from any address at ${domain.name}.` };
    case "pending":
      return {
        tone: "warning",
        ready: false,
        summary: "Verification is in progress.",
        next: "SES is looking for the DNS records below and checks again on its own. DNS changes can take from a few minutes to 72 hours to show up. Check DNS to see what your DNS provider returns now.",
      };
    case "failed":
      return {
        tone: "danger",
        ready: false,
        summary: "Verification failed.",
        next: "SES did not find the records in time. Check DNS to find the wrong or missing record, fix it at your DNS provider, then retry verification.",
      };
    case "temporary_failure":
      return {
        tone: "warning",
        ready: false,
        summary: "Verification stopped because of a temporary problem at SES.",
        next: "Retry verification. If it fails again, check DNS to confirm each record is published.",
      };
    case "partially_failed":
    case "partially_verified":
      return {
        tone: "warning",
        ready: false,
        summary: "Some records are verified and some are not.",
        next: "Check DNS to see which records are wrong or missing, fix them at your DNS provider, then retry verification.",
      };
    default:
      return {
        tone: "neutral",
        ready: false,
        summary: "Verification has not started.",
        next: "Add the DNS records below at your DNS provider, or publish them to Route 53, then verify DNS.",
      };
  }
}

/** The verification button's label: start it the first time, retry it after that. */
export function verifyLabel(status: string) {
  return status === "pending" || failing.includes(status) ? "Retry verification" : "Verify DNS";
}
