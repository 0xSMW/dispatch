import { useEffect, useState } from "react";
import { Check, Copy as CopyIcon } from "lucide-react";

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export interface CopyProps {
  value: string;
  /** Show the value in a monospace chip next to the icon. */
  chip?: boolean;
  /** Text shown in the chip instead of `value`, such as a masked secret. */
  display?: string;
  label?: string;
  className?: string;
}

/** Icon button that copies `value` and shows a check for a second. */
export function Copy({ value, chip = false, display, label = "Copy", className = "" }: CopyProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1000);
    return () => clearTimeout(timer);
  }, [copied]);

  const button = (
    <button
      type="button"
      className="ghost icon small copy"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={async (event) => {
        event.stopPropagation();
        if (await copyText(value)) setCopied(true);
      }}
    >
      {copied ? <Check size={14} /> : <CopyIcon size={14} />}
    </button>
  );

  if (!chip) return button;
  return (
    <span className={`chip mono ${className}`.trim()}>
      <span className="chipText">{display ?? value}</span>
      {button}
    </span>
  );
}
