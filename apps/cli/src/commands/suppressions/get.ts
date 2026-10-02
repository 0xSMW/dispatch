import { getCommand } from "../../lib/commands.js";
import { pickSuppression } from "../../lib/pickers.js";

export const get = getCommand({
  noun: "suppression",
  arg: "Suppression ID or email",
  pick: pickSuppression,
  call: (api, id) => api.suppressions.get(id),
  example: "dispatch suppressions get gone@example.com",
});
