import { deleteCommand } from "../../lib/commands.js";
import { pickSuppression } from "../../lib/pickers.js";

export const remove = deleteCommand({
  noun: "suppression",
  arg: "Suppression ID or email",
  pick: pickSuppression,
  call: (api, id) => api.suppressions.remove(id),
  example: "dispatch suppressions delete gone@example.com --yes",
});
