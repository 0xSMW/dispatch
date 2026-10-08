import type { ReactNode } from "react";
import { Inbox, Mail, Users, Target, Globe2, KeyRound, Webhook, Zap, FileText, GitBranch, Megaphone, Tags, Braces, Filter, Activity, ScrollText, Plug } from "lucide-react";

export interface EmptyProps {
  title?: string;
  body?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}

function emptyIcon(title: string) {
  const icons = [["contact", Users], ["goal", Target], ["domain", Globe2], ["key", KeyRound], ["webhook", Webhook], ["event", Zap], ["template", FileText], ["automation", GitBranch], ["broadcast", Megaphone], ["topic", Tags], ["propert", Braces], ["segment", Filter], ["activ", Activity], ["log", ScrollText], ["integration", Plug], ["email", Mail]] as const;
  const Icon = icons.find(([word]) => title.toLowerCase().includes(word))?.[1] ?? Inbox;
  return <Icon size={28} strokeWidth={1.5} />;
}

/** "No results" with a line of help under it. Tables use it for empty pages. */
export function Empty({ title = "No results", body, action, icon, compact = false }: EmptyProps) {
  return (
    <div className={`empty${compact ? " compact" : ""}`}>
      <span className="emptyIcon" aria-hidden>{icon ?? emptyIcon(title)}</span>
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
      {action ? <div className="emptyActions">{action}</div> : null}
    </div>
  );
}

/** Error state with a retry button. */
export function Failed({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty failed" role="alert">
      <strong>Could not load</strong>
      <p>{message}</p>
      {onRetry ? (
        <button type="button" className="secondary small" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
