import { getCommand } from "../../lib/commands.js";
import { pickProperty } from "../../lib/pickers.js";

export const get = getCommand({
  noun: "contact property",
  arg: "Contact property ID",
  pick: pickProperty,
  call: (api, id) => api.contactProperties.get(id),
  example: "dispatch contact-properties get prop_123",
});
