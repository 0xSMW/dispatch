import type * as React from "react";
import { useState } from "react";
import { Field, Select, Switch } from "../../components/Field";
import "../../styles/audience.css";

export interface FormDraft {
  name: string;
  topic_ids: string[];
  properties: string[];
  double_opt_in: boolean;
  from_email: string;
  allowed_origins: string[];
  redirect_url: string;
}

export interface FormChoice {
  value: string;
  label: string;
}

export interface FormFieldsProps {
  value: FormDraft;
  topics: readonly FormChoice[];
  properties: readonly FormChoice[];
  senders: readonly FormChoice[];
  onChange: (next: FormDraft) => void;
  disabled?: boolean;
  errors?: Partial<Record<keyof FormDraft, string>>;
}

function choicesWithSelected(choices: readonly FormChoice[], selected: readonly string[]): FormChoice[] {
  return [
    ...choices,
    ...[...new Set(selected)].filter((value) => !choices.some((choice) => choice.value === value))
      .map((value) => ({ value, label: value })),
  ];
}

export function FormFields({
  value, topics, properties, senders, onChange, disabled = false, errors = {},
}: FormFieldsProps): React.JSX.Element {
  const [queries, setQueries] = useState({ topic_ids: "", properties: "" });
  function change(patch: Partial<FormDraft>) {
    if (disabled) return;
    const next = { ...value, ...patch };
    onChange({
      ...next,
      topic_ids: [...next.topic_ids],
      properties: [...next.properties],
      allowed_origins: [...next.allowed_origins],
    });
  }

  function selections(key: "topic_ids" | "properties", label: string, choices: readonly FormChoice[]) {
    const options = choicesWithSelected(choices, value[key]);
    return (
      <fieldset className="checkList formChoices" disabled={disabled} aria-invalid={errors[key] ? true : undefined}>
        <legend>{label}</legend>
        {options.length > 6 ? <Field label={`Search ${label.toLowerCase()}`} value={queries[key]} onChange={(query) => setQueries((current) => ({ ...current, [key]: query }))} disabled={disabled} /> : null}
        {options.filter((choice) => choice.label.toLowerCase().includes(queries[key].toLowerCase())).map((choice) => (
          <label className="check" key={choice.value}>
            <input
              type="checkbox"
              checked={value[key].includes(choice.value)}
              disabled={disabled}
              onChange={(event) => change({
                [key]: event.target.checked
                  ? [...value[key], choice.value]
                  : value[key].filter((item) => item !== choice.value),
              })}
            />
            <span>{choice.label}</span>
          </label>
        ))}
        {!options.length ? <p className="muted">No {label.toLowerCase()} available.</p> : null}
        {errors[key] ? <span className="fieldError" role="alert">{errors[key]}</span> : null}
      </fieldset>
    );
  }

  return (
    <div className="form">
      <Field label="Name" value={value.name} onChange={(name) => change({ name })} disabled={disabled} error={errors.name} />
      {selections("topic_ids", "Topics", topics)}
      {selections("properties", "Properties", properties)}
      <Select
        label="Sender"
        value={value.from_email}
        options={choicesWithSelected(senders, value.from_email ? [value.from_email] : [])}
        placeholder={!value.from_email ? "Select a verified sender" : undefined}
        onChange={(from_email) => change({ from_email })}
        disabled={disabled}
        error={errors.from_email}
      />
      {value.from_email && !senders.some((sender) => sender.value === value.from_email) ? (
        <p className="fieldHint">Current sender: {value.from_email} (not in the supplied verified senders).</p>
      ) : null}
      {!senders.length ? <p className="muted">No verified senders yet.</p> : null}
      <Switch
        label="Double opt-in"
        checked={value.double_opt_in}
        onChange={(double_opt_in) => change({ double_opt_in })}
        disabled={disabled}
      />
      {errors.double_opt_in ? <span className="fieldError" role="alert">{errors.double_opt_in}</span> : null}
      <fieldset className="checkList formChoices" disabled={disabled} aria-invalid={errors.allowed_origins ? true : undefined}>
        <legend>Allowed origins</legend>
        {value.allowed_origins.map((origin, index) => (
          <div className="form" key={index}>
            <Field
              label={`Origin ${index + 1}`}
              value={origin}
              onChange={(next) => change({ allowed_origins: value.allowed_origins.map((item, i) => i === index ? next : item) })}
              disabled={disabled}
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => change({ allowed_origins: value.allowed_origins.filter((_, i) => i !== index) })}
            >
              Remove origin {index + 1}
            </button>
          </div>
        ))}
        <button type="button" disabled={disabled} onClick={() => change({ allowed_origins: [...value.allowed_origins, ""] })}>
          Add origin
        </button>
        {errors.allowed_origins ? <span className="fieldError" role="alert">{errors.allowed_origins}</span> : null}
      </fieldset>
      <Field
        label="Redirect URL"
        type="url"
        value={value.redirect_url}
        onChange={(redirect_url) => change({ redirect_url })}
        hint="Optional HTTPS URL."
        disabled={disabled}
        error={errors.redirect_url}
      />
    </div>
  );
}
