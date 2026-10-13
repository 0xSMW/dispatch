import { useMemo } from "react";
import { useList } from "../../hooks/useList";
import type { ContactProperty, EventDefinition, Segment, Topic } from "../../types";
import type { StepOptions } from "./Steps";

export function useOptions() {
  const events = useList<EventDefinition>("/events", {}, { all: true });
  const topics = useList<Topic>("/topics", {}, { all: true });
  const segments = useList<Segment>("/segments", {}, { all: true });
  const properties = useList<ContactProperty>("/contact-properties", {}, { all: true });
  const options = useMemo<StepOptions>(() => ({
    templates: [],
    events: events.rows.map((row) => row.name),
    topics: topics.rows.map((row) => ({ value: row.id, label: row.name })),
    segments: segments.rows.map((row) => ({ value: row.id, label: row.name })),
    staticSegments: segments.rows.filter((row) => row.type !== "dynamic").map((row) => ({ value: row.id, label: row.name })),
    contactProperties: properties.rows,
    topicsReady: !topics.loading && !topics.error,
    segmentsReady: !segments.loading && !segments.error,
    propertiesReady: !properties.loading && !properties.error,
    topicsError: topics.error,
    segmentsError: segments.error,
    propertiesError: properties.error,
  }), [events.rows, topics.rows, topics.loading, topics.error, segments.rows, segments.loading, segments.error, properties.rows, properties.loading, properties.error]);
  return { events, topics, segments, options };
}
