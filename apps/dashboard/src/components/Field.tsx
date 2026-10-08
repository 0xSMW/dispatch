import { badgeLabel } from "./Badge";
import { useId, type ReactNode } from "react";
import { Dropdown } from "./Dropdown";

type Common = {
  label: string;
  /** Gray help line under the control. */
  hint?: ReactNode;
  /** Red message under the control. */
  error?: string | null;
  disabled?: boolean;
  required?: boolean;
  /** Spans both columns in a `.form.two` grid. */
  wide?: boolean;
  className?: string;
};

function Wrap({ id, label, hint, error, wide, className, children }: Common & { id: string; children: ReactNode }) {
  return (
    <div className={["field", wide ? "wide" : "", className ?? ""].filter(Boolean).join(" ")}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <span className="fieldError" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="fieldHint">{hint}</span>
      ) : null}
    </div>
  );
}

export type FieldProps = Common & {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "password" | "number" | "url" | "search" | "date" | "datetime-local";
  placeholder?: string;
  mono?: boolean;
  autoFocus?: boolean;
  name?: string;
  autoComplete?: string;
  step?: number | string;
};

/** Labeled text input. */
export function Field({ value, onChange, type = "text", placeholder, mono, autoFocus, name, autoComplete, step, ...common }: FieldProps) {
  const id = useId();
  return (
    <Wrap id={id} {...common}>
      <input
        id={id}
        name={name}
        type={type}
        step={step ?? (type === "number" ? "any" : undefined)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={common.disabled}
        required={common.required}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        className={mono ? "mono" : undefined}
        aria-invalid={common.error ? true : undefined}
      />
    </Wrap>
  );
}

export type TextAreaProps = Common & {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  autoFocus?: boolean;
};

/** Labeled textarea. `mono` for JSON and HTML. */
export function TextArea({ value, onChange, placeholder, rows = 6, mono, autoFocus, ...common }: TextAreaProps) {
  const id = useId();
  return (
    <Wrap id={id} {...common}>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={common.disabled}
        required={common.required}
        autoFocus={autoFocus}
        className={mono ? "mono" : undefined}
        aria-invalid={common.error ? true : undefined}
      />
    </Wrap>
  );
}

export type Option = { value: string; label: string };

export type SelectProps = Common & {
  value: string;
  onChange: (value: string) => void;
  options: Array<Option | string>;
  /** Adds a first option with an empty value, such as "Any segment". */
  placeholder?: string;
};

/** Labeled select. Options may be plain strings. */
export function Select({ value, onChange, options, placeholder, ...common }: SelectProps) {
  const id = useId();
  return (
    <Wrap id={id} {...common}>
      <Dropdown id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={common.disabled} required={common.required}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => {
          const item = typeof option === "string" ? { value: option, label: badgeLabel(option) } : option;
          return (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          );
        })}
      </Dropdown>
    </Wrap>
  );
}

export type SwitchProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
};

/** On/off switch with its label to the right. */
export function Switch({ label, checked, onChange, hint, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className="switchField">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className={checked ? "switch on" : "switch"}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switchThumb" />
      </button>
      <label htmlFor={id}>
        {label}
        {hint ? <span className="fieldHint">{hint}</span> : null}
      </label>
    </div>
  );
}
