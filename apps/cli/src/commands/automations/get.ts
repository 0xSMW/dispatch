import { getCommand } from "../../lib/commands.js";
import { pickAutomation } from "../../lib/pickers.js";

export const get = getCommand({
  noun: "automation",
  pick: pickAutomation,
  call: (api, id) => api.automations.get(id),
  example: "dispatch automations get auto_123",
});
