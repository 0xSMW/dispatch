import { getCommand } from "../../../lib/commands.js";
import { pick } from "../../../lib/prompts.js";

export const get = getCommand({
  noun: "import",
  pick: (id, globals) =>
    pick<{ id: string; filename?: string; status: string }>(id, {
      globals,
      noun: "import",
      list: (api) => api.contacts.imports.list({ limit: 100 }),
      label: (item) => `${item.filename ?? item.id} (${item.status})`,
    }),
  call: (api, id) => api.contacts.imports.get(id),
  example: "dispatch contacts imports get imp_123",
});
