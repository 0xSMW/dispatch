import { deleteCommand } from "../../lib/commands.js";
import { pickContact } from "../../lib/pickers.js";

export const remove = deleteCommand({
  noun: "contact",
  arg: "Contact ID or email",
  pick: pickContact,
  call: (api, id) => api.contacts.remove(id),
  example: "dispatch contacts delete ada@example.com --yes",
});
