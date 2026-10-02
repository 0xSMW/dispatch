import { deleteCommand } from "../../lib/commands.js";
import { pickProperty } from "../../lib/pickers.js";

export const remove = deleteCommand({
  noun: "contact property",
  arg: "Contact property ID",
  pick: pickProperty,
  call: (api, id) => api.contactProperties.remove(id),
  example: "dispatch contact-properties delete prop_123 --yes",
});
