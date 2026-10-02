import { deleteCommand } from "../../lib/commands.js";
import { pickAutomation } from "../../lib/pickers.js";

export const remove = deleteCommand({
  noun: "automation",
  pick: pickAutomation,
  call: (api, id) => api.automations.remove(id),
  example: "dispatch automations delete auto_123 --yes",
});
