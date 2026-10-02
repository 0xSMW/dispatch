import type React from "react";

const placeholder = /^\{\{\{([A-Za-z0-9_.]+)\}\}\}$/;

export function If({ value, children }: { value: unknown; children: React.ReactNode }) {
  const key = typeof value === "string" ? value.match(placeholder)?.[1] : undefined;
  if (key) return <>{`{{{#if ${key}}}}`}{children}{`{{{/if}}}`}</>;
  return value ? <>{children}</> : null;
}

// The other half of If: shown when the value is absent. Use the pair to fall back from one
// variable to another, such as the product URL when no action URL is given.
export function Unless({ value, children }: { value: unknown; children: React.ReactNode }) {
  const key = typeof value === "string" ? value.match(placeholder)?.[1] : undefined;
  if (key) return <>{`{{{#unless ${key}}}}`}{children}{`{{{/unless}}}`}</>;
  return value ? null : <>{children}</>;
}
