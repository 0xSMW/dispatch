import { useId } from "react";
import { Field } from "./Field";
import type { ContextField as ContextFieldRow } from "../lib/rules";

/** Rules and template mappings deliberately share these exact context paths. */
export function ContextField({
  value, onChange, fields, disabled = false, label = "Field",
}: {
  value: string;
  onChange: (value: string) => void;
  fields: ContextFieldRow[];
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  return (
    <div className="contextField stack">
      <div className="field">
        <label htmlFor={id}>Choose {label.toLowerCase()}</label>
        <select id={id} value={fields.some((field) => field.path === value) ? value : ""} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
          <option value="">Custom field</option>
          {(["Event", "Contact", "Topics", "Segments"] as const).map((group) => {
            const rows = fields.filter((field) => field.group === group);
            return rows.length ? (
              <optgroup key={group} label={group}>
                {rows.map((field) => <option key={field.path} value={field.path}>{field.label} ({field.type})</option>)}
              </optgroup>
            ) : null;
          })}
        </select>
      </div>
      <Field label={label} value={value} onChange={onChange} placeholder="event.plan" mono disabled={disabled} />
    </div>
  );
}
