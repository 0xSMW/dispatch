import type React from "react";

const listKey = Symbol.for("dispatch.list");

export function listPlaceholder(key: string, fields: string[]) {
  const item = Object.fromEntries(fields.map((field) => [field, `{{{${field}}}}`]));
  return Object.assign([item], { [listKey]: key });
}

export function Each<T>({ items, children }: { items: T[]; children: (item: T, index: number) => React.ReactNode }) {
  const key = (items as unknown as Record<symbol, string | undefined>)[listKey];
  if (!key) return <>{items.map(children)}</>;
  return <>{`{{{#each ${key}}}}`}{children(items[0], 0)}{`{{{/each}}}`}</>;
}
