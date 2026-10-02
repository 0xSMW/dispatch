import { useState } from "react";
import { CircleAlert } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Drawer } from "../../components/Drawer";
import { Facts } from "../../components/Facts";
import { useMutation } from "../../hooks/useMutation";
import { ApiError } from "../../lib/client";
import { useCan, useClient } from "../../shell/session";
import type { EmailEvent } from "../../types";

type Detail = { type?: string; subType?: string; message?: string };

/**
 * What went wrong, from the last `email.bounced` or `email.suppressed` event (SES's own values).
 * The address comes from the event. When an older event does not name one, the only safe guess is
 * an email with a single recipient: guessing "every To address" once removed a complaint
 * suppression for an address that had not bounced.
 */
export function problemOf(event: EmailEvent, fallback: string[]) {
  const data = event.data ?? {};
  const bounced = event.type === "email.bounced";
  const detail = ((bounced ? data.bounce : data.suppressed) ?? {}) as Detail;
  const listed = Array.isArray(data.recipients) ? (data.recipients as unknown[]).filter((item): item is string => typeof item === "string") : [];
  const recipients = typeof data.email === "string" ? [data.email] : listed.length > 0 ? listed : fallback.length === 1 ? fallback : [];
  return {
    kind: bounced ? ("bounced" as const) : ("suppressed" as const),
    recipients,
    type: detail.type ?? (bounced ? "Undetermined" : "OnAccountSuppressionList"),
    subType: detail.subType ?? null,
    message: detail.message ?? "",
  };
}

export type Problem = ReturnType<typeof problemOf>;

const advice: Record<string, string> = {
  "Permanent/General": "The receiving server will not accept mail for this address. Remove it from your lists.",
  "Permanent/NoEmail": "The address does not exist. Check it for typos, then remove it from your lists.",
  "Permanent/Suppressed": "SES has the address on its own suppression list after earlier bounces.",
  "Permanent/OnAccountSuppressionList": "The address is on your suppression list. Remove it only if you know it accepts mail again.",
  "Transient/General": "The receiving server deferred the message. Retrying later may work.",
  "Transient/MailboxFull": "The mailbox is full. Try again later, or ask the recipient to make room.",
  "Transient/MessageTooLarge": "The message is too large. Link to big files instead of attaching them.",
  "Transient/ContentRejected": "The receiving server rejected the content. Review the wording and the links.",
  "Transient/AttachmentRejected": "The receiving server rejected an attachment. Remove it or change its type.",
  OnAccountSuppressionList: "Dispatch skipped this address because it is on your suppression list. Remove it only if you know it accepts mail again.",
  Undetermined: "The receiving server did not say why. Read the message below for clues.",
};

/** Suggested next step for a bounce type and subtype. */
export function adviceFor(problem: Pick<Problem, "type" | "subType">) {
  return advice[`${problem.type}/${problem.subType}`] ?? advice[problem.type] ?? advice.Undetermined;
}

/** The red banner on a bounced or suppressed email, with the "See details" drawer. */
export function ProblemBanner({ problem }: { problem: Problem }) {
  const client = useClient();
  const can = useCan();
  const [open, setOpen] = useState(false);
  const unsuppress = useMutation(
    async () => {
      let removed = 0;
      for (const email of problem.recipients) {
        try {
          await client.delete(`/suppressions/${encodeURIComponent(email)}`);
          removed += 1;
        } catch (error) {
          if (!(error instanceof ApiError && error.statusCode === 404)) throw error;
        }
      }
      if (removed === 0) throw new Error("The address is not on the suppression list.");
      return removed;
    },
    { success: (count) => (count === 1 ? "Address removed from the suppression list." : `${count} addresses removed from the suppression list.`) },
  );

  // Without a known address there is nothing safe to remove.
  const remove = can && problem.recipients.length ? (
    <button type="button" className="secondary small" disabled={unsuppress.isLoading} onClick={() => void unsuppress.mutate()}>
      Remove from suppression list
    </button>
  ) : null;

  return (
    <>
      <div className="problem" role="alert">
        <CircleAlert size={16} aria-hidden />
        <span>
          {problem.kind === "bounced" ? "This email bounced" : "This email was suppressed"} for {problem.recipients.join(", ") || "a recipient"}.
        </span>
        {remove}
        <button type="button" className="secondary small" onClick={() => setOpen(true)}>
          See details
        </button>
      </div>
      <Drawer isOpen={open} onClose={() => setOpen(false)} label={problem.kind === "bounced" ? "Bounce" : "Suppression"} title="What happened" actions={remove}>
        <div className="stack">
          <Facts
            columns={2}
            items={[
              { label: "Recipient", value: problem.recipients.join(", ") || "Not recorded" },
              { label: "Type", value: <Badge value={problem.type} variant="danger" /> },
              { label: "Subtype", value: problem.subType, hidden: !problem.subType },
            ]}
          />
          <section className="stack">
            <h3>Suggested action</h3>
            <p>{adviceFor(problem)}</p>
          </section>
          {problem.message ? (
            <section className="stack">
              <h3>Message</h3>
              <p className="mono wrapText">{problem.message}</p>
            </section>
          ) : null}
        </div>
      </Drawer>
    </>
  );
}
