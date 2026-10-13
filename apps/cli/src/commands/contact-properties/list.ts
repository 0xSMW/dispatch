import { listCommand } from "../../lib/commands.js";

type Property = { id: string; key: string; type: string; fallback_value?: unknown };

export const list = listCommand<Property>({
  description: "List contact properties",
  output: '{"object":"list","has_more":false,"data":[{"id":"...","key":"plan","type":"string","fallback_value":"free"}]}',
  examples: ["dispatch contact-properties"],
  call: (api, page) => api.contactProperties.list(page),
  columns: ["Key", "Type", "Fallback", "ID"],
  row: (property) => [property.key, property.type, property.fallback_value ?? "", property.id],
  empty: "(no contact properties)",
});
