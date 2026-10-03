import { useState } from "react";
import { Field, Select } from "./Field";
import type { PropertyType } from "../types";
import { isIsoDate } from "../lib/rules";

function localTime(value: string): string {
  if (!isIsoDate(value)) return "";
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Raw form state stays a string; callers convert at the JSON boundary. Dates emit ISO. */
export function TypedValue({
  type, value, onChange, label = "Value", disabled, nullable = false, error, hint, placeholder, autoFocus,
}: {
  type: PropertyType;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  nullable?: boolean;
  error?: string | null;
  hint?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [format, setFormat] = useState<"date" | "datetime-local" | "text">(
    !value || /^\d{4}-\d{2}-\d{2}$/.test(value) ? "date" : isIsoDate(value) ? "datetime-local" : "text",
  );
  if (type === "boolean") return (
    <Select label={label} value={value} onChange={onChange} options={["true", "false"]} placeholder={nullable ? "No value" : undefined} disabled={disabled} error={error} hint={hint} />
  );
  if (type !== "date") return (
    <Field label={label} value={value} onChange={onChange} type={type === "number" ? "number" : "text"} disabled={disabled} error={error} hint={hint} placeholder={placeholder} autoFocus={autoFocus} mono />
  );
  return (
    <div className="typedDate stack">
      <Select
        label={`${label} format`} value={format} onChange={(next) => setFormat(next as typeof format)}
        options={[{ value: "date", label: "Date (UTC midnight)" }, { value: "datetime-local", label: "Date and time (local timezone)" }, { value: "text", label: "ISO text" }]} disabled={disabled}
      />
      <Field
        label={label} type={format} value={format === "datetime-local" ? localTime(value) : format === "date" ? value.slice(0, 10) : value}
        step={format === "datetime-local" ? 1 : undefined}
        onChange={(raw) => {
          if (format !== "datetime-local" || !raw) return onChange(raw);
          const date = new Date(raw);
          onChange(Number.isFinite(date.getTime()) ? date.toISOString() : raw);
        }}
        disabled={disabled} error={error} hint={hint} placeholder={placeholder} autoFocus={autoFocus} mono
      />
    </div>
  );
}
