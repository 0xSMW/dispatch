import { getCommand } from "../../lib/commands.js";
import { pickContact } from "../../lib/pickers.js";

export const get = getCommand({
  noun: "contact",
  arg: "Contact ID or email",
  pick: pickContact,
  call: (api, id) => api.contacts.get(id),
  example: "dispatch contacts get ada@example.com",
  output: '{"object":"contact","id":"...","email":"ada@example.com","unsubscribed":false}',
});
