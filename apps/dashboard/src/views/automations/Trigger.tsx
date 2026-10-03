import { Select } from "../../components/Field";
import { TypedValue } from "../../components/TypedValue";
import type { RuleSources } from "../../lib/rules";
import type { PropertyType } from "../../types";
import { EventInput, type StepOptions } from "./Steps";
import { defaultTrigger, stepError, triggerChoices, triggerFields, triggerWarning, type TriggerConfig, type TriggerType } from "./graph";

/** Only completed resource lists can establish that a trigger's resource was deleted. */
export function triggerSources(options?: StepOptions): RuleSources {
  return {
    properties: options?.propertiesReady === false ? undefined : options?.contactProperties,
    topics: options?.topicsReady === false ? undefined : options?.topics,
    segments: options?.segmentsReady === false ? undefined : options?.segments,
  };
}

export function triggerLoading(config: TriggerConfig, options?: StepOptions): boolean {
  if (config.type === "topic_subscribed") return options?.topicsReady === false;
  if (config.type === "segment_added") return options?.segmentsReady === false;
  if (config.type === "contact_updated" && config.field) return options?.propertiesReady === false;
  return false;
}

/** The create modal, list card and canvas panel edit exactly the same trigger config. */
export function TriggerForm({
  config, onChange, options, disabled = false, errors = {}, eventLabel = "Event",
}: {
  config: TriggerConfig;
  onChange: (config: TriggerConfig) => void;
  options?: StepOptions;
  disabled?: boolean;
  errors?: Record<string, string>;
  eventLabel?: string;
}) {
  const sources = triggerSources(options);
  const warning = triggerWarning(config, sources);
  const fields = triggerFields(options?.contactProperties);
  const field = config.type === "contact_updated" ? fields.find((row) => row.key === config.field) : undefined;
  const sourceError = config.type === "topic_subscribed" ? options?.topicsError
    : config.type === "segment_added" ? options?.segmentsError
    : config.type === "contact_updated" ? options?.propertiesError : undefined;
  const resources = config.type === "topic_subscribed" ? options?.topics ?? []
    : config.type === "segment_added" ? options?.segments ?? [] : [];
  const resourceId = config.type === "topic_subscribed" ? config.topic_id : config.type === "segment_added" ? config.segment_id : "";
  const resourceOptions = resourceId && !resources.some((row) => row.value === resourceId)
    ? [{ value: resourceId, label: warning ? `Deleted: ${resourceId}` : resourceId }, ...resources] : resources;

  return (
    <>
      <Select
        label="Trigger"
        value={config.type}
        onChange={(type) => onChange(defaultTrigger(type as TriggerType))}
        options={triggerChoices}
        disabled={disabled}
        error={errors.type}
      />
      {config.type === "event" ? (
        <EventInput
          label={eventLabel}
          value={config.event_name}
          onChange={(event_name) => onChange({ type: "event", event_name })}
          events={options?.events ?? []}
          error={errors.event_name}
          hint="Runs when your app sends this event with POST /events/send."
          disabled={disabled}
        />
      ) : config.type === "contact_created" ? (
        <p className="fieldHint">Runs when a new contact is added or a deleted contact is restored.</p>
      ) : config.type === "contact_updated" ? (
        <>
          <Select
            label="Contact field"
            value={config.field ?? ""}
            placeholder="Any change"
            options={[
              ...(config.field && !field ? [{ value: config.field, label: config.field }] : []),
              ...fields.map((row) => ({ value: row.key, label: `${row.key} (${row.type})` })),
            ]}
            onChange={(key) => onChange(key ? { type: "contact_updated", field: key } : { type: "contact_updated" })}
            disabled={disabled}
            error={errors.field}
            hint="Leave the field unset to match any contact change."
          />
          {config.field ? (["from", "to"] as const).map((key) => {
            const label = key === "from" ? "From" : "To";
            const value = config[key];
            const mode = value === undefined ? "" : value === null ? "empty" : "value";
            const type = field?.type ?? "string";
            const set = (next: TriggerConfig & { type: "contact_updated" }) => onChange(next);
            return (
              <div className="stack" key={`${config.field}:${key}`}>
                <Select
                  label={`${label} match`}
                  value={mode}
                  placeholder="Any value"
                  options={[{ value: "value", label: "A specific value" }, { value: "empty", label: "No value (null)" }]}
                  disabled={disabled || !field}
                  onChange={(next) => {
                    const updated = { ...config };
                    if (!next) delete updated[key];
                    else updated[key] = next === "empty" ? null : initialValue(type);
                    set(updated);
                  }}
                  error={mode !== "value" ? errors[key] : undefined}
                />
                {mode === "value" ? (
                  <TypedValue
                    type={type}
                    label={label}
                    value={typeof value === "number" && !Number.isFinite(value) ? "" : String(value)}
                    onChange={(raw) => set({ ...config, [key]: type === "number" ? (raw.trim() ? Number(raw) : NaN) : type === "boolean" ? raw === "true" : raw })}
                    disabled={disabled || !field}
                    error={errors[key]}
                  />
                ) : null}
              </div>
            );
          }) : null}
        </>
      ) : (
        <Select
          label={config.type === "topic_subscribed" ? "Topic" : "Segment"}
          value={resourceId}
          placeholder={config.type === "topic_subscribed" ? "Choose a topic" : "Choose a segment"}
          options={resourceOptions}
          onChange={(value) => onChange(config.type === "topic_subscribed" ? { type: config.type, topic_id: value } : { type: config.type, segment_id: value })}
          disabled={disabled || triggerLoading(config, options)}
          error={errors[config.type === "topic_subscribed" ? "topic_id" : "segment_id"]}
          hint={config.type === "segment_added" ? "Runs when a contact joins this static segment." : undefined}
        />
      )}
      {warning ? <p className="notice warning" role="status">{warning}. Choose another {config.type === "topic_subscribed" ? "topic" : "segment"} before starting this automation.</p> : null}
      {sourceError ? <p className="fieldError" role="alert">Could not load trigger fields: {sourceError}</p> : null}
      {errors[stepError] ? <p className="fieldError" role="alert">{errors[stepError]}</p> : null}
    </>
  );
}

function initialValue(type: PropertyType): string | number | boolean {
  return type === "number" ? 0 : type === "boolean" ? false : "";
}
