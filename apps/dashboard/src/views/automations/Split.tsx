import { Field } from "../../components/Field";
import type { SplitVariant } from "../../types";

export type SplitProps = {
  variants: SplitVariant[];
  onChange: (variants: SplitVariant[]) => void;
  disabled?: boolean;
  /** Field paths are variants.N.label/key/weight; variants and weights cover the group. */
  issues?: Record<string, string>;
};

/** Edits configuration only. The builder owns connections, saving and paused-version changes. */
export function Split({ variants, onChange, disabled = false, issues = {} }: SplitProps) {
  const errors: Record<string, string> = {};
  if (variants.length < 2 || variants.length > 4) errors.variants = "Use 2–4 variants.";
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  if (total !== 100) errors.weights = "Variant weights must total 100%.";
  variants.forEach((variant, index) => {
    const path = `variants.${index}`;
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(variant.key)) errors[`${path}.key`] = "Use a valid variant key.";
    else if (variants.some((other, otherIndex) => otherIndex !== index && other.key === variant.key)) {
      errors[`${path}.key`] = "Variant keys must be unique.";
    }
    if (!variant.label.trim() || variant.label.trim().length > 120) {
      errors[`${path}.label`] = "Use a label of 1–120 characters.";
    }
    if (!Number.isInteger(variant.weight) || variant.weight < 0 || variant.weight > 100) {
      errors[`${path}.weight`] = "Use a whole percentage from 0 to 100.";
    }
  });
  const feedback = { ...errors, ...issues };
  const edit = (index: number, value: Partial<Pick<SplitVariant, "label" | "weight">>) => {
    if (!disabled) onChange(variants.map((variant, row) => row === index ? { ...variant, ...value } : variant));
  };
  const add = () => {
    if (disabled || variants.length >= 4) return;
    let index = 1;
    while (variants.some((variant) => variant.label.trim() === `Variant ${index}`)) index++;
    // Fresh identities avoid merging a new path with historical assignments after reopening.
    let key = `variant_${crypto.randomUUID()}`;
    while (variants.some((variant) => variant.key === key)) key = `variant_${crypto.randomUUID()}`;
    onChange([...variants, { key, label: `Variant ${index}`, weight: 0 }]);
  };

  return (
    <div className="stack" aria-label="Split variants">
      <p className="fieldHint">Use 2–4 variants totaling 100%. Zero-weight paths stay connected but receive no new assignments.</p>
      {variants.map((variant, index) => (
        <div className="stack" key={`${variant.key}:${index}`}>
          <div className="mono dim">Path: {variant.key}</div>
          <Field label={`Variant ${index + 1} label`} value={variant.label} disabled={disabled}
            onChange={(label) => edit(index, { label })} error={feedback[`variants.${index}.label`]} />
          <Field label={`Variant ${index + 1} weight (%)`} type="number" step={1} value={String(variant.weight)}
            disabled={disabled} onChange={(value) => edit(index, { weight: value === "" ? 0 : Number(value) })}
            error={feedback[`variants.${index}.weight`]} />
          {feedback[`variants.${index}.key`] ? <p className="fieldError" role="alert">{feedback[`variants.${index}.key`]}</p> : null}
          <button type="button" className="ghost small" disabled={disabled || variants.length <= 2}
            aria-label={`Remove variant ${index + 1}`} onClick={() => {
              if (!disabled && variants.length > 2) onChange(variants.filter((_, row) => row !== index));
            }}>Remove variant</button>
        </div>
      ))}
      <p className="fieldHint" role="status">Total weight: {total}%</p>
      {Object.entries(feedback).filter(([path]) => !/^variants\.\d+\.(label|weight|key)$/.test(path)).map(([path, message]) =>
        message ? <p key={path} className="fieldError" role="alert">{message}</p> : null)}
      <button type="button" className="secondary small" disabled={disabled || variants.length >= 4} onClick={add}>Add variant</button>
    </div>
  );
}
