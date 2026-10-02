import type { ReactNode } from "react";
import { Badge, statusToVariant, type BadgeVariant } from "./Badge";
import { Time } from "./Time";

export type TimelineEvent = {
  id?: string;
  /** Short label, such as "Delivered". Colored by `statusToVariant(status ?? label)`. */
  label: string;
  status?: string;
  time?: string | null;
  icon?: ReactNode;
  /** Shown on hover, for example a bounce reason. */
  detail?: string;
  variant?: BadgeVariant;
};

export interface EventTimelineProps {
  events: TimelineEvent[];
  empty?: ReactNode;
}

/** Horizontal row of event nodes, each with a label pill and an absolute time. */
export function EventTimeline({ events, empty = null }: EventTimelineProps) {
  if (events.length === 0) return <>{empty}</>;
  return (
    <ol className="eventTimeline">
      {events.map((event, index) => {
        const variant = event.variant ?? statusToVariant(event.status ?? event.label);
        return (
          <li key={event.id ?? `${event.label}-${index}`} className={`eventNode ${variant}`} title={event.detail}>
            <span className="eventDot" aria-hidden>
              {event.icon}
            </span>
            <Badge value={event.status ?? event.label} label={event.label} variant={variant} />
            <span className="eventTime">
              <Time value={event.time} mode="absolute" />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
